#!/usr/bin/env bash
#
# install-fleet-apps / setup_agent_evals.sh
#
# Creates the Snowsight-visible evaluation sets for the four fleet Cortex Agents
# and (optionally) runs a baseline evaluation against each.
#
# WHY THIS EXISTS
# Snowsight's agent setup checklist flagged "Create the first eval set" and
# "Run an evaluation" as outstanding on every agent, because nothing in this repo
# produced either object. The repo's own harness (.cortex/skills/evals/
# run_agent_evals.py) tests the MCP verb path against the VERB_ATTEMPT audit
# table, which is exactly the surface Snowsight evaluations CANNOT reach - so it
# is complementary, not a substitute, and it is invisible to Snowsight.
#
# WHAT IT DOES
#   1. applies fleet_sa_app/app/agent_evals.sql (EVALS schema + 4 input tables)
#   2. creates the YAML file format + config stage and uploads the 4 run configs
#   3. calls SYSTEM$CREATE_EVALUATION_DATASET per agent (skipping ones that exist)
#   4. unless --no-run, starts EXECUTE_AI_EVALUATION per agent and polls STATUS
#
# COST. Step 4 invokes each agent once per dataset row and then runs an LLM judge
# per metric per row. That is real spend, but it is NOT optional for readiness:
# BOTH Snowsight checklist items ("Create the first eval set" and "Run an
# evaluation") stay open until a RUN exists, so the installer runs it by default
# and offers NO_RUN_AGENT_EVALS=1 (which passes --no-run here) as the opt-out.
#
# NOTE a wipe/reinstall destroys prior runs while leaving the DATASETS in place, so
# a rebuilt account needs step 4 again even though step 3 reports "already exists -
# reusing" for every dataset. A datasets-only install always looks unconfigured.
#
# PRIVILEGES (per the Cortex Agent evaluations docs): SNOWFLAKE.CORTEX_USER,
# USE AI FUNCTIONS (or USE AI FUNCTION AI_COMPLETE), EXECUTE TASK ON ACCOUNT,
# CREATE DATASET / CREATE TABLE / CREATE STAGE / CREATE FILE FORMAT / CREATE TASK
# on the evaluation schema, and USAGE + MONITOR on each agent.
#
# Usage:
#   bash .cortex/skills/install-fleet-apps/scripts/setup_agent_evals.sh <connection>
#   bash .../setup_agent_evals.sh <connection> --no-run
#   bash .../setup_agent_evals.sh <connection> --agents FLEET_AGENT,FLEET_OPS_AGENT
set -euo pipefail

CONNECTION="${1:?usage: setup_agent_evals.sh <connection> [--no-run] [--agents A,B]}"
shift || true

RUN_EVALS=1
AGENT_FILTER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-run) RUN_EVALS=0 ;;
    --agents) AGENT_FILTER="${2:?--agents needs a comma-separated list}"; shift ;;
    *) echo "ERROR: unknown argument $1"; exit 1 ;;
  esac
  shift
done

REPO_ROOT=$(git rev-parse --show-toplevel)
APP_DIR="$REPO_ROOT/.cortex/skills/install-fleet-apps/fleet_sa_app/app"
EVAL_SQL="$APP_DIR/agent_evals.sql"
YAML_DIR="$APP_DIR/evals"

EVAL_DB="FLEET_INTELLIGENCE"
EVAL_SCHEMA="EVALS"
STAGE="EVAL_CONFIG"
EVAL_WAREHOUSE="${EVAL_WAREHOUSE:-ROUTING_ANALYTICS}"
TRACK='{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"agent-evals"}}'
# An evaluation runs in the session's database and schema (Snowsight uses the
# agent's), and its metrics run on the session warehouse - so both are pinned here
# rather than relying on the connection's defaults.
TAG_SQL="ALTER SESSION SET query_tag = '$TRACK'; USE WAREHOUSE ${EVAL_WAREHOUSE}; USE SCHEMA ${EVAL_DB}.${EVAL_SCHEMA};"

# agent name : input table : dataset name : yaml file
AGENTS=(
  "FLEET_AGENT:EVAL_INPUT_FLEET_AGENT:EVAL_DS_FLEET_AGENT:fleet_agent.yaml"
  "FLEET_SUPER_AGENT:EVAL_INPUT_FLEET_SUPER_AGENT:EVAL_DS_FLEET_SUPER_AGENT:super_agent.yaml"
  "FLEET_OPS_AGENT:EVAL_INPUT_FLEET_OPS_AGENT:EVAL_DS_FLEET_OPS_AGENT:ops_agent.yaml"
  "FLEET_ADMIN_AGENT:EVAL_INPUT_FLEET_ADMIN_AGENT:EVAL_DS_FLEET_ADMIN_AGENT:admin_agent.yaml"
)

note() { echo "[agent-evals] $*"; }
q()    { snow sql -c "$CONNECTION" -q "$TAG_SQL $1" --enable-templating NONE 2>&1; }

selected() {
  [ -z "$AGENT_FILTER" ] && return 0
  case ",$AGENT_FILTER," in *",$1,"*) return 0 ;; esac
  return 1
}

[ -f "$EVAL_SQL" ] || { echo "ERROR: missing $EVAL_SQL"; exit 1; }
[ -d "$YAML_DIR" ] || { echo "ERROR: missing $YAML_DIR"; exit 1; }

# ── 1. dataset input tables ─────────────────────────────────────
note "applying agent_evals.sql (EVALS schema + input tables) ..."
snow sql -c "$CONNECTION" -f "$EVAL_SQL" --enable-templating NONE >/tmp/ifa_agent_evals_seed.log 2>&1 \
  || { echo "ERROR: agent_evals.sql failed; see /tmp/ifa_agent_evals_seed.log"; exit 1; }

# ── 2. config stage + upload ────────────────────────────────────
# The docs require this exact file format for Snowflake to parse the YAML: CSV
# with no field delimiter and no enclosure, i.e. read the file verbatim.
note "ensuring YAML file format + $STAGE stage ..."
q "CREATE OR REPLACE FILE FORMAT ${EVAL_DB}.${EVAL_SCHEMA}.YAML_FILE_FORMAT
     TYPE = 'CSV' FIELD_DELIMITER = NONE RECORD_DELIMITER = '\\n' SKIP_HEADER = 0
     FIELD_OPTIONALLY_ENCLOSED_BY = NONE ESCAPE_UNENCLOSED_FIELD = NONE
     COMMENT = '$TRACK';
   CREATE STAGE IF NOT EXISTS ${EVAL_DB}.${EVAL_SCHEMA}.${STAGE}
     FILE_FORMAT = ${EVAL_DB}.${EVAL_SCHEMA}.YAML_FILE_FORMAT
     COMMENT = '$TRACK';" >/dev/null

for entry in "${AGENTS[@]}"; do
  IFS=: read -r agent _tbl _ds yaml <<<"$entry"
  selected "$agent" || continue
  note "uploading $yaml ..."
  # Keep YAML uncompressed (docs recommendation) and overwrite so a config edit
  # is picked up on the next run.
  q "PUT file://$YAML_DIR/$yaml @${EVAL_DB}.${EVAL_SCHEMA}.${STAGE}
       AUTO_COMPRESS = FALSE OVERWRITE = TRUE;" >/dev/null \
    || { echo "ERROR: PUT of $yaml failed"; exit 1; }
done

# ── 3. datasets ─────────────────────────────────────────────────
# SYSTEM$CREATE_EVALUATION_DATASET is a PROCEDURE (CALL, not SELECT) taking
# (dataset_type, source_table, dataset_name, column_mapping). It fails hard when
# the dataset name already exists, so the existence probe is what makes this
# script re-runnable. NOTE the column-mapping keys differ from the YAML form:
# here they are query_text / expected_tools, not query_text / ground_truth.
#
# The probe reads JSON, NOT the default table output: snow sql wraps long values
# across lines, so a plain grep for a 28-character dataset name silently misses
# and every re-run then died on "already exists". An "already exists" error is
# additionally tolerated below, so the script cannot be broken by a probe miss.
existing_datasets=$(
  snow sql -c "$CONNECTION" -q "SHOW DATASETS IN SCHEMA ${EVAL_DB}.${EVAL_SCHEMA};" \
    --format json 2>/dev/null \
  | python3 -c 'import json,sys
try:
    print("\n".join(str(r.get("name","")) for r in json.load(sys.stdin)))
except Exception:
    pass' || true
)

for entry in "${AGENTS[@]}"; do
  IFS=: read -r agent tbl ds yaml <<<"$entry"
  selected "$agent" || continue
  if echo "$existing_datasets" | grep -qx "$ds"; then
    note "dataset $ds already exists - reusing"
    continue
  fi
  note "creating dataset $ds from $tbl ..."
  out=$(q "CALL SYSTEM\$CREATE_EVALUATION_DATASET(
             'CORTEX AGENT',
             '${EVAL_DB}.${EVAL_SCHEMA}.${tbl}',
             '${EVAL_DB}.${EVAL_SCHEMA}.${ds}',
             OBJECT_CONSTRUCT('query_text', 'INPUT_QUERY', 'expected_tools', 'GROUND_TRUTH')
           );" || true)
  if echo "$out" | grep -qi "already exists"; then
    note "dataset $ds already exists - reusing"
  elif echo "$out" | grep -qiE "^.*Error |exception"; then
    echo "$out" | tail -8
    echo "ERROR: dataset $ds creation failed"
    exit 1
  else
    echo "$out" | tail -6
  fi
done

if [ "$RUN_EVALS" != "1" ]; then
  note "datasets ready. Skipping runs (--no-run)."
  note "run later with: bash $0 $CONNECTION"
  exit 0
fi

# ── 4. runs ─────────────────────────────────────────────────────
STAMP=$(date -u +%Y%m%d-%H%M)
note "starting baseline evaluation runs (this invokes each agent per dataset row and an LLM judge per metric - real spend) ..."

for entry in "${AGENTS[@]}"; do
  IFS=: read -r agent tbl ds yaml <<<"$entry"
  selected "$agent" || continue
  run_name="baseline-${STAMP}"
  cfg="@${EVAL_DB}.${EVAL_SCHEMA}.${STAGE}/${yaml}"
  note "START $agent run=$run_name"
  out=$(q "CALL EXECUTE_AI_EVALUATION('START', OBJECT_CONSTRUCT('run_name', '$run_name'), '$cfg');")
  echo "$out" | tail -5
  if echo "$out" | grep -qiE "^.*Error |exception"; then
    note "WARN: could not start the run for $agent - continuing with the others"
    continue
  fi

  # Bounded poll. A run walks the whole dataset through the agent, so minutes is
  # normal; this is a progress report, not a gate.
  #
  # Match ONLY the documented terminal STATUS tokens. A generic /SUCCESS/ match
  # is wrong here: every q() call prints the session preamble's "Statement
  # executed successfully", so the loop declared victory on its first pass while
  # the run was still INVOCATION_IN_PROGRESS.
  for _ in $(seq 1 40); do
    sleep 30
    status=$(q "CALL EXECUTE_AI_EVALUATION('STATUS', OBJECT_CONSTRUCT('run_name', '$run_name'), '$cfg');" || true)
    if echo "$status" | grep -qE "COMPLETED|EVALUATION_COMPLETED|FAILED|CANCELLED|_ERROR"; then
      echo "$status" | tail -8
      break
    fi
    note "  $agent still running ..."
  done
done

note "done. Inspect results in Snowsight (AI & ML > Agents > <agent> > Evaluations),"
note "or with SNOWFLAKE.LOCAL.GET_AI_EVALUATION_DATA('${EVAL_DB}','SYNAPSE_USER','<agent>','CORTEX AGENT','baseline-${STAMP}')."
