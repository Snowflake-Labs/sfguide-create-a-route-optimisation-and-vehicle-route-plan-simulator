#!/usr/bin/env python3
"""Negative tests for check_semantic_view_coverage.py."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SV = ".cortex/skills/install-fleet-apps/fleet_sa_app/app/semantic_views.sql"
h = Harness("check_semantic_view_coverage.py")

h.replace(SV, "    , trips.vehicle_id AS VEHICLE_ID\n", "    , trips.vehicle_ref AS VEHICLE_ID\n",
          expect="RULE A SV_FLEET_OPS does not expose trips.vehicle_id",
          name="A: fleet ops without a vehicle dimension")
h.replace(SV, "    , alerts AS FLEET_APP.DWELL.VW_SLA_ALERTS\n", "    , alerts AS FLEET_APP.DWELL.VW_DWELL_SESSIONS\n",
          expect="RULE B SV_DWELL_ANALYTICS does not bind FLEET_APP.DWELL.VW_SLA_ALERTS",
          name="B: SLA alerts not bound")
h.replace(SV, "alerts_to_sessions AS alerts(VEHICLE_ID, SESSION_ID) REFERENCES sessions(VEHICLE_ID, SESSION_ID)",
          "alerts_to_drivers AS alerts(VEHICLE_ID) REFERENCES driver_dwell(VEHICLE_ID)",
          expect="RULE B SLA alerts are not related to sessions",
          name="B: alerts related to the driver summary instead of sessions")
h.replace(SV, "    , alerts.sla_status AS SLA_STATUS", "    , alerts.sla_level AS SLA_LEVEL",
          expect="RULE B SV_DWELL_ANALYTICS does not expose the per-session sla_status",
          name="B: severity dimension missing")
h.replace(SV, "    , alerts.breach_sessions AS COUNT(*)", "    , alerts.breach_sessions AS SUM(1)",
          expect="RULE B SV_DWELL_ANALYTICS has no breach-count metric",
          name="B: breach count metric missing")
# The shipped defect: a stored percentage commented without its scale.
h.replace(SV, "COMMENT = 'Distance deviation versus the planned distance, ALREADY in percent units (81.45 means 81.45 percent). Do not multiply by 100.'",
          "COMMENT = 'Distance deviation percent'",
          expect="RULE C semantic_views.sql",
          name="C: stored _pct column with no scale")

sys.exit(h.finish())
