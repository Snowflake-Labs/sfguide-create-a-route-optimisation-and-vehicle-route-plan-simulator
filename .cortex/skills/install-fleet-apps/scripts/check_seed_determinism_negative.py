#!/usr/bin/env python3
"""Negative tests for check_seed_determinism.py. M1 is the shipped defect: the
plan_vs_actual journey seed as a bare LIMIT 1."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

EXP = ".cortex/skills/install-fleet-apps/scripts/view-expectations.yaml"
h = Harness("check_seed_determinism.py")

OUTER = "      ORDER BY dev_frac DESC, jid LIMIT 1\n"
h.replace(EXP, OUTER, "      LIMIT 1\n",
          expect="seed plan_vs_actual_performance.selected_journey has no top-level ORDER BY",
          name="M1 the shipped bug: journey seed without ORDER BY")
h.replace(EXP, "VW_CUSTOMER_DEMAND ORDER BY CUSTOMER_ID LIMIT 1\n\n  catchment:",
          "VW_CUSTOMER_DEMAND LIMIT 1\n\n  catchment:",
          expect="seed mix_sourcing.selected_customer",
          name="M2 mix_sourcing customer seed unordered")
# An ORDER BY inside a CTE does not order the final pick.
INNER_OLD = ("        WHERE p.LOCATION_GEOG IS NOT NULL GROUP BY 1)\n"
             "      SELECT jid FROM dev WHERE dev_frac >= COALESCE(TRY_TO_DOUBLE(CAST(:deviation_threshold AS VARCHAR)), 0.10)\n"
             + OUTER)
INNER_NEW = ("        WHERE p.LOCATION_GEOG IS NOT NULL GROUP BY 1 ORDER BY 1)\n"
             "      SELECT jid FROM dev WHERE dev_frac >= COALESCE(TRY_TO_DOUBLE(CAST(:deviation_threshold AS VARCHAR)), 0.10)\n"
             "      LIMIT 1\n")
h.replace(EXP, INNER_OLD, INNER_NEW, expect="plan_vs_actual_performance.selected_journey has no top-level",
          name="M3 only a CTE-level ORDER BY remains")
h.replace(EXP, "  plan_vs_actual_performance:\n    areas:\n",
          "  plan_vs_actual_performance:\n    areas:\n      planned:\n        expect: may_be_empty\n"
          "        reason: may be excluded by the LIMIT 1 non-deterministic pick.\n",
          expect="RULE B", name="M4 a luck-based excuse comes back")

sys.exit(h.finish())
