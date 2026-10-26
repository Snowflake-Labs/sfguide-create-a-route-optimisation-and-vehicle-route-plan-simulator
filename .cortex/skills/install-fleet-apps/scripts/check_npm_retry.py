#!/usr/bin/env python3
"""Guard: package installs during an install must survive a transient network error.

What happened (wgb26798, fresh-laptop install, 2026-10-25): one ECONNRESET
("npm error network aborted") in the SA app's fleet-kit `npm ci` failed the
deploy and aborted the install 69 minutes in. No call site retried.

Rules:
  A  every tracked install-fleet-apps *.sh that runs `npm ci` / `npm install`
     (comments stripped) sources lib/npm_retry.sh BEFORE its first such line
  B  behaviour: with a fake npm that fails twice then succeeds, `( npm ci )` in a
     subshell succeeds after 3 calls; a fake that always fails returns non-zero
     after NPM_RETRY_ATTEMPTS calls; `npm run` is never retried

Usage:  python3 .cortex/skills/install-fleet-apps/scripts/check_npm_retry.py
Exit:   0 clean, 1 violation
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tempfile

REPO = pathlib.Path.cwd()
SKILL = ".cortex/skills/install-fleet-apps/scripts"
LIB = REPO / SKILL / "lib" / "npm_retry.sh"
SRC = re.compile(r"^\s*source\s+.*lib/npm_retry\.sh")
NPM = re.compile(r"\bnpm\s+(ci|install)\b")
failures: list[str] = []

files = [str(p.relative_to(REPO)) for p in (REPO / SKILL).rglob("*.sh")
         if "node_modules" not in p.parts]
for rel in sorted(files):
    if rel.endswith("lib/npm_retry.sh"):
        continue
    p = REPO / rel
    if not p.is_file():
        continue
    src_line = npm_line = None
    for n, line in enumerate(p.read_text().splitlines(), 1):
        code = line.split("#", 1)[0] if line.lstrip().startswith("#") else line
        code = re.sub(r'echo\s+"[^"]*"', "", code)
        if src_line is None and SRC.search(code):
            src_line = n
        if npm_line is None and NPM.search(code):
            npm_line = n
    if npm_line and (src_line is None or src_line > npm_line):
        failures.append(f"A {rel}:{npm_line} runs npm ci/install without sourcing lib/npm_retry.sh first")


def behave(fail_times: int, cmd: str) -> tuple[int, int]:
    with tempfile.TemporaryDirectory() as d:
        dp = pathlib.Path(d)
        fake = dp / "npm"
        fake.write_text("#!/bin/bash\nn=$(cat \"$CNT\" 2>/dev/null || echo 0); n=$((n+1)); echo $n > \"$CNT\"\n"
                        f"[ $n -gt {fail_times} ] && exit 0; exit 7\n")
        fake.chmod(0o755)
        cnt = dp / "count"
        r = subprocess.run(["bash", "-c", f'source "{LIB}"; ( {cmd} )'],
                           env={"PATH": f"{d}:/usr/bin:/bin", "CNT": str(cnt),
                                "NPM_RETRY_ATTEMPTS": "3", "NPM_RETRY_DELAY": "0"},
                           capture_output=True, text=True, timeout=60)
        calls = int(cnt.read_text()) if cnt.exists() else 0
        return r.returncode, calls


if not LIB.is_file():
    failures.append(f"B {SKILL}/lib/npm_retry.sh missing")
else:
    rc, calls = behave(2, "npm ci")
    if rc != 0 or calls != 3:
        failures.append(f"B transient failure not retried: rc={rc} calls={calls} (want 0, 3)")
    rc, calls = behave(99, "npm install")
    if rc == 0 or calls != 3:
        failures.append(f"B permanent failure: rc={rc} calls={calls} (want non-zero, 3)")
    rc, calls = behave(99, "npm run build")
    if calls != 1:
        failures.append(f"B `npm run` was retried ({calls} calls)")

if failures:
    print(f"npm retry: {len(failures)} violation(s)")
    for f in failures:
        print("  " + f)
    sys.exit(1)
print("npm retry: OK")
