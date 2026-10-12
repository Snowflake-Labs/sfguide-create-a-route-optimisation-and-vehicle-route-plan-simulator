#!/usr/bin/env python3
"""Negative tests for run_gates.py - the runner must not turn a failure green.

A runner is the one component every gate trusts, so each way it could swallow a
failure is re-created here against a throwaway git repo and asserted to exit 1:

  1. a failing check                         -> FAIL
  2. a failing negative test                 -> FAIL
  3. a negative test that LEAVES a tracked   -> FAIL (tree-integrity guard)
     file modified, even though it exits 0
  4. a check that hangs past GATE_TIMEOUT_S  -> FAIL (timeout, not a pass)
  5. a gate whose script does not exist      -> FAIL (not silently skipped)
and the all-green baseline must exit 0, or the cases above prove nothing.
"""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tempfile

RUNNER = pathlib.Path(__file__).resolve().parent / "run_gates.py"

failures: list[str] = []

SCRIPTS = {
    "ok.py": "import sys; sys.exit(0)\n",
    "bad.py": "import sys; print('defect found'); sys.exit(1)\n",
    "hang.py": "import time; time.sleep(30)\n",
    "dirty.py": "import pathlib; pathlib.Path('tracked.txt').write_text('mutated\\n')\n",
}


def registry(*gates: tuple[str, str, str | None]) -> str:
    out = ["version: 1", "gates:"]
    for gid, run, neg in gates:
        out += [f"  - id: {gid}", f"    run: {run}",
                f"    negative: {neg if neg else 'null'}", "    scope: static", "    why: x"]
    return "\n".join(out) + "\n"


def run(repo: pathlib.Path, reg: str, **env: str) -> tuple[int, str]:
    (repo / "gates.yaml").write_text(reg)
    e = dict(os.environ, GATES_REPO=str(repo), GATES_REGISTRY=str(repo / "gates.yaml"), **env)
    p = subprocess.run([sys.executable, str(RUNNER)], capture_output=True, text=True, env=e)
    subprocess.run(["git", "-C", str(repo), "checkout", "-q", "--", "tracked.txt"])
    return p.returncode, p.stdout + p.stderr


def expect(name: str, want: int, got: tuple[int, str], needle: str = "") -> None:
    rc, out = got
    ok = rc == want and needle in out
    print(f"  {'ok  ' if ok else 'FAIL'} {name} (rc={rc}, want {want})")
    if not ok:
        failures.append(f"{name}:\n{out[-1500:]}")


with tempfile.TemporaryDirectory() as t:
    repo = pathlib.Path(t)
    for name, body in SCRIPTS.items():
        (repo / name).write_text(body)
    (repo / "tracked.txt").write_text("clean\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "-qm", "base"], check=True)
    py = sys.executable

    expect("all-green baseline", 0, run(repo, registry(("a", f"{py} ok.py", f"{py} ok.py"))))
    expect("failing check", 1, run(repo, registry(("a", f"{py} bad.py", f"{py} ok.py"))),
           "FAIL a")
    expect("failing negative test", 1, run(repo, registry(("a", f"{py} ok.py", f"{py} bad.py"))),
           "FAIL a")
    expect("negative test leaves the tree modified", 1,
           run(repo, registry(("a", f"{py} ok.py", f"{py} dirty.py"))), "LEFT THE CHECKOUT MODIFIED")
    expect("hung check times out", 1,
           run(repo, registry(("a", f"{py} hang.py", None)), GATE_TIMEOUT_S="2"), "TIMEOUT")
    expect("missing script", 1, run(repo, registry(("a", f"{py} no_such_gate.py", None))),
           "FAIL a")

if failures:
    print(f"FAIL: {len(failures)} runner defect(s) not convicted")
    for f in failures:
        print("----\n" + f)
    sys.exit(1)
print("OK: run_gates.py convicts all 5 ways of swallowing a failure")
