#!/usr/bin/env bash
#
# install-fleet-apps / install_fleet_apps.sh
#
# PRIMARY one-command installer for the vehicle/industry-AGNOSTIC, synapse-based
# fleet analytics architecture. Installs the COMPLETE agnostic use-case set
# unconditionally (no per-use-case selection). build-routing-solution is a
# secondary, delegated provider for the ORS engine only.
#
# Layers (detect-and-reuse-else-create throughout):
#   0 preflight -> 1 infra -> 2 data -> 3 routing contract+engine
#   -> 3.5 analytic layer (FLEET_INTELLIGENCE.* the packs read) -> 4 packs
#   -> 5 synapse tools -> 6 agents -> 7 apps -> 8 roles+grants -> friction log
#   (roles/grants run LAST: role_binding.sql grants on SYNAPSE_USER objects —
#    the 3 agents and the FLEET_SA_APP service role — which only exist after
#    the agents+apps steps, so the single idempotent grants pass must follow them.)
#
# Usage:
#   bash .cortex/skills/install-fleet-apps/scripts/install_fleet_apps.sh --connection <conn>
#
# Flags (re-run shortcuts only; there is NO use-case selection):
#   --connection <name>   REQUIRED. Snow CLI connection.
#   --no-engine           OPTIONAL. Skip the live ORS engine build. By DEFAULT the
#                         engine is built + provisioned natively when absent (heavy:
#                         4 SPCS images + a region graph, tens of minutes); it is
#                         auto-skipped when an engine is already present. --no-engine
#                         (or NO_ENGINE=1 / PROVISION_ENGINE=0) installs routing verbs
#                         inert instead. --with-engine is accepted as a no-op (default).
#   SKIP_INFRA=1 SKIP_DATA=1 SKIP_ANALYTIC=1 SKIP_ROUTING=1 SKIP_PACKS=1 SKIP_TOOLS=1
#   SKIP_ROLES=1 SKIP_AGENTS=1 SKIP_APPS=1   (env vars)
set -euo pipefail

# ── arg parse ───────────────────────────────────────────────────
# Engine is ON by default. PROVISION_ENGINE=0 (or NO_ENGINE=1, or --no-engine) opts out.
CONNECTION=""
WITH_ENGINE="${PROVISION_ENGINE:-1}"
[ "${NO_ENGINE:-0}" = "1" ] && WITH_ENGINE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --connection) CONNECTION="${2:-}"; shift 2;;
    --connection=*) CONNECTION="${1#*=}"; shift;;
    --with-engine) WITH_ENGINE=1; shift;;   # accepted as no-op (engine is default)
    --no-engine) WITH_ENGINE=0; shift;;
    *) echo "Unknown arg: $1"; exit 2;;
  esac
done
[ -n "$CONNECTION" ] || { echo "ERROR: --connection <name> is required"; exit 2; }

REPO_ROOT=$(git rev-parse --show-toplevel)
SKILL_DIR="$REPO_ROOT/.cortex/skills/install-fleet-apps"
SCRIPTS="$SKILL_DIR/scripts"
REF="$SKILL_DIR/references"
PACKS_INSTALL="$SKILL_DIR/fleet_sa_app/app/packs/_lib/install.py"
ROLE_BINDING="$SKILL_DIR/fleet_sa_app/app/role_binding.sql"
ROUTING_SETUP="$SKILL_DIR/routing_platform/setup.sql"
# Canonical source of the 9 ROUTING_TOOLS.TOOL_* procedures the synapse routing
# verbs (OPENROUTESERVICE_APP.ROUTING.*) wrap. Without these the verbs CALL a
# non-existent proc and every FLEET_AGENT routing request fails ("routing service
# experiencing issues") even though the ORS engine is healthy. Single source of
# truth per fleet_tools/user/src/catalog.ts; deployed in step 3 after the contract.
ROUTING_TOOLS_SQL="$REPO_ROOT/.cortex/skills/routing-agent/references/deploy-agent.sql"
ANALYTIC_SQL="$SCRIPTS/analytic_layer.sql"
SEMANTIC_VIEWS_SQL="$SKILL_DIR/fleet_sa_app/app/semantic_views.sql"
START_TS=$(date +%s)
ROUTING_SUBSTRATE="(routing step not run)"   # set by step 3; surfaced in friction log + summary
LOG_DIR="$REPO_ROOT/.cortex/skills/install-fleet-apps/logs"
mkdir -p "$LOG_DIR"
FRICTION_LOG="$LOG_DIR/friction-log_$(date +%Y-%m-%d_%H-%M).md"
declare -a STEP_STATUS

note() { echo "[install-fleet-apps] $*"; }
step() { STEP_STATUS+=("$1|$2"); }

# helper: does a SHOW return the named object? args: <show-sql> <name-regex>
obj_exists() {
  # NOTE: snow CLI >=3.x has no 'plain' format (valid: TABLE/JSON/JSON_EXT/CSV).
  # CSV gives unbordered, greppable rows; object names appear as plain cells.
  snow sql -c "$CONNECTION" --format=CSV -q "$1" 2>/dev/null | grep -qiE "$2"
}

# ── 0. preflight ────────────────────────────────────────────────
note "[0/8] preflight..."
for t in snow docker node npm python3; do
  command -v "$t" >/dev/null 2>&1 || { echo "ERROR: '$t' not found"; exit 1; }
done
snow sql -c "$CONNECTION" -q "SELECT CURRENT_ACCOUNT();" >/dev/null 2>&1 \
  || { echo "ERROR: connection '$CONNECTION' does not work"; exit 1; }
step "0 preflight" OK

# ── 0.5 pre-create FLEET_APP_* roles (before any GRANT target needs them) ──
# The routing contract (step 3), packs (step 4), and role binding (step 6) all
# GRANT to these roles. Step 3 runs BEFORE the role-binding step, so on a fresh
# install its grants to FLEET_APP_USER previously failed ("Role 'FLEET_APP_USER'
# does not exist") and left routing verbs ungranted to the consumer. Create the
# role NAMES up front (idempotent, empty until step 6 binds objects) so every
# downstream GRANT target exists regardless of step ordering.
note "[0.5/8] pre-creating FLEET_APP_* role names..."
snow sql -c "$CONNECTION" -q "
  CREATE ROLE IF NOT EXISTS FLEET_APP_USER;
  CREATE ROLE IF NOT EXISTS FLEET_APP_OPS;
  CREATE ROLE IF NOT EXISTS FLEET_APP_ADMIN;
  CREATE ROLE IF NOT EXISTS FLEET_APP_DYNAMIC_READER;
" >/tmp/ifa_preroles.log 2>&1 || note "  WARN: role pre-create reported errors (see /tmp/ifa_preroles.log)"

# ── 1. infra (reuse OPENROUTESERVICE_APP else self-provision FLEET-owned) ──
# Var RESOLUTION always runs (cheap SHOW probes) so downstream steps (esp. the
# apps step, which needs $COMPUTE_POOL) have bound vars even under SKIP_INFRA.
# SKIP_INFRA only suppresses the self-provision CREATE (references/infra.sql);
# it must NOT leave COMPUTE_POOL unset (that previously crashed the admin-app
# deploy with "COMPUTE_POOL: unbound variable" under set -u).
export IMAGE_REPO_SQL_NAME COMPUTE_POOL CARTO_EAI OSM_EAI SPEC_STAGE_NAME
note "[1/8] resolving SPCS infra..."
if obj_exists "SHOW IMAGE REPOSITORIES IN SCHEMA OPENROUTESERVICE_APP.CORE;" 'image_repository' \
   && obj_exists "SHOW COMPUTE POOLS LIKE 'OPENROUTESERVICE_APP_COMPUTE_POOL';" 'OPENROUTESERVICE_APP_COMPUTE_POOL' \
   && obj_exists "SHOW EXTERNAL ACCESS INTEGRATIONS LIKE 'ORS_CARTO_EAI';" 'ORS_CARTO_EAI'; then
  note "  reusing OPENROUTESERVICE_APP infra"
  IMAGE_REPO_SQL_NAME="OPENROUTESERVICE_APP.core.image_repository"
  COMPUTE_POOL="OPENROUTESERVICE_APP_COMPUTE_POOL"
  CARTO_EAI="ORS_CARTO_EAI"
  OSM_EAI="ORS_OSM_EAI"
  SPEC_STAGE_NAME="OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE"
else
  IMAGE_REPO_SQL_NAME="FLEET_INTELLIGENCE.CORE.IMAGE_REPOSITORY"
  COMPUTE_POOL="FLEET_APPS_COMPUTE_POOL"
  CARTO_EAI="FLEET_APP_CARTO_EAI"
  OSM_EAI="FLEET_APP_OSM_EAI"
  SPEC_STAGE_NAME="FLEET_INTELLIGENCE.CORE.FLEET_SPEC_STAGE"
  if [ "${SKIP_INFRA:-0}" != "1" ]; then
    note "  self-provisioning FLEET-owned infra (references/infra.sql)"
    snow sql -c "$CONNECTION" -f "$REF/infra.sql" >/tmp/ifa_infra.log 2>&1 \
      || { echo "ERROR: infra provisioning failed"; tail -30 /tmp/ifa_infra.log; step "1 infra" FAILED; exit 1; }
  else
    note "  SKIP_INFRA=1 -> not provisioning; assuming FLEET-owned infra already exists"
  fi
fi
note "  infra: repo=$IMAGE_REPO_SQL_NAME pool=$COMPUTE_POOL eai=$CARTO_EAI,$OSM_EAI stage=$SPEC_STAGE_NAME"
step "1 infra" OK

# ── 2. data (reuse rows else seed the agnostic SF/ebike preset) ──
if [ "${SKIP_DATA:-0}" != "1" ]; then
  note "[2/8] resolving data layer..."
  HAVE_DATA=$(snow sql -c "$CONNECTION" --format=CSV -q \
    "SELECT IFF((SELECT COUNT(*) FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS)>0 AND (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS)>0,'YES','NO');" \
    2>/dev/null | grep -iE '^(YES|NO)$' | head -1 || echo "NO")
  if [ "$HAVE_DATA" = "YES" ]; then
    note "  reusing existing agnostic data"
  else
    note "  seeding agnostic SF/ebike preset (references/seed-data.md)"
    snow sql -c "$CONNECTION" -f "$SCRIPTS/seed_data.sql" >/tmp/ifa_seedprep.log 2>&1 || true
    # Strip macOS .DS_Store cruft so --recursive does not upload it into leaf parquet dirs.
    find "$REPO_ROOT/datasets" -name '.DS_Store' -delete 2>/dev/null || true
    # datasets/ has nested subdirs (intro/, metadata/, synthetic_ebikes/<table>/...) that the
    # loader COPY INTOs from by path, so the upload MUST preserve directory structure (--recursive).
    # NOTE: ~85 MB uploaded file-by-file (per-file MD5/compress) — expect a few minutes with no
    # per-file progress output; it is not stalled.
    note "  uploading ~85 MB seed parquet (file-by-file; expect a few minutes)..."
    snow stage copy "$REPO_ROOT/datasets/" @FLEET_INTELLIGENCE.CORE.SEED_DATA_STAGE/ -c "$CONNECTION" --overwrite --recursive >/tmp/ifa_stage.log 2>&1 \
      || { echo "ERROR: staging seed parquet failed"; tail -20 /tmp/ifa_stage.log; step "2 data" FAILED; exit 1; }
    # Sanity check: a silent 0-file upload (e.g. wrong path, glob mismatch) otherwise only
    # surfaces much later as empty tables. Fail fast here with a clear message.
    STAGED_FILES=$(snow sql -c "$CONNECTION" --format=CSV -q \
      "LIST @FLEET_INTELLIGENCE.CORE.SEED_DATA_STAGE; SELECT COUNT(*) AS N FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));" \
      2>/dev/null | grep -oE '^[0-9]+$' | tail -1 || echo 0)
    if [ "${STAGED_FILES:-0}" -lt 1 ]; then
      echo "ERROR: seed stage @FLEET_INTELLIGENCE.CORE.SEED_DATA_STAGE has 0 files after copy (expected the datasets/ tree)"; tail -20 /tmp/ifa_stage.log; step "2 data" FAILED; exit 1
    fi
    note "  staged $STAGED_FILES seed files"
    sed 's|OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE|FLEET_INTELLIGENCE.CORE.SEED_DATA_STAGE|g; s|OPENROUTESERVICE_APP.CORE.PARQUET_FF|FLEET_INTELLIGENCE.CORE.PARQUET_FF|g' \
      "$REPO_ROOT/datasets/load-seed-data.sql" > /tmp/ifa_loader.sql
    snow sql -c "$CONNECTION" -f /tmp/ifa_loader.sql >/tmp/ifa_load.log 2>&1 \
      || note "  WARN: canonical loader reported errors (some engine-only sections may not apply); continuing"
    snow sql -c "$CONNECTION" -f "$SCRIPTS/seed_data.sql" >/tmp/ifa_purge.log 2>&1 || true
  fi
  step "2 data" OK
else
  step "2 data" SKIPPED
fi

# ── 2.5 vehicle-profile catalog + projection views (ALWAYS run; NOT gated by SKIP_DATA) ──
# The packs depend on the DIM_FLEET asset-column stamp (DIM_VEHICLE_PROFILE /
# DIM_VEHICLE_DWELL_SLA + WEIGHT_TONS/HEIGHT_M/... on DIM_FLEET) and the agnostic
# V_*_CURRENT projection views. These are decoupled from SKIP_DATA on purpose:
# SKIP_DATA=1 is the "data already loaded, shorten the re-run" shortcut, but the
# catalog/views still need (re)asserting against existing data. Gating them behind
# SKIP_DATA previously left DIM_FLEET un-stamped, so the pack step failed creating
# F_DIM_FLEET_SCOPED with "invalid identifier 'F.WEIGHT_TONS'". Idempotent and
# best-effort (a WARN never aborts). vehicle_profile_catalog MUST run BEFORE
# projection_views (it drops V_DIM_FLEET_CURRENT to ALTER DIM_FLEET). Use
# SKIP_PROJECTIONS=1 only when you know both are already current.
if [ "${SKIP_PROJECTIONS:-0}" != "1" ]; then
  note "[2.5/8] vehicle-profile catalog + projection views (DIM_FLEET stamp; packs depend on these)..."
  snow sql -c "$CONNECTION" -f "$SCRIPTS/vehicle_profile_catalog.sql" >/tmp/ifa_vpcatalog.log 2>&1 \
    || note "  WARN: vehicle-profile catalog seed reported errors (see /tmp/ifa_vpcatalog.log)"
  snow sql -c "$CONNECTION" -f "$SCRIPTS/projection_views.sql" >/tmp/ifa_projviews.log 2>&1 \
    || note "  WARN: projection-view creation reported errors (see /tmp/ifa_projviews.log)"
  step "2.5 projections" OK
else
  step "2.5 projections" SKIPPED
fi

# ── 3. engine detect/delegate, THEN the routing contract (owned) ────────
if [ "${SKIP_ROUTING:-0}" != "1" ]; then
  note "[3/8] routing contract + engine..."
  # Engine FIRST. The contract (routing_platform/setup.sql) references engine
  # objects at compile time -- its region->provider MERGE reads
  # OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP and its PROVIDERS.ORS_*_RAW adapters
  # wrap the OPENROUTESERVICE_APP gateway functions. snow sql -f is
  # stop-on-first-error, so applying the contract BEFORE the engine exists aborts
  # at the first engine reference and leaves the 30 ROUTING_PLATFORM.CONTRACT.*
  # functions uncreated (routing verbs / MCP+agent routing tools dead until a
  # second run). So provision/detect the engine first, then apply the contract.
  if obj_exists "SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;" 'ORS_SERVICE|ROUTING_GATEWAY'; then
    note "  ORS engine detected -> routing verbs LIVE"
  elif [ "$WITH_ENGINE" = "1" ]; then
    note "  ORS engine ABSENT -> provisioning natively by default (heavy)..."
    bash "$SCRIPTS/provision_engine.sh" "$CONNECTION" \
      || { echo "ERROR: engine provisioning failed"; step "3 routing" FAILED; exit 1; }
    note "  engine provisioned (ORS_SERVICE may still be building its graph; verbs go LIVE once RUNNING)"
  else
    note "  ORS engine ABSENT + --no-engine -> routing verbs install inert."
    note "  To enable live routing, re-run without --no-engine. See references/routing-engine.md"
  fi
  # Apply the engine-agnostic routing contract AFTER the engine so all referenced
  # objects (REGION_ORS_MAP + gateway functions) exist and every CONTRACT.* verb
  # compiles. Engine functions exist as soon as the SQL modules load (independent
  # of the async graph build), so this is safe immediately post-provision. When
  # the engine is skipped (--no-engine) the contract still runs best-effort
  # and installs inert, matching the note above.
  if [ -f "$ROUTING_SETUP" ]; then
    snow sql -c "$CONNECTION" -f "$ROUTING_SETUP" >/tmp/ifa_contract.log 2>&1 \
      || note "  WARN: routing contract setup reported errors (engine absent? see /tmp/ifa_contract.log)"
  fi
  # ROUTING_TOOLS.TOOL_* substrate: the synapse routing verbs installed in step 5
  # (OPENROUTESERVICE_APP.ROUTING.GET_DIRECTIONS, etc.) CALL these 9 procs. They
  # depend on the contract above (ROUTING_PLATFORM.CONTRACT.*), so deploy them
  # AFTER the contract and BEFORE the verbs/agents. Idempotent (CREATE OR REPLACE).
  if [ -f "$ROUTING_TOOLS_SQL" ]; then
    note "  deploying ROUTING_TOOLS.TOOL_* substrate (routing verb dependency)..."
    snow sql -c "$CONNECTION" -f "$ROUTING_TOOLS_SQL" >/tmp/ifa_routing_tools.log 2>&1 \
      || note "  WARN: ROUTING_TOOLS substrate reported errors; see /tmp/ifa_routing_tools.log"
    # Assert all 9 TOOL_* procs exist. Non-fatal by design (matches the
    # best-effort routing step), but a shortfall is recorded in ROUTING_SUBSTRATE
    # so the friction log AND the final summary highlight it loudly instead of it
    # surfacing as a silent "routing service issues" at agent runtime.
    TOOL_N=$(snow sql -c "$CONNECTION" --format=CSV -q \
      "SELECT COUNT(*) FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA='ROUTING_TOOLS' AND STARTSWITH(PROCEDURE_NAME,'TOOL_');" \
      2>/dev/null | grep -Eo '^[0-9]+' | head -1 || echo 0)
    if [ "${TOOL_N:-0}" -lt 9 ]; then
      ROUTING_SUBSTRATE="DEGRADED: only ${TOOL_N:-0}/9 ROUTING_TOOLS.TOOL_* procs deployed — routing verbs will fail at agent runtime (see /tmp/ifa_routing_tools.log)"
      note "  WARN: $ROUTING_SUBSTRATE"
    else
      ROUTING_SUBSTRATE="OK (9/9 ROUTING_TOOLS.TOOL_* procs)"
      note "  ROUTING_TOOLS substrate $ROUTING_SUBSTRATE"
    fi
  else
    ROUTING_SUBSTRATE="MISSING SOURCE: $ROUTING_TOOLS_SQL not found — routing verbs will fail"
    note "  WARN: $ROUTING_SUBSTRATE"
  fi
  step "3 routing" OK
else
  step "3 routing" SKIPPED
  ROUTING_SUBSTRATE="SKIPPED (SKIP_ROUTING=1)"
fi

# ── 3.5 analytic layer (agnostic FLEET_INTELLIGENCE.* objects the packs read) ──
# Authors the analytic objects the demo packs read that the pack DDL does NOT
# build itself: DWELL_ANALYSIS.CONFIG, ROUTE_DEVIATION CONFIG + projection views +
# TRIP_DEVIATION_ANALYSIS (a plain VIEW, no DT refresh), the ROUTE_OPTIMIZATION
# CONFIG safety-net, and the Overture-sourced CATCHMENT tables. Runs AFTER the
# engine (so REGION_CATALOG boundaries exist) and BEFORE packs. Best-effort: a
# catchment failure (no Overture coverage) must not abort the install.
if [ "${SKIP_ANALYTIC:-0}" != "1" ]; then
  note "[3.5/8] analytic layer (dwell/route_deviation views + Overture catchment)..."
  snow sql -c "$CONNECTION" -f "$ANALYTIC_SQL" >/tmp/ifa_analytic.log 2>&1 \
    || note "  WARN: analytic layer reported errors (catchment may need Overture coverage); see /tmp/ifa_analytic.log"
  step "3.5 analytic" OK
else
  step "3.5 analytic" SKIPPED
fi

# ── 4. data-contract packs (ALL 7 agnostic packs, unconditional) ──
if [ "${SKIP_PACKS:-0}" != "1" ]; then
  note "[4/8] installing agnostic FLEET_APP packs..."
  # Pack setup.sql (and the neutral substrate) GRANT to the FLEET_APP_* roles,
  # which are pre-created in step 0.5 (before step 3) so every GRANT target exists.
  # The FULL role binding (object grants + QUERY_DYNAMIC) runs in step 6 after packs.
  python3 "$PACKS_INSTALL" --regenerate -c "$CONNECTION" >/tmp/ifa_packs.log 2>&1 \
    || { echo "ERROR: pack install failed"; tail -40 /tmp/ifa_packs.log; step "4 packs" FAILED; exit 1; }
  python3 "$PACKS_INSTALL" --probe -c "$CONNECTION" 2>/dev/null | tail -20 || true
  step "4 packs" OK
else
  step "4 packs" SKIPPED
fi

# ── 4.5 semantic views (Cortex Analyst SVs the consumer agent binds to) ──
# Authors FLEET_INTELLIGENCE.SEMANTIC + the 5 agnostic SVs that FLEET_AGENT's
# cortex_analyst_text_to_sql tools reference (agent-spec.json). Without this the
# agent fails every question with "Schema 'FLEET_INTELLIGENCE.SEMANTIC' does not
# exist". Runs AFTER packs (binds DWELL/ASSET_VELOCITY onto the pack-built
# FLEET_APP.* views) and the analytic layer (ROUTE_DEVIATION + CATCHMENT sources),
# and BEFORE roles (step 6 grants SELECT on these SVs) and agents (step 7).
# Idempotent (CREATE OR REPLACE). Best-effort: a single SV failure (e.g. CATCHMENT
# without Overture coverage) must not abort the install.
if [ "${SKIP_SEMANTIC:-0}" != "1" ]; then
  note "[4.5/8] creating Cortex Analyst semantic views (FLEET_INTELLIGENCE.SEMANTIC)..."
  snow sql -c "$CONNECTION" -f "$SEMANTIC_VIEWS_SQL" >/tmp/ifa_semantic.log 2>&1 \
    || note "  WARN: some semantic views failed (missing source views?); see /tmp/ifa_semantic.log"
  step "4.5 semantic" OK
else
  step "4.5 semantic" SKIPPED
fi

# ── 5. synapse tool bundles ─────────────────────────────────────
if [ "${SKIP_TOOLS:-0}" != "1" ]; then
  note "[5/8] installing synapse tool bundles..."
  bash "$SCRIPTS/install_synapse_bundles.sh" "$CONNECTION" \
    || { echo "ERROR: synapse bundle install failed"; step "5 tools" FAILED; exit 1; }
  step "5 tools" OK
else
  step "5 tools" SKIPPED
fi

# ── 6. agents ───────────────────────────────────────────────────
if [ "${SKIP_AGENTS:-0}" != "1" ]; then
  note "[6/8] creating FLEET_AGENT + FLEET_OPS_AGENT..."
  bash "$SCRIPTS/create_agents.sh" "$CONNECTION" \
    || { echo "ERROR: agent creation failed"; step "6 agents" FAILED; exit 1; }
  step "6 agents" OK
else
  step "6 agents" SKIPPED
fi

# ── 7. apps (resolved infra threaded via exported env) ──────────
SA_URL=""; ADMIN_URL=""
if [ "${SKIP_APPS:-0}" != "1" ]; then
  note "[7/8] deploying FLEET_SA_APP + FLEET_ADMIN_APP..."
  # Defensive: the infra step always resolves COMPUTE_POOL now, but guard anyway
  # so a future regression fails loudly here instead of as an opaque unbound-var.
  : "${COMPUTE_POOL:?COMPUTE_POOL is unset — the infra step (1/8) must resolve it before apps}"
  bash "$SCRIPTS/deploy_fleet_sa_app.sh" "$CONNECTION" \
    || { echo "ERROR: SA app deploy failed"; step "7 apps" FAILED; exit 1; }
  COMPUTE_POOL="$COMPUTE_POOL" bash "$SCRIPTS/deploy_fleet_admin_app.sh" "$CONNECTION" \
    || { echo "ERROR: admin app deploy failed"; step "7 apps" FAILED; exit 1; }
  SA_URL=$(snow sql -c "$CONNECTION" --format=CSV -q "SHOW ENDPOINTS IN SERVICE FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP; SELECT 'https://'||\"ingress_url\" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE \"name\"='fleet-sa-app';" 2>/dev/null | grep -E '^https://' | head -1 || true)
  ADMIN_URL=$(snow sql -c "$CONNECTION" --format=CSV -q "SHOW ENDPOINTS IN SERVICE FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_APP; SELECT 'https://'||\"ingress_url\" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE \"name\"='fleet-admin-app';" 2>/dev/null | grep -E '^https://' | head -1 || true)
  step "7 apps" OK
else
  step "7 apps" SKIPPED
fi

# ── roles + grants (LAST: depends on SYNAPSE_USER objects from steps 7-8) ──
# role_binding.sql grants USAGE on the 3 agents (step 7) and the
# FLEET_SA_APP!ALL_ENDPOINTS_USAGE service role (step 8), all in
# FLEET_INTELLIGENCE.SYNAPSE_USER. Running it earlier failed those grants on a
# fresh install ("Schema ... SYNAPSE_USER does not exist"). It is fully
# idempotent (no DROP/REVOKE), so this single authoritative pass after apps is
# correct on both fresh installs and re-runs. Stays gated by SKIP_ROLES and
# OUTSIDE the apps block so it still runs under SKIP_APPS=1 (apps pre-exist).
if [ "${SKIP_ROLES:-0}" != "1" ]; then
  note "[8/8] applying roles + grants (all objects present)..."
  snow sql -c "$CONNECTION" -f "$ROLE_BINDING" >/tmp/ifa_roles.log 2>&1 \
    || note "  WARN: some grants failed; see /tmp/ifa_roles.log"
  step "8 roles" OK
else
  step "8 roles" SKIPPED
fi

# ── friction log + summary ──────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_TS ))
{
  echo "# install-fleet-apps friction log — $(date)"
  echo
  echo "- connection: \`$CONNECTION\`  account: \`$(snow sql -c "$CONNECTION" --format=CSV -q 'SELECT CURRENT_ACCOUNT();' 2>/dev/null | tail -1)\`"
  echo "- total duration: ${ELAPSED}s"
  echo "- infra: repo=$IMAGE_REPO_SQL_NAME pool=$COMPUTE_POOL eai=$CARTO_EAI,$OSM_EAI stage=$SPEC_STAGE_NAME"
  [ -n "$SA_URL" ]    && echo "- SA app:    $SA_URL"
  [ -n "$ADMIN_URL" ] && echo "- Admin app: $ADMIN_URL"
  echo
  echo "| Step | Status |"
  echo "|------|--------|"
  for s in "${STEP_STATUS[@]}"; do echo "| ${s%%|*} | ${s##*|} |"; done
  echo
  echo "## Routing tool substrate"
  echo "- ROUTING_TOOLS.TOOL_* (routing verb dependency): **${ROUTING_SUBSTRATE}**"
  case "$ROUTING_SUBSTRATE" in
    OK*) : ;;
    *) echo "- ACTION: routing verbs (get_directions, optimize_routes, ...) depend on these procs; re-run \`routing-agent/references/deploy-agent.sql\` against \`$CONNECTION\` to restore them." ;;
  esac
  echo
  echo "## Friction points"
  echo "_None recorded automatically. Add manual observations here._"
} > "$FRICTION_LOG"

echo
echo "================================================================"
echo " install-fleet-apps complete (${ELAPSED}s)"
[ -n "$SA_URL" ]    && echo "   SA app:    $SA_URL"
[ -n "$ADMIN_URL" ] && echo "   Admin app: $ADMIN_URL"
case "$ROUTING_SUBSTRATE" in
  OK*)       echo "   routing substrate: $ROUTING_SUBSTRATE" ;;
  SKIPPED*)  echo "   routing substrate: $ROUTING_SUBSTRATE" ;;
  *)         echo "   !! ROUTING SUBSTRATE DEGRADED: $ROUTING_SUBSTRATE" ;;
esac
echo "   friction log: $FRICTION_LOG"
echo "================================================================"
