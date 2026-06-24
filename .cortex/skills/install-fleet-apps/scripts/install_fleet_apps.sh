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
#   -> 5 synapse tools -> 6 roles -> 7 agents -> 8 apps -> friction log
#
# Usage:
#   bash .cortex/skills/install-fleet-apps/scripts/install_fleet_apps.sh --connection <conn>
#
# Flags (re-run shortcuts only; there is NO use-case selection):
#   --connection <name>   REQUIRED. Snow CLI connection.
#   --with-engine         OPTIONAL. When the ORS engine is absent, build + provision
#                         it natively (heavy: 4 SPCS images + a region graph, tens of
#                         minutes). Also honored via PROVISION_ENGINE=1.
#   SKIP_INFRA=1 SKIP_DATA=1 SKIP_ANALYTIC=1 SKIP_ROUTING=1 SKIP_PACKS=1 SKIP_TOOLS=1
#   SKIP_ROLES=1 SKIP_AGENTS=1 SKIP_APPS=1   (env vars)
set -euo pipefail

# ── arg parse ───────────────────────────────────────────────────
CONNECTION=""
WITH_ENGINE="${PROVISION_ENGINE:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --connection) CONNECTION="${2:-}"; shift 2;;
    --connection=*) CONNECTION="${1#*=}"; shift;;
    --with-engine) WITH_ENGINE=1; shift;;
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
ANALYTIC_SQL="$SCRIPTS/analytic_layer.sql"
START_TS=$(date +%s)
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

# ── 1. infra (reuse OPENROUTESERVICE_APP else self-provision FLEET-owned) ──
export IMAGE_REPO_SQL_NAME COMPUTE_POOL CARTO_EAI SPEC_STAGE_NAME
if [ "${SKIP_INFRA:-0}" != "1" ]; then
  note "[1/8] resolving SPCS infra..."
  if obj_exists "SHOW IMAGE REPOSITORIES IN SCHEMA OPENROUTESERVICE_APP.CORE;" 'image_repository' \
     && obj_exists "SHOW COMPUTE POOLS LIKE 'OPENROUTESERVICE_APP_COMPUTE_POOL';" 'OPENROUTESERVICE_APP_COMPUTE_POOL' \
     && obj_exists "SHOW EXTERNAL ACCESS INTEGRATIONS LIKE 'ORS_CARTO_EAI';" 'ORS_CARTO_EAI'; then
    note "  reusing OPENROUTESERVICE_APP infra"
    IMAGE_REPO_SQL_NAME="OPENROUTESERVICE_APP.core.image_repository"
    COMPUTE_POOL="OPENROUTESERVICE_APP_COMPUTE_POOL"
    CARTO_EAI="ORS_CARTO_EAI"
    SPEC_STAGE_NAME="OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE"
  else
    note "  self-provisioning FLEET-owned infra (references/infra.sql)"
    snow sql -c "$CONNECTION" -f "$REF/infra.sql" >/tmp/ifa_infra.log 2>&1 \
      || { echo "ERROR: infra provisioning failed"; tail -30 /tmp/ifa_infra.log; step "1 infra" FAILED; exit 1; }
    IMAGE_REPO_SQL_NAME="FLEET_INTELLIGENCE.CORE.IMAGE_REPOSITORY"
    COMPUTE_POOL="FLEET_APPS_COMPUTE_POOL"
    CARTO_EAI="FLEET_APP_CARTO_EAI"
    SPEC_STAGE_NAME="FLEET_INTELLIGENCE.CORE.FLEET_SPEC_STAGE"
  fi
  note "  infra: repo=$IMAGE_REPO_SQL_NAME pool=$COMPUTE_POOL eai=$CARTO_EAI stage=$SPEC_STAGE_NAME"
  step "1 infra" OK
else
  step "1 infra" SKIPPED
fi

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
    snow stage copy "$REPO_ROOT/datasets/" @FLEET_INTELLIGENCE.CORE.SEED_DATA_STAGE/ -c "$CONNECTION" --overwrite --recursive >/tmp/ifa_stage.log 2>&1 \
      || { echo "ERROR: staging seed parquet failed"; tail -20 /tmp/ifa_stage.log; step "2 data" FAILED; exit 1; }
    sed 's|OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE|FLEET_INTELLIGENCE.CORE.SEED_DATA_STAGE|g; s|OPENROUTESERVICE_APP.CORE.PARQUET_FF|FLEET_INTELLIGENCE.CORE.PARQUET_FF|g' \
      "$REPO_ROOT/datasets/load-seed-data.sql" > /tmp/ifa_loader.sql
    snow sql -c "$CONNECTION" -f /tmp/ifa_loader.sql >/tmp/ifa_load.log 2>&1 \
      || note "  WARN: canonical loader reported errors (some engine-only sections may not apply); continuing"
    snow sql -c "$CONNECTION" -f "$SCRIPTS/seed_data.sql" >/tmp/ifa_purge.log 2>&1 || true
  fi
  # Vehicle-profile catalog (DIM_VEHICLE_PROFILE / DIM_VEHICLE_DWELL_SLA) + the
  # DIM_FLEET asset-column stamp the unified_fleet/dwell packs + scoped_contract
  # need. SQL port of the admin-app Studio TS so a from-scratch install does not
  # need the admin app to boot first. MUST run BEFORE projection_views.sql because
  # it drops V_DIM_FLEET_CURRENT (SELECT f.*) to ALTER DIM_FLEET. Idempotent.
  snow sql -c "$CONNECTION" -f "$SCRIPTS/vehicle_profile_catalog.sql" >/tmp/ifa_vpcatalog.log 2>&1 \
    || note "  WARN: vehicle-profile catalog seed reported errors (see /tmp/ifa_vpcatalog.log)"
  # Agnostic V_*_CURRENT projection views (the packs bind to these). Authored here
  # in SQL because the agnostic install does not run the admin-app boot (init.ts)
  # before the pack step. Idempotent; safe whether seeding ran or data was reused.
  snow sql -c "$CONNECTION" -f "$SCRIPTS/projection_views.sql" >/tmp/ifa_projviews.log 2>&1 \
    || note "  WARN: projection-view creation reported errors (see /tmp/ifa_projviews.log)"
  step "2 data" OK
else
  step "2 data" SKIPPED
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
    note "  ORS engine ABSENT + --with-engine set -> provisioning natively (heavy)..."
    bash "$SCRIPTS/provision_engine.sh" "$CONNECTION" \
      || { echo "ERROR: engine provisioning failed"; step "3 routing" FAILED; exit 1; }
    note "  engine provisioned (ORS_SERVICE may still be building its graph; verbs go LIVE once RUNNING)"
  else
    note "  ORS engine ABSENT -> routing verbs install inert."
    note "  To enable live routing, re-run with --with-engine. See references/routing-engine.md"
  fi
  # Apply the engine-agnostic routing contract AFTER the engine so all referenced
  # objects (REGION_ORS_MAP + gateway functions) exist and every CONTRACT.* verb
  # compiles. Engine functions exist as soon as the SQL modules load (independent
  # of the async graph build), so this is safe immediately post-provision. When
  # the engine is absent (no --with-engine) the contract still runs best-effort
  # and installs inert, matching the note above.
  if [ -f "$ROUTING_SETUP" ]; then
    snow sql -c "$CONNECTION" -f "$ROUTING_SETUP" >/tmp/ifa_contract.log 2>&1 \
      || note "  WARN: routing contract setup reported errors (engine absent? see /tmp/ifa_contract.log)"
  fi
  step "3 routing" OK
else
  step "3 routing" SKIPPED
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
  # Pack setup.sql (and the neutral substrate) GRANT to the FLEET_APP_* roles. The
  # FULL role binding (object grants + QUERY_DYNAMIC, which needs FLEET_APP.CORE) runs
  # in step 6 AFTER packs, so just ensure the role names exist here (idempotent) to
  # break the circular dependency (pack grants <-> role binding).
  snow sql -c "$CONNECTION" -q "
    CREATE ROLE IF NOT EXISTS FLEET_APP_USER;
    CREATE ROLE IF NOT EXISTS FLEET_APP_OPS;
    CREATE ROLE IF NOT EXISTS FLEET_APP_ADMIN;
    CREATE ROLE IF NOT EXISTS FLEET_APP_DYNAMIC_READER;
  " >/tmp/ifa_preroles.log 2>&1 || note "  WARN: role pre-create reported errors (see /tmp/ifa_preroles.log)"
  python3 "$PACKS_INSTALL" --regenerate -c "$CONNECTION" >/tmp/ifa_packs.log 2>&1 \
    || { echo "ERROR: pack install failed"; tail -40 /tmp/ifa_packs.log; step "4 packs" FAILED; exit 1; }
  python3 "$PACKS_INSTALL" --probe -c "$CONNECTION" 2>/dev/null | tail -20 || true
  step "4 packs" OK
else
  step "4 packs" SKIPPED
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

# ── 6. roles + grants ───────────────────────────────────────────
if [ "${SKIP_ROLES:-0}" != "1" ]; then
  note "[6/8] applying roles + grants..."
  snow sql -c "$CONNECTION" -f "$ROLE_BINDING" >/tmp/ifa_roles.log 2>&1 \
    || note "  WARN: some grants failed (objects may not exist yet); see /tmp/ifa_roles.log"
  step "6 roles" OK
else
  step "6 roles" SKIPPED
fi

# ── 7. agents ───────────────────────────────────────────────────
if [ "${SKIP_AGENTS:-0}" != "1" ]; then
  note "[7/8] creating FLEET_AGENT + FLEET_OPS_AGENT..."
  bash "$SCRIPTS/create_agents.sh" "$CONNECTION" \
    || { echo "ERROR: agent creation failed"; step "7 agents" FAILED; exit 1; }
  step "7 agents" OK
else
  step "7 agents" SKIPPED
fi

# ── 8. apps (resolved infra threaded via exported env) ──────────
SA_URL=""; ADMIN_URL=""
if [ "${SKIP_APPS:-0}" != "1" ]; then
  note "[8/8] deploying FLEET_SA_APP + FLEET_ADMIN_APP..."
  bash "$SCRIPTS/deploy_fleet_sa_app.sh" "$CONNECTION" \
    || { echo "ERROR: SA app deploy failed"; step "8 apps" FAILED; exit 1; }
  COMPUTE_POOL="$COMPUTE_POOL" bash "$SCRIPTS/deploy_fleet_admin_app.sh" "$CONNECTION" \
    || { echo "ERROR: admin app deploy failed"; step "8 apps" FAILED; exit 1; }
  SA_URL=$(snow sql -c "$CONNECTION" --format=CSV -q "SHOW ENDPOINTS IN SERVICE FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP; SELECT 'https://'||\"ingress_url\" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE \"name\"='fleet-sa-app';" 2>/dev/null | grep -E '^https://' | head -1 || true)
  ADMIN_URL=$(snow sql -c "$CONNECTION" --format=CSV -q "SHOW ENDPOINTS IN SERVICE FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_APP; SELECT 'https://'||\"ingress_url\" FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) WHERE \"name\"='fleet-admin-app';" 2>/dev/null | grep -E '^https://' | head -1 || true)
  step "8 apps" OK
else
  step "8 apps" SKIPPED
fi

# ── friction log + summary ──────────────────────────────────────
ELAPSED=$(( $(date +%s) - START_TS ))
{
  echo "# install-fleet-apps friction log — $(date)"
  echo
  echo "- connection: \`$CONNECTION\`  account: \`$(snow sql -c "$CONNECTION" --format=CSV -q 'SELECT CURRENT_ACCOUNT();' 2>/dev/null | tail -1)\`"
  echo "- total duration: ${ELAPSED}s"
  echo "- infra: repo=$IMAGE_REPO_SQL_NAME pool=$COMPUTE_POOL eai=$CARTO_EAI stage=$SPEC_STAGE_NAME"
  [ -n "$SA_URL" ]    && echo "- SA app:    $SA_URL"
  [ -n "$ADMIN_URL" ] && echo "- Admin app: $ADMIN_URL"
  echo
  echo "| Step | Status |"
  echo "|------|--------|"
  for s in "${STEP_STATUS[@]}"; do echo "| ${s%%|*} | ${s##*|} |"; done
  echo
  echo "## Friction points"
  echo "_None recorded automatically. Add manual observations here._"
} > "$FRICTION_LOG"

echo
echo "================================================================"
echo " install-fleet-apps complete (${ELAPSED}s)"
[ -n "$SA_URL" ]    && echo "   SA app:    $SA_URL"
[ -n "$ADMIN_URL" ] && echo "   Admin app: $ADMIN_URL"
echo "   friction log: $FRICTION_LOG"
echo "================================================================"
