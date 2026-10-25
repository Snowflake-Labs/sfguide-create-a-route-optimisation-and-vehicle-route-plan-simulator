#!/usr/bin/env python3
"""Negative tests for check_labor_partial_week.py. M1 is the shipped defect."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

LAB = ".cortex/skills/install-fleet-apps/fleet_sa_app/app/labor_layer.sql"
FIXED = "(w.FIRST_TS::DATE > w.WEEK_START)"

h = Harness("check_labor_partial_week.py")
h.replace(LAB, FIXED, "(w.FIRST_TS > w.WEEK_START::TIMESTAMP_NTZ)",
          expect="compare at day grain", name="M1 the original timestamp compare")
h.replace(LAB, FIXED, "(w.FIRST_TS > w.WEEK_START)",
          expect="compare at day grain", name="M2 timestamp compare without the cast")
h.replace(LAB, "AS IS_PARTIAL_S,", "AS IS_PARTIAL_X,",
          expect="no `(...) AS IS_PARTIAL_S`", name="M3 flag removed")
sys.exit(h.finish())
