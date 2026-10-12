#!/usr/bin/env python3
"""Run every registered quality gate (gates.yaml) - the one entry point for CI,
the optional pre-commit hook, and the fresh-install e2e harness.

Why one runner: the gates used to be invoked from .githooks/pre-commit only, so
what ran depended on whether a developer had opted in and on which paths were
staged. Every caller now runs the same registry, unconditionally.

Order and isolation
  1. checks run in parallel (read-only by contract)
  2. negative tests run ONE AT A TIME afterwards: several mutate a checkout file
     in place and restore it, which would race any check reading that file
  3. after every negative test the tracked tree must be exactly as it was - a
     driver that dies half-way and leaves a mutation behind fails loudly here
     instead of silently poisoning the next commit

Usage
  python3 run_gates.py                         all static gates + negatives
  python3 run_gates.py --scope live -c <conn>  live gates against an account
  python3 run_gates.py --only no_brands,tracking_tags
  python3 run_gates.py --checks-only           skip negative tests (hook speed)
  python3 run_gates.py --json report.json      machine-readable result
Exit: 0 all passed, 1 any failure, 2 usage error
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import pathlib
import shlex
import subprocess
import sys
import time

import yaml

REPO = pathlib.Path(os.environ.get("GATES_REPO")
                    or pathlib.Path(__file__).resolve().parents[4])
REGISTRY = pathlib.Path(os.environ.get("GATES_REGISTRY")
                        or pathlib.Path(__file__).resolve().parent / "gates.yaml")
TIMEOUT_S = int(os.environ.get("GATE_TIMEOUT_S", "900"))


def tree_state() -> str:
    """Tracked-file state: porcelain status plus the content diff of tracked files."""
    st = subprocess.run(["git", "-C", str(REPO), "status", "--porcelain",
                         "--untracked-files=no"], capture_output=True, text=True).stdout
    diff = subprocess.run(["git", "-C", str(REPO), "diff", "HEAD"],
                          capture_output=True, text=True).stdout
    return st + "\0" + diff


def prepare(needs: list[str]) -> str | None:
    for n in needs:
        kind, _, arg = n.partition(":")
        if kind == "npm-ci":
            d = REPO / arg
            if not (d / "node_modules").is_dir():
                p = subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=d,
                                   capture_output=True, text=True)
                if p.returncode != 0:
                    return f"needs {n}: npm ci failed\n{p.stdout[-1500:]}{p.stderr[-1500:]}"
        else:
            return f"unknown needs entry {n!r}"
    return None


def run_cmd(cmd: str) -> tuple[int, str, float]:
    t0 = time.monotonic()
    try:
        p = subprocess.run(shlex.split(cmd), cwd=REPO, capture_output=True,
                           text=True, timeout=TIMEOUT_S)
        rc, out = p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired as e:
        rc, out = 124, f"TIMEOUT after {TIMEOUT_S}s\n{(e.stdout or '')}"
    except FileNotFoundError as e:
        rc, out = 127, str(e)
    return rc, out, time.monotonic() - t0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", choices=("static", "live"), default="static")
    ap.add_argument("-c", "--connection")
    ap.add_argument("--only", help="comma-separated gate ids")
    ap.add_argument("--checks-only", action="store_true")
    ap.add_argument("--jobs", type=int, default=min(8, os.cpu_count() or 4))
    ap.add_argument("--json")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.scope == "live" and not a.connection:
        print("run_gates: --scope live needs -c <connection>")
        return 2

    reg = yaml.safe_load(REGISTRY.read_text())
    gates = [g for g in reg["gates"] if g["scope"] == a.scope]
    if a.only:
        want = set(a.only.split(","))
        unknown = want - {g["id"] for g in reg["gates"]}
        if unknown:
            print(f"run_gates: unknown gate id(s): {sorted(unknown)}")
            return 2
        gates = [g for g in reg["gates"] if g["id"] in want]
    if a.list:
        for g in gates:
            print(f"{g['id']:32} {g['scope']:6} {'neg' if g.get('negative') else '---'}  {g['why']}")
        return 0

    def expand(cmd: str) -> str:
        return cmd.replace("{conn}", shlex.quote(a.connection or ""))

    results: list[dict] = []
    for g in gates:
        err = prepare(g.get("needs") or [])
        if err:
            results.append({"id": g["id"], "phase": "setup", "rc": 1, "s": 0.0, "out": err})
    gates = [g for g in gates if not any(r["id"] == g["id"] for r in results)]

    t_all = time.monotonic()
    with cf.ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        futs = {ex.submit(run_cmd, expand(g["run"])): g for g in gates}
        for f in cf.as_completed(futs):
            rc, out, s = f.result()
            results.append({"id": futs[f]["id"], "phase": "check", "rc": rc, "s": s, "out": out})

    if not a.checks_only:
        for g in gates:
            neg = g.get("negative")
            if not neg or neg == "self":
                continue
            before = tree_state()
            rc, out, s = run_cmd(expand(neg))
            if tree_state() != before:
                rc = 1
                out += ("\nrun_gates: this negative test LEFT THE CHECKOUT MODIFIED - "
                        "it must mutate a temp copy or restore every file it touches. "
                        "Inspect `git status` / `git diff` before committing.")
            results.append({"id": g["id"], "phase": "negative", "rc": rc, "s": s, "out": out})

    order = {g["id"]: i for i, g in enumerate(reg["gates"])}
    results.sort(key=lambda r: (order.get(r["id"], 0), r["phase"] != "check"))
    failed = [r for r in results if r["rc"] != 0]
    for r in results:
        print(f"  {'PASS' if r['rc'] == 0 else 'FAIL'}  {r['id']:32} {r['phase']:8} {r['s']:6.1f}s")
    for r in failed:
        print(f"\n---- FAIL {r['id']} ({r['phase']}, rc={r['rc']}) ----")
        print("\n".join(r["out"].rstrip().splitlines()[-40:]))
    total = time.monotonic() - t_all
    print(f"\nrun_gates: {len(results) - len(failed)}/{len(results)} passed "
          f"(scope {a.scope}, {total:.0f}s wall)" + (f" - {len(failed)} FAILED" if failed else ""))
    if a.json:
        pathlib.Path(a.json).write_text(json.dumps(
            {"scope": a.scope, "wall_s": round(total, 1),
             "results": [{k: v for k, v in r.items() if k != "out"} | {"tail": r["out"][-4000:]}
                         for r in results]}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
