#!/usr/bin/env bash
# =============================================================================
# install-fleet-apps : post-install deployment verification
# =============================================================================
# Answers "does this deployment actually match what the installer claimed?"
#
# Why this exists
# ---------------
# The installer verified that objects were CREATED, and validate_app_views.py
# verifies that app views RETURN ROWS, but nothing asserted that the deployment is
# COHERENT - that the surfaces the apps present are actually backed by objects
# that exist. The gap was not theoretical: three consecutive installs were
# reported "clean" while the entire routing engine was absent, because
#
#   * `--no-engine` skips provision_engine.sh, so OPENROUTESERVICE_APP.CORE ends
#     up with ZERO functions while the database itself still exists (a stub is
#     landed by seed_data.sql and again by the synapse bundle install), so any
#     "does the database exist" probe passes;
#   * the admin app's Service Manager and Region Builder read those functions, so
#     they showed ERROR / Unhealthy / "0 / 0 running" / "No services found";
#   * the installer's own summary said "all steps OK".
#
# This script probes the exact contract those pages depend on, grouped by the
# user-visible surface each object defends, so a failure names the page that will
# break rather than an object nobody recognises.
#
# MODE IS THE POINT. `--no-engine` is a legitimate, documented install mode, so
# a missing engine is not automatically a defect - it is only a defect when it
# contradicts what the install claimed. Pass the mode and severity follows:
#
#   --expect-engine           engine objects missing => BLOCKING
#   --expect-analytics-only   engine objects missing => DEGRADED (expected)
#
# The analytic-tail probes are BLOCKING in BOTH modes. Those objects need no
# engine, and they were the collateral damage of the abort this fix removed; if
# they are missing again, the split has regressed.
#
# Read-only. Every probe is a SELECT / SHOW / CALL of a read-only procedure.
#
# Usage:  bash verify_deployment.sh [-c CONNECTION] [--expect-engine|--expect-analytics-only]
# Exit:   0 = deployment matches the declared mode
#         1 = BLOCKING mismatch (deployment contradicts its own mode)
#         2 = matches, with degraded surfaces (expected in analytics-only mode)
# =============================================================================
set -uo pipefail

CONNECTION="${CONNECTION:-fleet_test_evals}"
# Default to the installer's own default (engine on) so a bare invocation holds the
# deployment to the STRICTER contract. Defaulting to analytics-only would let the
# exact failure this script exists to catch pass silently.
EXPECT_ENGINE=1
while [ $# -gt 0 ]; do
  case "$1" in
    -c|--connection)         CONNECTION="$2"; shift 2 ;;
    --expect-engine)         EXPECT_ENGINE=1; shift ;;
    --expect-analytics-only) EXPECT_ENGINE=0; shift ;;
    -h|--help)               sed -n '2,44p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

BLOCKING=0
DEGRADED=0
pass() { printf '  OK        %s\n' "$1"; }
warn() { printf '  DEGRADED  %s\n' "$1"; DEGRADED=1; }
fail() { printf '  BLOCKING  %s\n' "$1"; BLOCKING=1; }

# An engine-object miss is DEGRADED in analytics-only mode and BLOCKING when the
# install claimed an engine. Routing every engine probe through one helper keeps
# that decision in a single place.
engine_miss() {
  if [ "$EXPECT_ENGINE" = "1" ]; then fail "$1"; else warn "$1"; fi
}

# Each `snow sql` invocation is a new session, so the AGENTS.md-mandated query_tag
# is prepended inside the helpers rather than set once up front.
TRACK='{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"verify-deployment"}}'
TAG_SQL="ALTER SESSION SET query_tag = '$TRACK';"

q()  { snow sql -c "$CONNECTION" -q "$TAG_SQL $1" 2>&1; }
# CSV is MANDATORY for SHOW: the default fixed-width renderer squeezes a wide
# result until every cell is blank, so a substring test finds nothing and reports
# a populated account as empty. See preflight_new_account.sh for the full story.
qc() { snow sql -c "$CONNECTION" --format csv -q "$TAG_SQL $1" 2>&1; }

# Substring test on a VARIABLE, never `... | grep -q ...`: under pipefail, grep -q
# closes the pipe early, snow dies of SIGPIPE and the pipeline reports failure even
# though the pattern matched.
has()   { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
has_i() {
  local hay low_needle
  hay=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  low_needle=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  case "$hay" in *"$low_needle"*) return 0 ;; *) return 1 ;; esac
}
# Scalar SELECT -> bare value. Picks the last `| <value> |` row so the leading
# "Statement executed successfully." block from the prepended tag is skipped.
scalar() { printf '%s' "$(q "$1" | grep -E '^\| ' | tail -1 | sed 's/^| *//; s/ *|.*$//')"; }

# A probe "resolved" unless the error names a missing object. This mirrors the
# admin app's own healthcheck classification (/api/regions/healthcheck), which
# treats /does not exist|not authorized|unknown function/i as `missing` and any
# other error as `error` - so a permission problem is never reported as absence.
missing_obj() {
  has_i "$1" "does not exist" || has_i "$1" "not authorized" \
    || has_i "$1" "unknown function" || has_i "$1" "unknown user-defined"
}

MODE_LABEL=$([ "$EXPECT_ENGINE" = "1" ] && echo "engine expected" || echo "analytics-only")
echo "=== install-fleet-apps deployment verification (connection=$CONNECTION, $MODE_LABEL)"

OUT=$(q "SELECT CURRENT_ACCOUNT() AS A, CURRENT_ROLE() AS R;")
if has_i "$OUT" "error" && ! has "$OUT" "|"; then
  echo "  BLOCKING  connection '$CONNECTION' does not work"
  echo; echo "RESULT: BLOCKING - cannot verify."; exit 1
fi

# --- 1. routing seam ---------------------------------------------------------
# The single probe that would have caught the silent half-install. The database
# EXISTS on an engine-less account (stub + synapse bundle), so only a FUNCTION
# count distinguishes a real engine from a shell.
echo
echo "[1] routing engine seam"
ENGINE_FNS=$(scalar "SELECT COUNT(*) FROM OPENROUTESERVICE_APP.INFORMATION_SCHEMA.FUNCTIONS;")
case "$ENGINE_FNS" in
  ''|*[!0-9]*) engine_miss "cannot count OPENROUTESERVICE_APP.CORE functions (database absent?)" ;;
  0)           engine_miss "OPENROUTESERVICE_APP.CORE has 0 FUNCTIONS - the engine SQL modules never loaded (run provision_engine.sh)" ;;
  *)
    # 02_routing_functions.sql alone defines ~37; a handful means a partial load.
    if [ "$ENGINE_FNS" -lt 20 ]; then
      engine_miss "OPENROUTESERVICE_APP.CORE has only $ENGINE_FNS functions - expected ~40, so the module load was partial"
    else
      pass "OPENROUTESERVICE_APP.CORE functions present ($ENGINE_FNS)"
    fi ;;
esac

# The routing contract is applied best-effort by the installer and, before this
# script, was never counted afterwards - so a silently-empty seam looked fine.
CONTRACT_FNS=$(scalar "SELECT COUNT(*) FROM ROUTING_PLATFORM.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA='CONTRACT';")
case "$CONTRACT_FNS" in
  ''|*[!0-9]*) engine_miss "ROUTING_PLATFORM.CONTRACT not queryable (database absent?)" ;;
  0)           engine_miss "ROUTING_PLATFORM.CONTRACT has 0 functions - the engine-neutral seam is empty" ;;
  *)           pass "ROUTING_PLATFORM.CONTRACT functions present ($CONTRACT_FNS)" ;;
esac

# TOOL_* procs are engine-INDEPENDENT (they install inert), so this is blocking in
# both modes: the installer asserts 11 and the agent's routing verbs wrap them.
TOOL_PROCS=$(scalar "SELECT COUNT(*) FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA='ROUTING_TOOLS' AND STARTSWITH(PROCEDURE_NAME,'TOOL_');")
case "$TOOL_PROCS" in
  ''|*[!0-9]*) fail "cannot count FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_* procedures" ;;
  *) if [ "$TOOL_PROCS" -lt 11 ]; then
       fail "only $TOOL_PROCS/11 ROUTING_TOOLS.TOOL_* procedures - every agent routing request will fail"
     else pass "ROUTING_TOOLS.TOOL_* procedures present ($TOOL_PROCS)"; fi ;;
esac

# --- 2. Region Builder banner ------------------------------------------------
# The five keys from fleet_admin_app/ui/src/app/api/regions/healthcheck/route.ts,
# using that route's exact SQL. `build_spec` deliberately calls the 3-arg overload:
# two overloads exist, so a name-only check would pass while the app's call fails.
echo
echo "[2] Region Builder healthcheck (admin app banner)"
hc() { # hc <key> <sql>
  local out; out=$(q "$2")
  if missing_obj "$out"; then engine_miss "healthcheck '$1' -> MISSING"
  elif has_i "$out" "error";  then engine_miss "healthcheck '$1' -> ERROR"
  else pass "healthcheck '$1' resolves"; fi
}
hc resolver       "CALL OPENROUTESERVICE_APP.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY();"
hc retry_strategy "CALL OPENROUTESERVICE_APP.CORE.RECOMMEND_RETRY_STRATEGY('__HEALTHCHECK__');"
hc build_history  "SELECT 1 FROM OPENROUTESERVICE_APP.CORE.ORS_BUILD_HISTORY LIMIT 1;"
hc build_spec     "SELECT OPENROUTESERVICE_APP.CORE.BUILD_ORS_SERVICE_SPEC('X','XXL','false');"
DS=$(qc "SHOW PROCEDURES LIKE 'DOWNSIZE_REGION_AFTER_BUILD' IN SCHEMA OPENROUTESERVICE_APP.CORE;")
if has_i "$DS" "DOWNSIZE_REGION_AFTER_BUILD"; then pass "healthcheck 'downsize_proc' resolves"
else engine_miss "healthcheck 'downsize_proc' -> MISSING"; fi

# --- 3. Service Manager tiles ------------------------------------------------
echo
echo "[3] Service Manager tiles (admin app)"
ST=$(q "CALL OPENROUTESERVICE_APP.CORE.GET_STATUS();")
if missing_obj "$ST"; then engine_miss "GET_STATUS() MISSING -> 'Compute Pool' reads ERROR and 'Services' reads 0 / 0"
elif has_i "$ST" "error"; then engine_miss "GET_STATUS() errored -> Compute Pool / Services tiles broken"
else pass "GET_STATUS() resolves (Compute Pool + Services tiles)"; fi

# health/route.ts hardcodes these two SanFrancisco service names, so the ORS Health
# tile is structurally SanFrancisco-only regardless of which regions exist. Assert
# the literal names the app asks for, not a per-region derived set.
for SVC in ORS_SERVICE_SANFRANCISCO VROOM_SERVICE_SANFRANCISCO ROUTING_GATEWAY_SERVICE; do
  SS=$(qc "SHOW SERVICES LIKE '$SVC' IN SCHEMA OPENROUTESERVICE_APP.CORE;")
  if has_i "$SS" "$SVC"; then
    if has_i "$SS" "RUNNING"; then pass "service $SVC RUNNING"
    else warn "service $SVC exists but is not RUNNING (suspended is normal when idle; resume before a demo)"; fi
  else engine_miss "service $SVC absent -> 'ORS Health' reads Unhealthy"; fi
done

VI=$(q "SELECT COUNT(*) FROM OPENROUTESERVICE_APP.CORE.VERSION_INFO;")
if missing_obj "$VI"; then engine_miss "VERSION_INFO absent -> ORS Health tile cannot report versions"
else pass "VERSION_INFO present"; fi

LR=$(q "CALL OPENROUTESERVICE_APP.CORE.LIST_REGIONS();")
if missing_obj "$LR"; then engine_miss "LIST_REGIONS() MISSING -> 'Graphs' tile and the region picker are empty"
else pass "LIST_REGIONS() resolves (Graphs tile + region picker)"; fi

for STG in ORS_SPCS_STAGE ORS_GRAPHS_SPCS_STAGE; do
  SG=$(qc "SHOW STAGES LIKE '$STG' IN SCHEMA OPENROUTESERVICE_APP.CORE;")
  if has_i "$SG" "$STG"; then pass "stage $STG present"
  else engine_miss "stage $STG absent -> 'Graphs' tile cannot list graph files"; fi
done

# --- 4. analytic tail (engine-free; BLOCKING in both modes) -------------------
# These are the objects the analytic_layer.sql abort used to discard. None needs
# the engine, so absence here means the engine-free/live-routing split regressed -
# which is exactly the defect this script was added to make permanently visible.
echo
echo "[4] analytic layer tail (engine-free - must exist in EVERY mode)"
tail_count() { # tail_count <label> <min> <sql> <remedy>
  local n; n=$(scalar "$3")
  case "$n" in
    ''|*[!0-9]*) fail "$1: not queryable - $4" ;;
    *) if [ "$n" -lt "$2" ]; then fail "$1: $n (expected >= $2) - $4"
       else pass "$1 present ($n)"; fi ;;
  esac
}
tail_count "FLEET_INTELLIGENCE.SOURCING tables" 6 \
  "SELECT COUNT(*) FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='SOURCING';" \
  "analytic_layer.sql aborted before its SOURCING section; re-run it and check check_engine_guards.py"
tail_count "FLEET_APP.SOURCING views" 9 \
  "SELECT COUNT(*) FROM FLEET_APP.INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA='SOURCING';" \
  "analytic_layer.sql aborted before its FLEET_APP.SOURCING views"
tail_count "FLEET_APP.LOCATION views" 5 \
  "SELECT COUNT(*) FROM FLEET_APP.INFORMATION_SCHEMA.VIEWS WHERE TABLE_SCHEMA='LOCATION';" \
  "analytic_layer.sql aborted before its LOCATION passthrough views"
tail_count "FLEET_APP.CORE ORS guard functions" 3 \
  "SELECT COUNT(*) FROM FLEET_APP.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA='CORE' AND FUNCTION_NAME IN ('ORS_OK','ORS_FEATURES','ORS_MATRIX');" \
  "the suspended-engine guards are missing; live-routing views will return empty instead of raising"

# --- 5. live-routing UDTFs (engine-dependent) --------------------------------
# The other half of the split. Present only once the live-routing file has run,
# which needs the engine - so this is the mode-sensitive counterpart to section 4.
echo
echo "[5] live-routing UDTFs (require the engine)"
live_count() { # live_count <label> <min> <sql>
  local n; n=$(scalar "$3")
  case "$n" in
    ''|*[!0-9]*) engine_miss "$1: not queryable" ;;
    *) if [ "$n" -lt "$2" ]; then
         engine_miss "$1: $n (expected >= $2) - run analytic_layer_live_routing.sql after the engine is up"
       else pass "$1 present ($n)"; fi ;;
  esac
}
live_count "FLEET_APP.LOCATION LIVE_* UDTFs" 10 \
  "SELECT COUNT(*) FROM FLEET_APP.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA='LOCATION' AND STARTSWITH(FUNCTION_NAME,'LIVE_');"
live_count "FLEET_APP.CATCHMENT LIVE_* UDTFs" 3 \
  "SELECT COUNT(*) FROM FLEET_APP.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA='CATCHMENT' AND STARTSWITH(FUNCTION_NAME,'LIVE_');"
live_count "FLEET_APP.SOURCING LIVE_* UDTFs" 8 \
  "SELECT COUNT(*) FROM FLEET_APP.INFORMATION_SCHEMA.FUNCTIONS WHERE FUNCTION_SCHEMA='SOURCING' AND STARTSWITH(FUNCTION_NAME,'LIVE_');"

# --- 6. consumer surfaces ----------------------------------------------------
echo
echo "[6] consumer surfaces"
for SVC in FLEET_SA_APP FLEET_ADMIN_APP; do
  SS=$(qc "SHOW SERVICES LIKE '$SVC' IN SCHEMA FLEET_INTELLIGENCE.SYNAPSE_USER;")
  if has_i "$SS" "$SVC"; then
    if has_i "$SS" "RUNNING"; then pass "$SVC RUNNING"
    else warn "$SVC exists but is not RUNNING"; fi
  else fail "$SVC absent - the app was never deployed"; fi
done
AG=$(scalar "SELECT COUNT(*) FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME IN ('SYNAPSE_USER','SYNAPSE_OPS','SYNAPSE_ADMIN');")
case "$AG" in
  ''|*[!0-9]*) fail "cannot enumerate synapse bundle schemas" ;;
  3) pass "all three synapse bundle schemas present" ;;
  *) fail "only $AG/3 synapse bundle schemas - role-scoped tool isolation is incomplete" ;;
esac

# --- result ------------------------------------------------------------------
echo
if [ "$BLOCKING" = "1" ]; then
  echo "RESULT: BLOCKING - the deployment contradicts its declared mode ($MODE_LABEL)."
  if [ "$EXPECT_ENGINE" = "1" ]; then
    echo "        If this deployment is intentionally engine-less, re-run with"
    echo "        --expect-analytics-only. Otherwise build the engine:"
    echo "          bash .cortex/skills/install-fleet-apps/scripts/provision_engine.sh $CONNECTION"
  fi
  exit 1
fi
if [ "$DEGRADED" = "1" ]; then
  echo "RESULT: matches '$MODE_LABEL', with degraded surfaces (see DEGRADED lines)."
  [ "$EXPECT_ENGINE" = "0" ] && \
    echo "        Expected in analytics-only mode: Service Manager, Region Builder and every"
  [ "$EXPECT_ENGINE" = "0" ] && \
    echo "        live-routing view are non-functional until the engine is built."
  exit 2
fi
echo "RESULT: ready - deployment matches '$MODE_LABEL' with no degraded surfaces."
exit 0
