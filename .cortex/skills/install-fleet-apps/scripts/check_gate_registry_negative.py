#!/usr/bin/env python3
"""Negative tests for check_gate_registry.py.

Each case builds a throwaway git repo holding a minimal gates.yaml plus the gate
scripts it names, commits a clean baseline, applies ONE defect, and asserts the
registry check fails with the rule that defect breaks. The clean baseline must
pass first - a driver whose baseline is already red convicts nothing.

  R1  an unregistered check_*.py           R1  a negative driver nobody runs
  R2  a gate naming a missing script       R3  a duplicate id / a bad scope
  R4  negative: null but not in debt       R4  in debt although it has a negative
  R5  a gate added to the debt list (the ratchet), against the committed base
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tempfile

GATE = pathlib.Path(__file__).resolve().parent / "check_gate_registry.py"
SCRIPTS = ".cortex/skills/install-fleet-apps/scripts"

BASE_YAML = f"""version: 1
gates:
  - id: alpha
    run: python3 {SCRIPTS}/check_alpha.py
    negative: python3 {SCRIPTS}/check_alpha_negative.py
    scope: static
    why: x
  - id: beta
    run: python3 {SCRIPTS}/check_beta.py
    negative: null
    scope: static
    why: x
debt:
  missing_negative:
    - beta
"""

failures: list[str] = []


def sh(repo: pathlib.Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def gate(repo: pathlib.Path) -> tuple[int, str]:
    env = dict(os.environ, GATE_REGISTRY_REPO=str(repo))
    env.pop("GATES_BASE_REF", None)
    p = subprocess.run([sys.executable, str(GATE)], capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr


def fresh(tmp: pathlib.Path, name: str) -> pathlib.Path:
    repo = tmp / name
    s = repo / SCRIPTS
    s.mkdir(parents=True)
    for f in ("check_alpha.py", "check_alpha_negative.py", "check_beta.py"):
        (s / f).write_text("print('ok')\n")
    (s / "gates.yaml").write_text(BASE_YAML)
    sh(repo, "init", "-q")
    sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
    sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base")
    return repo


def case(tmp: pathlib.Path, name: str, rule: str, mutate) -> None:
    repo = fresh(tmp, name)
    rc, out = gate(repo)
    if rc != 0:
        failures.append(f"{name}: clean baseline already fails:\n{out}")
        print(f"  FAIL {name} (baseline red)")
        return
    mutate(repo, repo / SCRIPTS)
    sh(repo, "add", "-A")  # R1 reads tracked files; stage, do not commit (R5 base = HEAD)
    rc, out = gate(repo)
    ok = rc == 1 and f"{rule} " in out
    print(f"  {'ok  ' if ok else 'FAIL'} {name} -> {rule}")
    if not ok:
        failures.append(f"{name}: expected {rule}, got rc={rc}:\n{out}")


def edit(s: pathlib.Path, old: str, new: str) -> None:
    p = s / "gates.yaml"
    text = p.read_text()
    if old not in text:  # an anchor that drifted would make the case vacuous
        raise SystemExit(f"mutation anchor not found: {old!r}")
    p.write_text(text.replace(old, new, 1))


with tempfile.TemporaryDirectory() as t:
    tmp = pathlib.Path(t)
    case(tmp, "unregistered check", "R1",
         lambda r, s: (s / "check_gamma.py").write_text("print('ok')\n"))
    case(tmp, "orphan negative driver", "R1",
         lambda r, s: (s / "check_beta_negative.py").write_text("print('ok')\n"))
    case(tmp, "missing script", "R2",
         lambda r, s: (s / "check_beta.py").unlink())
    case(tmp, "duplicate id", "R3",
         lambda r, s: edit(s, "  - id: beta", "  - id: alpha"))
    case(tmp, "bad scope", "R3",
         lambda r, s: edit(s, "scope: static\n    why: x\n  - id: beta",
                           "scope: nightly\n    why: x\n  - id: beta"))
    case(tmp, "no negative, not in debt", "R4",
         lambda r, s: edit(s, "  missing_negative:\n    - beta\n", "  missing_negative: []\n"))
    case(tmp, "in debt despite a negative", "R4",
         lambda r, s: edit(s, "    - beta\n", "    - beta\n    - alpha\n"))
    case(tmp, "debt grows (ratchet)", "R5",
         lambda r, s: edit(s, f"    negative: python3 {SCRIPTS}/check_alpha_negative.py\n",
                           "    negative: null\n")
         or edit(s, "    - beta\n", "    - beta\n    - alpha\n")
         or (s / "check_alpha_negative.py").unlink())

if failures:
    print(f"FAIL: {len(failures)} registry defect(s) not convicted")
    for f in failures:
        print("----\n" + f)
    sys.exit(1)
print("OK: 8 registry defects all convicted with the right rule")
