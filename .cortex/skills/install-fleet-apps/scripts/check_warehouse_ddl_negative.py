#!/usr/bin/env python3
"""Negative tests for check_warehouse_ddl.py - each case re-creates one of the
warehouse-spec drifts the gate exists to stop, and the gate must name it.

The historical defect was three disagreeing specs for one warehouse behind
`CREATE ... IF NOT EXISTS`: a bare create with no size (provision_engine.sh),
AUTO_SUSPEND = 600 in the shell deploy scripts, and a divergent COMMENT in a
.sql layer. Plus the two structural rules: the owner file must exist and declare
both warehouses, and no file may create a warehouse the skill does not own."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

S = ".cortex/skills/install-fleet-apps/scripts"
OWNER = f"{S}/warehouses.sql"
BATCH_COMMENT = ('"source":"sql","component":"batch"}}\';')

h = Harness("check_warehouse_ddl.py")

# Rule 2: a .sql layer whose spec drifts from the owner (the 600-vs-60 split).
h.replace(f"{S}/analytic_layer.sql",
          "CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS\n  WAREHOUSE_SIZE = 'XSMALL'\n  AUTO_SUSPEND = 60",
          "CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS\n  WAREHOUSE_SIZE = 'XSMALL'\n  AUTO_SUSPEND = 600",
          expect="ROUTING_ANALYTICS has AUTO_SUSPEND = 600, owner declares 60",
          name="sql layer with AUTO_SUSPEND = 600")

# Rule 2: the bare create provision_engine.sh used to run - no size, no suspend.
h.replace(f"{S}/provision_engine.sh",
          'snow sql -c "$CONN" -f "$SCRIPTS/warehouses.sql" >/dev/null 2>&1 || true\n',
          'snow sql -c "$CONN" -q "$TAG_SQL CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS;" >/dev/null 2>&1 || true\n',
          expect="ROUTING_ANALYTICS omits WAREHOUSE_SIZE",
          name="bare CREATE WAREHOUSE with no spec in a shell script")

# Rule 2: the shell-escaped -q form, as the deploy scripts embedded it.
h.replace(f"{S}/deploy_fleet_admin_app.sh",
          'snow sql -c "$CONNECTION" -f "$SKILL_DIR/scripts/warehouses.sql" >/dev/null 2>&1 || true\n',
          'snow sql -c "$CONNECTION" -q "CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS '
          "WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 600 AUTO_RESUME = TRUE "
          "MIN_CLUSTER_COUNT = 1 MAX_CLUSTER_COUNT = 3 COMMENT = '{\\\"origin\\\":\\\"x\\\"}';\" "
          ">/dev/null 2>&1 || true\n",
          expect="ROUTING_ANALYTICS has AUTO_SUSPEND = 600, owner declares 60",
          name="shell-escaped -q payload with AUTO_SUSPEND = 600")

# Rule 2: COMMENT is compared - a divergent tracking tag is drift.
h.replace(f"{S}/delivery_sync_layer.sql", BATCH_COMMENT,
          '"source":"sql","component":"delivery"}}\';',
          expect="ROUTING_ANALYTICS has COMMENT =",
          name="divergent COMMENT tag on a duplicate site")

# Rule 2: a cluster bound dropped from a duplicate site.
h.replace(f"{S}/seed_data.sql", "  MIN_CLUSTER_COUNT = 1\n  MAX_CLUSTER_COUNT = 3\n",
          "  MIN_CLUSTER_COUNT = 1\n",
          expect="ROUTING_ANALYTICS omits MAX_CLUSTER_COUNT",
          name="duplicate site omits MAX_CLUSTER_COUNT")

# Rule 3: an invented warehouse the installer never grants.
h.replace(f"{S}/seed_data.sql", "CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS",
          "CREATE WAREHOUSE IF NOT EXISTS COMPUTE_WH",
          expect="creates unowned warehouse COMPUTE_WH",
          name="unowned warehouse name")

# Rule 1: the owner must declare both warehouses.
h.replace(OWNER, "CREATE WAREHOUSE IF NOT EXISTS FLEET_APPS_WH",
          "CREATE OR REPLACE TABLE FLEET_APPS_WH_GONE",
          expect="warehouses.sql does not declare: FLEET_APPS_WH",
          name="owner file no longer declares FLEET_APPS_WH")

# Rule 1: the owner file itself must exist.
h.delete(OWNER, expect="canonical warehouse file missing",
         name="owner file deleted")

sys.exit(h.finish())
