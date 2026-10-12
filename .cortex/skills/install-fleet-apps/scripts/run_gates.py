#!/usr/bin/env python3
"""Run every registered quality gate (gates.yaml) - the one entry point for CI,
the optional pre-commit hook, and the fresh-install e2e harness.

Why one runner: the gates used to be invoked from .githooks/pre-commit only, so
what ran depended on whether a developer had opted in and on which paths were
staged. Every caller now runs the same registry, unconditionally.

Order and isolation
  1. checks run in parallel against the working tree (read-only by contract)
  2. negative tests run ONE AT A TIME inside a SANDBOX - a disposable git copy
     of the working tree (node_modules symlinked in), reset between tests - so
     no negative test can modify the real checkout. This is not hypothetical:
     an in-place driver restoring from a shared /tmp backup once wrote one
     file's content over five others (check_number_formatting.py's source
     landed in data-table.tsx) while another process ran alongside it.
  3. the real checkout is still compared before/after every negative test, as
     a backstop for a driver that writes through an absolute path
  4. a lock in .git/ refuses a second concurrent run in the same checkout

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
import fcntl
import hashlib
import json
import os
import pathlib
import shlex
import shutil
import subprocess
import sys
import tempfile
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


def prepare(needs: list[str]) -> tuple[str | None, str | None]:
    """Run each `needs` entry. Returns (error, python) where python is a venv
    interpreter when the gate declared `pip:` packages, else None."""
    python = None
    for n in needs:
        kind, _, arg = n.partition(":")
        if kind == "npm-ci":
            d = REPO / arg
            if not (d / "node_modules").is_dir():
                p = subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=d,
                                   capture_output=True, text=True)
                if p.returncode != 0:
                    return f"needs {n}: npm ci failed\n{p.stdout[-1500:]}{p.stderr[-1500:]}", None
        elif kind == "pip":
            # A gate that imports third-party modules must not depend on what the
            # machine happens to have installed: the gateway suites failed with
            # ModuleNotFoundError on a dev machine, and their mutation driver then
            # reported every mutation "convicted" by that import error.
            pkgs = sorted(p for p in arg.split(",") if p)
            key = hashlib.sha1(" ".join(pkgs).encode()).hexdigest()[:12]
            venv = pathlib.Path(os.environ.get("GATES_VENV_DIR")
                                or pathlib.Path.home() / ".cache" / "fleet-gates") / f"venv-{key}"
            python = str(venv / "bin" / "python")
            if not pathlib.Path(python).exists():
                for step in ([sys.executable, "-m", "venv", str(venv)],
                             [python, "-m", "pip", "install", "-q", *pkgs]):
                    p = subprocess.run(step, capture_output=True, text=True)
                    if p.returncode != 0:
                        shutil.rmtree(venv, ignore_errors=True)
                        return f"needs {n}: {' '.join(step[:3])} failed\n{p.stderr[-1500:]}", None
        else:
            return f"unknown needs entry {n!r}", None
    return None, python


def run_cmd(cmd: str, cwd: pathlib.Path = REPO) -> tuple[int, str, float]:
    t0 = time.monotonic()
    try:
        p = subprocess.run(shlex.split(cmd), cwd=cwd, capture_output=True,
                           text=True, timeout=TIMEOUT_S)
        rc, out = p.returncode, p.stdout + p.stderr
    except subprocess.TimeoutExpired as e:
        rc, out = 124, f"TIMEOUT after {TIMEOUT_S}s\n{(e.stdout or '')}"
    except FileNotFoundError as e:
        rc, out = 127, str(e)
    return rc, out, time.monotonic() - t0


def sb_git(sb: pathlib.Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(sb), "-c", "user.email=gates@local", "-c",
                    "user.name=run_gates", "-c", "core.hooksPath=/dev/null", *args],
                   check=True, capture_output=True)


def make_sandbox() -> pathlib.Path:
    """A git copy of the working tree (committed + new files, as on disk), with the
    real node_modules symlinked so JS-based drivers run. Never the real repo."""
    sb = pathlib.Path(tempfile.mkdtemp(prefix="run_gates_sandbox_")) / "repo"
    files = subprocess.run(["git", "-C", str(REPO), "ls-files", "-z", "--cached",
                            "--others", "--exclude-standard"],
                           capture_output=True, text=True, check=True).stdout
    for rel in filter(None, files.split("\0")):
        src = REPO / rel
        if src.is_file():
            dst = sb / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    sb_git(sb, "init", "-q")
    sb_git(sb, "add", "-A")
    sb_git(sb, "commit", "-qm", "sandbox baseline")
    # Pruned walk: never descend into a node_modules (or .git) tree.
    for root, dirs, _files in os.walk(REPO):
        if ".git" in dirs:
            dirs.remove(".git")
        if "node_modules" in dirs:
            dirs.remove("node_modules")
            nm = pathlib.Path(root) / "node_modules"
            link = sb / nm.relative_to(REPO)
            if link.parent.is_dir() and not link.exists():
                link.symlink_to(nm)
    return sb


def reset_sandbox(sb: pathlib.Path) -> None:
    sb_git(sb, "checkout", "-q", "--", ".")
    sb_git(sb, "clean", "-fdq", "-e", "node_modules")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scope", choices=("static", "live"), default="static")
    ap.add_argument("-c", "--connection")
    ap.add_argument("--only", help="comma-separated gate ids")
    ap.add_argument("--skip", help="comma-separated gate ids to leave out; reported as "
                    "NOT_RUN in --json so a skipped gate can never read as a pass")
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
    skipped: list[str] = []
    if a.skip:
        drop = set(a.skip.split(","))
        unknown = drop - {g["id"] for g in reg["gates"]}
        if unknown:
            print(f"run_gates: unknown gate id(s) in --skip: {sorted(unknown)}")
            return 2
        skipped = [g["id"] for g in gates if g["id"] in drop]
        gates = [g for g in gates if g["id"] not in drop]
    if a.list:
        for g in gates:
            print(f"{g['id']:32} {g['scope']:6} {'neg' if g.get('negative') else '---'}  {g['why']}")
        return 0

    def expand(cmd: str) -> str:
        return cmd.replace("{conn}", shlex.quote(a.connection or ""))

    lock_path = REPO / ".git" / "run_gates.lock"
    lock = open(lock_path, "w") if lock_path.parent.is_dir() else None
    if lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("run_gates: another run_gates.py is already running in this checkout "
                  "- refusing to overlap (negative tests are serial by design)")
            return 2

    results: list[dict] = []
    pythons: dict[str, str] = {}
    for g in gates:
        err, python = prepare(g.get("needs") or [])
        if err:
            results.append({"id": g["id"], "phase": "setup", "rc": 1, "s": 0.0, "out": err})
        elif python:
            pythons[g["id"]] = python
    gates = [g for g in gates if not any(r["id"] == g["id"] for r in results)]

    def command(g: dict, field: str) -> str:
        cmd = expand(g[field])
        # A gate with pip needs runs under its venv interpreter (the negative
        # test too, so the harness's sys.executable is the venv as well).
        if g["id"] in pythons and cmd.split(" ", 1)[0] == "python3":
            cmd = shlex.quote(pythons[g["id"]]) + cmd[len("python3"):]
        return cmd

    def where(g: dict, root: pathlib.Path) -> pathlib.Path:
        return root / g["cwd"] if g.get("cwd") else root

    t_all = time.monotonic()
    with cf.ThreadPoolExecutor(max_workers=max(1, a.jobs)) as ex:
        futs = {ex.submit(run_cmd, command(g, "run"), where(g, REPO)): g for g in gates}
        for f in cf.as_completed(futs):
            rc, out, s = f.result()
            results.append({"id": futs[f]["id"], "phase": "check", "rc": rc, "s": s, "out": out})

    negs = [g for g in gates if g.get("negative") not in (None, "self")]
    if negs and not a.checks_only:
        sb = make_sandbox()
        try:
            for g in negs:
                before = tree_state()
                # Negative commands are always repo-relative (a gate's `cwd`
                # applies to its `run` only), so they start at the sandbox root.
                rc, out, s = run_cmd(command(g, "negative"), cwd=sb)
                if tree_state() != before:
                    rc = 1
                    out += ("\nrun_gates: this negative test MODIFIED THE REAL CHECKOUT "
                            "(it runs in a sandbox, so it wrote through an absolute "
                            "path). Inspect `git status` / `git diff` now.")
                reset_sandbox(sb)
                results.append({"id": g["id"], "phase": "negative", "rc": rc, "s": s,
                                "out": out})
        finally:
            shutil.rmtree(sb.parent, ignore_errors=True)

    order = {g["id"]: i for i, g in enumerate(reg["gates"])}
    results.sort(key=lambda r: (order.get(r["id"], 0), r["phase"] != "check"))
    failed = [r for r in results if r["rc"] != 0]
    for r in results:
        print(f"  {'PASS' if r['rc'] == 0 else 'FAIL'}  {r['id']:32} {r['phase']:8} {r['s']:6.1f}s")
    for gid in skipped:
        print(f"  SKIP  {gid:32} NOT_RUN  (--skip)")
    for r in failed:
        print(f"\n---- FAIL {r['id']} ({r['phase']}, rc={r['rc']}) ----")
        print("\n".join(r["out"].rstrip().splitlines()[-40:]))
    total = time.monotonic() - t_all
    print(f"\nrun_gates: {len(results) - len(failed)}/{len(results)} passed "
          f"(scope {a.scope}, {total:.0f}s wall)" + (f" - {len(failed)} FAILED" if failed else "")
          + (f", {len(skipped)} NOT_RUN" if skipped else ""))
    if a.json:
        pathlib.Path(a.json).write_text(json.dumps(
            {"scope": a.scope, "wall_s": round(total, 1), "not_run": skipped,
             "results": [{k: v for k, v in r.items() if k != "out"} | {"tail": r["out"][-4000:]}
                         for r in results]}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
