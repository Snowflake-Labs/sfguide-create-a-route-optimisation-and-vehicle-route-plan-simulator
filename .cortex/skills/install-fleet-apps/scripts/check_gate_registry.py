#!/usr/bin/env python3
"""Guard: every quality gate is registered in gates.yaml, and the negative-test
debt only shrinks.

Why this exists
---------------
Gates were wired by hand into .githooks/pre-commit, an opt-in hook. Measured on
2026-10-12: of 45 check scripts only 17 had a negative test, 12 of those negative
tests were run by nothing, 6 checks were run by nothing (one of them,
check_concurrent_streams.py, carried the brand string that kept check_no_brands
red for three weeks), and run_evals.py failed on every fresh clone unseen. A gate
nobody runs, or one that has never been shown to fail, protects nothing.

Rules
-----
  R1  every tracked `check_*`, `verify_*` / `verify-*` and `mutate_*` script
      (.py/.sh/.sql/.mts) and every `*_negative.*` / `*_mutations.*` driver is
      referenced by exactly one gate. (`check_*` alone was too narrow: 13
      verify_/mutate_ scripts ran nowhere, including a mutation driver that
      reported 5/5 "convicted" while the suite it drives could not import.)
  R2  every script path a gate references exists
  R3  ids are unique; scope is `static` or `live`
  R4  a gate's `negative` is null  <=>  its id is in debt.missing_negative;
      `self` only for a gate whose `run` is itself a negative driver
  R5  ratchet: no id may appear in debt.missing_negative that is not in the
      base revision's list. Base = $GATES_BASE_REF (CI sets the PR base), else
      HEAD. A gate cannot lose its negative test, and a new gate cannot be
      added without one.
  R6  a `negative` command never takes `{conn}`. run_gates.py runs live gates'
      negatives in static scope (CI), which has no account, so a negative must
      replay a recorded one (negtest cassettes) rather than call Snowflake.

Usage:  python3 check_gate_registry.py        (repo: $GATE_REGISTRY_REPO or this checkout)
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import os
import pathlib
import re
import shlex
import subprocess
import sys

import yaml

REPO = pathlib.Path(os.environ.get("GATE_REGISTRY_REPO")
                    or pathlib.Path(__file__).resolve().parents[4])
REL = ".cortex/skills/install-fleet-apps/scripts/gates.yaml"
GATE_FILE = re.compile(r"(^|/)(check|verify|mutate)[_-][^/]+\.(py|sh|sql|mts)$"
                       r"|_(negative|mutations)\.(py|sh)$")
NEG_FILE = re.compile(r"_(negative|mutations)\.(py|sh)$|(^|/)mutate_[^/]+\.py$")
SCRIPT = re.compile(r"\.(py|sh|sql|mts)$")

failures: list[str] = []


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True)


def paths_in(cmd: str | None, base: str = "") -> list[str]:
    """Script paths in a command, repo-relative (resolved against `base`, a
    gate's cwd, for its `run` command)."""
    if not cmd or cmd == "self":
        return []
    out = []
    for t in shlex.split(cmd):
        if SCRIPT.search(t) and ("/" in t or base):
            out.append(os.path.normpath(os.path.join(base, t)) if base else t)
    return out


def load(text: str) -> dict:
    data = yaml.safe_load(text) or {}
    data.setdefault("gates", [])
    data.setdefault("debt", {})
    data["debt"].setdefault("missing_negative", [])
    return data


def main() -> int:
    reg_path = REPO / REL
    if not reg_path.exists():
        print(f"check_gate_registry: FAILED - {REL} not found")
        return 1
    reg = load(reg_path.read_text())
    gates = reg["gates"]
    debt = list(reg["debt"]["missing_negative"] or [])

    # R3
    ids = [g.get("id") for g in gates]
    for i in sorted({i for i in ids if ids.count(i) > 1}):
        failures.append(f"R3 duplicate id '{i}'")
    for g in gates:
        if g.get("scope") not in ("static", "live"):
            failures.append(f"R3 gate '{g.get('id')}' has scope {g.get('scope')!r} "
                            "(must be static or live)")
        if not g.get("run"):
            failures.append(f"R3 gate '{g.get('id')}' has no run command")

    # R2 + reference map for R1
    referenced: dict[str, list[str]] = {}
    for g in gates:
        for field in ("run", "negative"):
            base = (g.get("cwd") or "") if field == "run" else ""
            for p in paths_in(g.get(field), base):
                referenced.setdefault(p, []).append(f"{g.get('id')}.{field}")
                if not (REPO / p).is_file():
                    failures.append(f"R2 gate '{g.get('id')}' {field} references "
                                    f"missing file {p}")

    # R1 - committed + new-but-unignored, so a gate script is flagged as soon
    # as it exists, not only after it is staged.
    tracked = git("ls-files", "--cached", "--others", "--exclude-standard").stdout.splitlines()
    tracked = [t for t in tracked if (REPO / t).is_file()]
    for p in sorted(t for t in tracked if GATE_FILE.search(t)):
        refs = referenced.get(p, [])
        if not refs:
            failures.append(f"R1 {p} is not referenced by any gate in {REL} - "
                            "register it, or it runs nowhere")
        elif len(refs) > 1:
            failures.append(f"R1 {p} is referenced by more than one gate: {refs}")

    # R4
    for g in gates:
        gid, neg = g.get("id"), g.get("negative")
        if neg is None and gid not in debt:
            failures.append(f"R4 gate '{gid}' has no negative test and is not in "
                            "debt.missing_negative - write one (preferred) or list it")
        if neg is not None and gid in debt:
            failures.append(f"R4 gate '{gid}' has a negative test but is still in "
                            "debt.missing_negative - remove it from the debt list")
        if neg == "self" and not any(NEG_FILE.search(p) for p in paths_in(
                g.get("run"), g.get("cwd") or "")):
            failures.append(f"R4 gate '{gid}' uses negative: self but its run is "
                            "not a negative driver")
    for d in debt:
        if d not in ids:
            failures.append(f"R4 debt.missing_negative names unknown gate '{d}'")

    # R6
    for g in gates:
        if "{conn}" in (g.get("negative") or ""):
            failures.append(f"R6 gate '{g.get('id')}' negative takes {{conn}} - static scope "
                            "(CI) runs every negative without an account; replay a "
                            "recorded one (negtest cassette) instead")

    # R5
    base_ref = os.environ.get("GATES_BASE_REF") or "HEAD"
    base = git("show", f"{base_ref}:{REL}")
    if base.returncode == 0:
        base_debt = set(load(base.stdout)["debt"]["missing_negative"] or [])
        for d in sorted(set(debt) - base_debt):
            failures.append(f"R5 '{d}' was added to debt.missing_negative (not in "
                            f"{base_ref}) - the debt may only shrink; give the gate "
                            "a negative test instead")
        base_note = f"ratchet vs {base_ref}: {len(base_debt)} -> {len(debt)}"
    else:
        base_note = f"ratchet: no registry at {base_ref} yet (first introduction)"

    if failures:
        print("check_gate_registry: FAILED")
        for f in failures:
            print(f"  {f}")
        return 1
    n_static = sum(g.get("scope") == "static" for g in gates)
    print(f"check_gate_registry: OK - {len(gates)} gates ({n_static} static, "
          f"{len(gates) - n_static} live), {len(gates) - len(debt)} with a negative "
          f"test, {len(debt)} in debt; {base_note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
