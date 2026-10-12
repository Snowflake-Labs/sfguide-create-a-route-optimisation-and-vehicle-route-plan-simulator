#!/usr/bin/env python3
"""Negative tests for the live gate labor_layer: run_sql_must_be_empty.py in
--status-column mode over verify_labor_layer.sql, replayed offline from
live_cassettes/labor_layer.json (recorded on a healthy install). A FAIL row, no
assertion rows at all, or SQL that does not run must each fail - "nothing came
back" is never "clean". Re-record with record_live_cassettes.sh."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
STATUS = [{"status": "Statement executed successfully."}]

h = Harness("run_sql_must_be_empty.py",
            args=["-c", "replayed", "--status-column", "STATUS", "-D", "REGION=SanFrancisco",
                  f"{S}/verify_labor_layer.sql"],
            cassette=f"{S}/live_cassettes/labor_layer.json")
h.account("a labour assertion FAILs",
          [{"match": "sha256:", "replace": [['"STATUS"  :   "PASS"', '"STATUS"  :   "FAIL"']]}],
          expect="assertion(s) FAIL")
h.account("no assertion rows at all",
          [{"match": "sha256:", "stdout": json.dumps([STATUS, []])}],
          expect="asserted nothing")
h.account("SQL does not run",
          [{"match": "sha256:", "rc": 1, "stdout": "", "stderr": "002003: does not exist"}],
          expect="the SQL did not run")
sys.exit(h.finish())
