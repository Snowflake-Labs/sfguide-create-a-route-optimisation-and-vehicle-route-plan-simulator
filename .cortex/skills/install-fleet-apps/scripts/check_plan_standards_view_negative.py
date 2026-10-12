#!/usr/bin/env python3
"""Negative tests for the live gate check_plan_standards_view.py, replayed
offline from live_cassettes/plan_standards_view.json (recorded on a healthy
install). Each case alters one response; the gate must fail with the right
cause. An unrecorded query fails loudly: when the view's queries in
app-views.json change, re-record with record_live_cassettes.sh."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
ERR = {"rc": 1, "stdout": "", "stderr": "000904 (42000): SQL compilation error: invalid identifier"}

h = Harness("check_plan_standards_view.py", args=["replayed", "SanFrancisco"],
            cassette=f"{S}/live_cassettes/plan_standards_view.json")
h.account("a KPI query no longer compiles",
          [{"match": "SELECT COUNT(*) AS routes,", **ERR}], expect="FAIL kpi")
h.account("the planners panel renders empty",
          [{"match": "SELECT r.PLANNER_LABEL AS planner", "stdout": "[]"}],
          expect="FAIL planners")
h.account("no route can be seeded (the selection pass never runs)",
          [{"match": "ORDER BY r.KM_PER_STOP DESC LIMIT 1", "stdout": "[]"}],
          expect="could not seed a selection")
h.account("the readiness panel errors",
          [{"match": "VW_WAREHOUSE_READINESS", **ERR}], expect="FAIL readiness")
sys.exit(h.finish())
