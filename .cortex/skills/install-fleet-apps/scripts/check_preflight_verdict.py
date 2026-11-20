#!/usr/bin/env python3
"""Gate: preflight's verdict is not degraded by states a first install expects.

Defect it pins (TIB fresh-laptop cycle 2, 2026-11-07): on a clean account
preflight exited 2 "some features will be degraded" for nothing but expected
first-install states - OPENROUTESERVICE_APP absent (this run builds it) and the
helper packages "not installed yet" (step 0 installs them), which also SKIPPED
the Overture listing probe preflight exists to answer.

RULE A - info() prints but sets neither DEGRADED nor BLOCKING.
RULE B - every message that calls a state expected on a first install is info().
RULE C - failing to provide the python packages is fail(), never a soft warn
         that silently skips the probes behind it.
"""
from __future__ import annotations

import pathlib
import re
import sys

PREFLIGHT = pathlib.Path(__file__).resolve().parent / "preflight_new_account.sh"
EXPECTED = re.compile(r"expected on a first install|built by this run|not installed yet", re.I)
CALL = re.compile(r"^\s*(?:\S.*?;\s*)?(pass|info|warn|fail)\s+\"(.*)\"\s*$")


def main(path: pathlib.Path = PREFLIGHT) -> int:
    src = path.read_text()
    errs = []
    m = re.search(r"^info\(\)\s*\{(.*?)\}", src, re.M | re.S)
    if not m:
        errs.append("RULE A info() is not defined")
    elif re.search(r"DEGRADED|BLOCKING", m.group(1)):
        errs.append("RULE A info() changes the verdict (sets DEGRADED/BLOCKING)")
    for n, ln in enumerate(src.splitlines(), 1):
        if ln.lstrip().startswith("#"):
            continue
        c = CALL.match(ln)
        if c and EXPECTED.search(c.group(2)) and c.group(1) != "info":
            errs.append(f"RULE B line {n}: expected first-install state reported as {c.group(1)}(): {c.group(2)[:80]}")
    py = re.search(r"if ensure_python_env\b[^\n]*\n(.*?)\nfi", src, re.S)
    if not py:
        errs.append("RULE C ensure_python_env call not found")
    elif not re.search(r"^\s*fail\s+\"\$PYTHON_ENV_ERROR\"", py.group(1), re.M):
        errs.append("RULE C python packages unavailable is not fail()")
    for e in errs:
        print("FAIL", e)
    if errs:
        return 1
    print("preflight_verdict: OK (info neutral, first-install states are info, python failure blocks)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
