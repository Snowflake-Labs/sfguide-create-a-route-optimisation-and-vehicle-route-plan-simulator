#!/usr/bin/env python3
"""Negative tests for check_preflight_verdict.py. M1 is the shipped defect: the
engine-absent first-install state reported as DEGRADED."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

PF = ".cortex/skills/install-fleet-apps/scripts/preflight_new_account.sh"
h = Harness("check_preflight_verdict.py")

h.replace(PF, '  info "OPENROUTESERVICE_APP absent', '  warn "OPENROUTESERVICE_APP absent',
          expect="RULE B", name="M1 the shipped bug: engine absent on a first install is DEGRADED")
h.replace(PF, "info() { printf '  INFO      %s\\n' \"$1\"; }",
          "info() { printf '  INFO      %s\\n' \"$1\"; DEGRADED=1; }",
          expect="RULE A info() changes the verdict", name="M2 info() silently degrades")
h.replace(PF, '  fail "$PYTHON_ENV_ERROR"', '  warn "$PYTHON_ENV_ERROR"',
          expect="RULE C", name="M3 missing python packages downgraded to a skip")
h.replace(PF, '  info "OPENROUTESERVICE_APP absent - expected on a first install',
          '  pass "x"; warn "OPENROUTESERVICE_APP absent - expected on a first install',
          expect="RULE B", name="M4 warn hidden after another call on the same line")

sys.exit(h.finish())
