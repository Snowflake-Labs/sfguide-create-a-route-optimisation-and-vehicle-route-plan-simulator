#!/usr/bin/env python3
"""Negative tests for check_tracking_tags.py - one or more cases per defect class
the gate names (A session query_tag, B object COMMENT incl. nested and CTAS,
C tag schema, D shell -q payloads, E task QUERY_TAG, F application code).

Every one of these defects is invisible at runtime: an untagged object works and
an untagged session returns the right rows. What breaks is credit attribution
and the cleanup skill, which finds objects to drop only by their COMMENT tag."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from negtest import Harness  # noqa: E402

SK = ".cortex/skills/install-fleet-apps"
S = f"{SK}/scripts"
SEED = f"{S}/seed_data.sql"
REGION_MGMT = f"{SK}/openrouteservice_app/app/modules/03_region_management.sql"
MATRIX = f"{SK}/openrouteservice_app/app/modules/05_matrix_pipeline.sql"
EVALS = f"{S}/setup_agent_evals.sh"
INIT = f"{SK}/fleet_admin_app/ui/src/server/lib/init.ts"
DWELL = ".cortex/skills/dwell-analysis/references/sql-pipeline.sql"

SEED_DB = "CREATE DATABASE IF NOT EXISTS SYNTHETIC_DATASETS\n  COMMENT = "
SEED_TAG = ('\'{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps",'
            '"version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}\';')

h = Harness("check_tracking_tags.py")


def line_in_copy(rel: str, needle: str) -> int:
    text = h.path(rel).read_text()
    return text.count("\n", 0, text.index(needle)) + 1


# ── A. session query_tag ────────────────────────────────────────────────────
h.replace(f"{S}/warehouses.sql", "ALTER SESSION SET query_tag = ", "SELECT ",
          expect="warehouses.sql: no `ALTER SESSION SET query_tag`",
          name="A: sql file with no session query_tag")
h.add(f"{S}/negtest_foreign_origin.sql",
      "ALTER SESSION SET query_tag = '{\"origin\":\"someone-else\"}';\nSELECT 1;\n",
      expect="query_tag present but origin is not 'sf_sit-is-fleet'",
      name="A: query_tag with a foreign origin")

# ── B. object COMMENT ───────────────────────────────────────────────────────
h.replace(SEED, SEED_DB + SEED_TAG, "CREATE DATABASE IF NOT EXISTS SYNTHETIC_DATASETS;",
          expect="CREATE DATABASE SYNTHETIC_DATASETS has no COMMENT tracking tag",
          name="B: top-level CREATE DATABASE without COMMENT")
# The historical miss: a self-healing CREATE TABLE nested in APPLY_ORS_LIMITS.
h.replace(REGION_MGMT, "UPDATED_AT TIMESTAMP_NTZ DEFAULT SYSDATE()\n    )\n    COMMENT = ",
          "UPDATED_AT TIMESTAMP_NTZ DEFAULT SYSDATE()\n    );\n    SELECT ",
          expect="CREATE TABLE OPENROUTESERVICE_APP.CORE.REGION_ORS_LIMITS has no COMMENT tracking tag",
          name="B: CREATE TABLE nested in a procedure body without COMMENT")
# CTAS cannot take an inline COMMENT; the follow-up ALTER is the required form.
h.replace(DWELL, "ALTER TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS SET COMMENT",
          "ALTER TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS SET DATA_RETENTION_TIME_IN_DAYS = 0, X_COMMENT",
          expect="CREATE TABLE FLEET_INTELLIGENCE.DWELL_ANALYSIS.GEOFENCE_POLYGONS has no COMMENT tracking tag",
          name="B: CTAS whose ALTER ... SET COMMENT was dropped")
# Rendered templates: `comment = $comment` is the tag ONLY inside the template dir.
h.replace(f"{S}/overture_semantic/buildings.sql",
          "create or replace view $ns.BUILDING comment = $comment as",
          "create or replace view $ns.BUILDING as",
          expect="CREATE VIEW $ns.BUILDING has no COMMENT tracking tag",
          name="B: rendered template view without its $comment placeholder")
h.add(f"{S}/negtest_placeholder_outside_templates.sql",
      "ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\"}';\n"
      "CREATE VIEW X.Y.Z comment = $comment AS SELECT 1;\n",
      expect="CREATE VIEW X.Y.Z has no COMMENT tracking tag",
      name="B: $comment placeholder outside the rendered-template dir")

# ── C. tag schema ───────────────────────────────────────────────────────────
h.replace(SEED, SEED_DB + SEED_TAG,
          SEED_DB + SEED_TAG.replace('"version":{"major":1,"minor":0}', '"version":"1.0"'),
          expect='missing version as {"major":N,"minor":N}',
          name='C: version as a "1.0" string')
h.replace(SEED, SEED_DB + SEED_TAG, SEED_DB + SEED_TAG.replace('"is_quickstart":1,', ""),
          expect="missing attributes.is_quickstart",
          name="C: tag without attributes.is_quickstart")
h.replace(SEED, SEED_DB + SEED_TAG, SEED_DB + SEED_TAG.replace(',"source":"sql"', ""),
          expect="missing attributes.source",
          name="C: tag without attributes.source")
h.replace(SEED, SEED_DB + SEED_TAG, SEED_DB + SEED_TAG.replace('"oss-install-fleet-apps"', '"install-fleet-apps"'),
          expect="missing name with an 'oss-' prefix",
          name="C: name without the oss- prefix")
h.replace(SEED, SEED_DB + SEED_TAG, SEED_DB + SEED_TAG.replace('"name":', '"name"'),
          expect="tracking tag is not valid JSON",
          name="C: tag that does not parse")

# ── D. shell -q payloads ────────────────────────────────────────────────────
h.replace(f"{S}/provision_engine.sh",
          'snow sql -c "$CONN" -q "\n  $TAG_SQL\n  CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_APP',
          'snow sql -c "$CONN" -q "\n  CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_APP',
          expect="`snow sql -q` runs DDL/DML with no query_tag in the SAME invocation",
          name="D: shell -q DDL payload with no tag")

# ── E. task QUERY_TAG ───────────────────────────────────────────────────────
evals_line = line_in_copy(EVALS, "CREATE OR REPLACE TASK ${EVAL_DB}")
h.replace(EVALS, "    QUERY_TAG = '${TRACK}'\n", "",
          expect=f"setup_agent_evals.sh:{evals_line}: CREATE TASK has no QUERY_TAG session parameter",
          name="E: shell-expanded CREATE TASK without QUERY_TAG")
matrix_line = line_in_copy(MATRIX, "'CREATE OR REPLACE TASK ' || :task_name")
h.replace(MATRIX, "        ' QUERY_TAG = ''", "        ' X_TAG = ''",
          expect=f"05_matrix_pipeline.sql:{matrix_line}: CREATE TASK has no QUERY_TAG session parameter",
          name="E: concatenated CREATE TASK without QUERY_TAG")

# ── F. application code ─────────────────────────────────────────────────────
SOLVE_TAIL = "        COMPLETED_AT     TIMESTAMP_NTZ\n      ) COMMENT = ${TRACK}`,"
h.replace(INIT, SOLVE_TAIL, "        COMPLETED_AT     TIMESTAMP_NTZ\n      )`,",
          expect="CREATE TABLE FLEET_INTELLIGENCE.CORE.SOLVE_RESULTS in application code has no COMMENT tracking tag",
          name="F: TS CREATE TABLE without COMMENT")
h.replace(INIT, SOLVE_TAIL, "        COMPLETED_AT     TIMESTAMP_NTZ\n      ) COMMENT = ${SOLVE_NOTE}`,",
          expect="CREATE TABLE FLEET_INTELLIGENCE.CORE.SOLVE_RESULTS in application code has no COMMENT tracking tag",
          name="F: TS COMMENT interpolating a const that is not a tag")

sys.exit(h.finish())
