#!/usr/bin/env python3
"""Negative tests for run_sql_must_be_empty.py, the runner behind the live SQL
invariant gates (stream_invariants: every query empty; labor_layer: no FAIL row).

Offline: the runner talks to fake_snow.py replaying cassettes recorded from a
healthy install; each case alters one response. Both modes must refuse to read
"nothing came back" as "clean".
"""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
STATUS = [{"status": "Statement executed successfully."}]

# ── strict-empty mode: check_stream_invariants.sql ──────────────────────────
h = Harness("run_sql_must_be_empty.py",
            args=["-c", "replayed", f"{S}/check_stream_invariants.sql"],
            cassette=f"{S}/live_cassettes/stream_invariants.json")
OVERLAP = [STATUS, [{"REGION": "UsTexas", "OVERLAPPING_PAIRS": 42, "VEHICLES": 24}], []]
h.account("overlapping trips (the concurrent-stream defect)",
          [{"match": "sha256:", "stdout": json.dumps(OVERLAP)}],
          expect="query 1 returned 1 row(s)")
h.account("SQL does not run (compile error is not 'zero rows')",
          [{"match": "sha256:", "rc": 1, "stdout": "",
            "stderr": "000904 (42000): SQL compilation error: invalid identifier 'TS'"}],
          expect="the SQL did not run")
h.account("only the session tag ran: nothing was checked",
          [{"match": "sha256:", "stdout": json.dumps([STATUS])}],
          expect="the file checked nothing")
h.account("unparseable snow output",
          [{"match": "sha256:", "stdout": "+------+\n| text |\n"}],
          expect="unparseable output")
rc1 = h.finish()
sys.exit(rc1)
