#!/usr/bin/env python3
"""Negative tests for check_marketplace_ddl_parity.py - each case makes the
installer's mirror of a MARKETPLACE / projection object diverge from its runtime
owner (init.ts), and the gate must name the object and the file.

The defect: the installer creates one shape at step 4.4, the semantic view binds
to it, and the app boot REPLACES it with another shape - so the deployment works
until the container restarts. Cases cover drift on either side, an object
missing from either side, a missing file, and the vacuity guard (extractors that
match nothing)."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SK = ".cortex/skills/install-fleet-apps"
MKT = f"{SK}/scripts/marketplace_layer.sql"
PROJ = f"{SK}/scripts/projection_views.sql"
INIT = f"{SK}/fleet_admin_app/ui/src/server/lib/init.ts"

h = Harness("check_marketplace_ddl_parity.py")

# Drift in the .sql mirror: a column the semantic view binds to disappears.
h.replace(MKT, "  ROUND(AVG(COST_PER_KM), 2)                              AS AVG_COST_PER_KM\n",
          "  AVG(COST_PER_KM)                                        AS AVG_COST_PER_KM\n",
          expect="VW_LANE_HISTORY: DRIFT between init.ts and marketplace_layer.sql",
          name="sql mirror body drifts (VW_LANE_HISTORY)")

# Drift on the runtime-owner side: init.ts changes the dynamic table lag.
h.replace(INIT, "        TARGET_LAG = '1 hour'", "        TARGET_LAG = '5 minutes'",
          expect="RATE_INDEX: DRIFT between init.ts and marketplace_layer.sql",
          name="runtime owner drifts (RATE_INDEX target lag)")

# Drift in the projection mirror: the active-dataset filter is lost.
h.replace(PROJ, " AND d.VEHICLE_TYPE = p.VEHICLE_TYPE\n AND d.IS_ACTIVE = TRUE;",
          " AND d.VEHICLE_TYPE = p.VEHICLE_TYPE;",
          expect="V_DIM_PARTNERS_CURRENT: DRIFT between init.ts and projection_views.sql",
          name="projection mirror drops IS_ACTIVE filter")

# A string literal is data, not an identifier: a case change alters which rows
# the view counts, so it must be reported as drift.
h.replace(MKT, "SUM(CASE WHEN OUTCOME = 'DELIVERED' THEN 1 ELSE 0 END)",
          "SUM(CASE WHEN OUTCOME = 'Delivered' THEN 1 ELSE 0 END)",
          expect="VW_LANE_HISTORY: DRIFT between init.ts and marketplace_layer.sql",
          name="string literal case drift (VW_LANE_HISTORY)")

# The mirror drops an object the installer needs before the app boots.
h.replace(MKT, "CREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_HISTORY",
          "-- moved to app boot\nCREATE OR REPLACE VIEW FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_HISTORY_V2",
          expect="VW_LANE_HISTORY: not found in marketplace_layer.sql",
          name="object missing from the sql mirror")

# The runtime owner stops creating a mirrored object.
h.replace(INIT, "sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_PARTNERS_CURRENT",
          "sql: `CREATE OR REPLACE VIEW SYNTHETIC_DATASETS.UNIFIED.V_DIM_PARTNERS_CURRENT_OLD",
          expect="V_DIM_PARTNERS_CURRENT: not found in init.ts",
          name="object missing from init.ts")

# A mirror file is deleted.
h.delete(PROJ, expect="FAILED: missing", name="projection_views.sql deleted")

# Vacuity guard: a refactor of init.ts that the TS extractor no longer matches.
h.replace(INIT, "`CREATE OR REPLACE", "`CREATE  OR  ALTER", count=-1,
          expect="0 objects compared",
          name="extractor matches nothing (vacuity guard)")

sys.exit(h.finish())
