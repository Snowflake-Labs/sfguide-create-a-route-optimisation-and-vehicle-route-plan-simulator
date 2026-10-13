#!/usr/bin/env python3
"""Negative tests for check_add_column_default.py - each case re-creates a column
backfill that raises on a table which already has the column (or that Snowflake
rejects outright), and the gate must name the rule, file and column.

M1 is the original defect: the per-column `ADD COLUMN IF NOT EXISTS ... DEFAULT`
block in 05_matrix_pipeline.sql."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

MOD = ".cortex/skills/install-fleet-apps/openrouteservice_app/app/modules"
M05 = f"{MOD}/05_matrix_pipeline.sql"
M03 = f"{MOD}/03_region_management.sql"
ENSURE = ".cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/studio/ensure-tables.ts"
GUARD = "-- this. No EXCEPTION handler: a real ALTER error must fail the module.\nEXECUTE IMMEDIATE $$\nDECLARE"

h = Harness("check_add_column_default.py")

h.replace(M05, GUARD, """EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS ROAD_FILTER BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;
""" + GUARD, expect="column ROAD_FILTER", name="M1 the original bug: IF NOT EXISTS + DEFAULT in 05")

h.replace(M03, GUARD, """ALTER TABLE OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
    ADD COLUMN IF NOT EXISTS
        IS_DEFAULT BOOLEAN
        DEFAULT FALSE;
""" + GUARD, expect="A .cortex/skills/install-fleet-apps/openrouteservice_app/app/modules/03_region_management.sql",
          name="M2 the disabled IS_DEFAULT migration re-enabled, split over lines")

h.replace(ENSURE, "ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_TRIPS ADD COLUMN TRIP_KIND VARCHAR(16) DEFAULT 'LADEN';",
          "ALTER TABLE ${UNIFIED_DB}.${UNIFIED_SCHEMA}.FACT_TRIPS ADD COLUMN IF NOT EXISTS TRIP_KIND VARCHAR(16) DEFAULT 'LADEN';",
          expect="column TRIP_KIND", name="M3 admin boot DDL back to IF NOT EXISTS + DEFAULT")

h.replace(ENSURE, "ADD COLUMN IF NOT EXISTS EVENT_TS TIMESTAMP_NTZ`",
          "ADD COLUMN IF NOT EXISTS EVENT_TS TIMESTAMP_NTZ DEFAULT SYSDATE()`",
          expect="B .cortex/skills/install-fleet-apps/fleet_admin_app/ui/src/server/studio/ensure-tables.ts",
          name="M4 SYSDATE() default on an existing table (the defect the handler hid)")

h.add(".cortex/skills/install-fleet-apps/scripts/new_backfill.sql",
      "ALTER TABLE T ADD COLUMN SEEN_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP;\n",
      expect="B .cortex/skills/install-fleet-apps/scripts/new_backfill.sql:1 column SEEN_AT",
      name="M5 non-constant default without IF NOT EXISTS")

h.add(".cortex/skills/install-fleet-apps/scripts/new_backfill.sh",
      "snow sql -q \"alter table t add column if not exists retries number default 0\"\n",
      expect="column retries", name="M6 lower-case form in a shell script")

sys.exit(h.finish())
