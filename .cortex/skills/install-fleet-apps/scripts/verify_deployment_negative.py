#!/usr/bin/env python3
"""Negative tests for verify_deployment.sh (live gate `deployment_coherence`).

Runs offline: the gate talks to fake_snow.py replaying a cassette recorded from a
healthy full install (live_cassettes/deployment_coherence.json), and each case
alters ONE response to re-create a broken-install shape the gate exists for.
The healthy replay must pass first. Re-record the cassette when the gate's
queries change (an unrecorded query fails loudly, it is never guessed).
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

h = Harness("verify_deployment.sh", args=["-c", "replayed", "--expect-engine"],
            cassette=".cortex/skills/install-fleet-apps/scripts/live_cassettes/deployment_coherence.json")

COUNT_ROW = "| 44       |"
# The silent half-install: the routing database exists (stub + synapse bundle)
# but the engine SQL modules never loaded, so every live view fails at runtime.
h.account("engine modules never loaded (0 functions)",
          [{"match": "OPENROUTESERVICE_APP.INFORMATION_SCHEMA.FUNCTIONS;",
            "replace": [[COUNT_ROW, "| 0        |"]]}],
          expect="has 0 FUNCTIONS")
h.account("engine only partially loaded (5 functions)",
          [{"match": "OPENROUTESERVICE_APP.INFORMATION_SCHEMA.FUNCTIONS;",
            "replace": [[COUNT_ROW, "| 5        |"]]}],
          expect="BLOCKING")
h.account("connection does not work",
          [{"match": "SELECT CURRENT_ACCOUNT() AS A, CURRENT_ROLE() AS R;", "rc": 1,
            "stdout": "", "stderr": "Error: 250001: Could not connect to Snowflake backend"}],
          expect="does not work")
h.account("routing service suspended",
          [{"match": "SHOW SERVICES LIKE 'ORS_SERVICE_SANFRANCISCO'",
            "replace": [["RUNNING", "SUSPENDED"]]}],
          expect="ORS_SERVICE_SANFRANCISCO")
h.account("SA app service missing",
          [{"match": "SHOW SERVICES LIKE 'FLEET_SA_APP'", "stdout": "name,status\n"}],
          expect="FLEET_SA_APP")
h.account("app role lost its warehouse grant",
          [{"match": "SHOW GRANTS TO ROLE FLEET_APP_USER;",
            "replace": [["USAGE,WAREHOUSE,FLEET_APPS_WH", "USAGE,WAREHOUSE,OTHER_WH"]]}],
          expect="FLEET_APP_USER")
h.account("no trips readable (empty seed)",
          [{"match": "V_FACT_TRIPS_CURRENT;", "replace": [["| 16535    |", "| 0        |"]]}],
          expect="V_FACT_TRIPS_CURRENT is EMPTY")
sys.exit(h.finish())
