#!/usr/bin/env bash
# =============================================================================
# install-fleet-apps : fresh-account pre-flight
# =============================================================================
# Answers "will the install actually work on THIS account?" in about a minute,
# before committing to a ~90 minute run.
#
# Why this exists
# ---------------
# The install has a small number of account-level prerequisites that are invisible
# until the step that needs them fails, and one of them fails silently. The
# Overture Marketplace listings in particular are acquired inside
# analytic_layer.sql; on a brand-new account (no prior fleet history, possibly a
# different region or without marketplace access) the acquisition can fail, and
# it used to abandon the remaining ~1,400 lines of that file - emptying the
# location, sourcing and backload layers - while the installer still printed OK.
# The builders are now individually guarded, but "catchment will be empty" is
# still something you want to know BEFORE the run, not after.
#
# Read-only apart from the listing databases themselves (CREATE DATABASE ... FROM
# LISTING is the only way to test acquisition, and it is exactly what the install
# does; it is idempotent via IF NOT EXISTS).
#
# Usage:  bash preflight_new_account.sh [-c CONNECTION] [--no-listings]
# Exit:   0 = ready, 1 = blocking problem, 2 = ready with degraded features
# =============================================================================
set -uo pipefail

CONNECTION="${CONNECTION:-fleet_test_evals}"
CHECK_LISTINGS=1
while [ $# -gt 0 ]; do
  case "$1" in
    -c|--connection) CONNECTION="$2"; shift 2 ;;
    --no-listings)   CHECK_LISTINGS=0; shift ;;
    -h|--help)       sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

BLOCKING=0
DEGRADED=0
pass() { printf '  OK        %s\n' "$1"; }
warn() { printf '  DEGRADED  %s\n' "$1"; DEGRADED=1; }
fail() { printf '  BLOCKING  %s\n' "$1"; BLOCKING=1; }

# Every `snow sql` invocation opens a NEW session, so the AGENTS.md-mandated
# query_tag is prepended inside the helpers - one place covers every probe below,
# including the `CREATE DATABASE ... FROM LISTING` acquisition in step 3.
# Callers only ever substring-test this output (or match `^| <digits>`), so the
# extra leading "Statement executed successfully." block is inert here.
TRACK='{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"preflight"}}'
TAG_SQL="ALTER SESSION SET query_tag = '$TRACK';"

# One helper so every probe is a single statement whose output we can inspect.
q() { snow sql -c "$CONNECTION" -q "$TAG_SQL $1" 2>&1; }

# Same as q() but forces CSV. MANDATORY for any SHOW command.
# `snow sql` renders its default output as a fixed-width table sized to the
# terminal, and a wide result (SHOW SERVICES has ~30 columns) is squeezed until
# EVERY cell renders empty - the grid still has the right number of rows, so the
# output looks plausible while containing none of the values. A substring or grep
# check against that is guaranteed to find nothing, which reported an account
# holding 12 ORS/VROOM services as having none. CSV is width-independent.
qc() { snow sql -c "$CONNECTION" --format csv -q "$TAG_SQL $1" 2>&1; }

# Substring test on a VARIABLE, never `... | grep -q ...`.
# Under `set -o pipefail`, grep -q exits at the first match and closes the pipe,
# `snow` then dies of SIGPIPE, and the pipeline reports failure even though the
# pattern matched - which silently inverted the ACCOUNTADMIN check and reported a
# correctly-privileged account as degraded.
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
has_i() {
  local hay low_hay low_needle
  hay=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  low_needle=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
  case "$hay" in *"$low_needle"*) return 0 ;; *) return 1 ;; esac
}

echo "=== install-fleet-apps pre-flight (connection=$CONNECTION)"

# --- 1. local toolchain (mirrors installer step 0, checked here so a missing
#        tool costs a second rather than surfacing after the first SQL step) ---
echo
echo "[1] local toolchain"
for t in snow docker node npm python3; do
  if command -v "$t" >/dev/null 2>&1; then pass "$t present"; else fail "$t NOT found"; fi
done
if command -v crane >/dev/null 2>&1; then
  pass "crane present (preferred for SPCS image push)"
else
  warn "crane absent - image push falls back to 'docker push', which intermittently hangs"
fi

# --- 2. connection + identity ---
echo
echo "[2] connection and identity"
OUT=$(q "SELECT CURRENT_ACCOUNT() AS A, CURRENT_ROLE() AS R, CURRENT_REGION() AS G;")
if has_i "$OUT" "error"; then
  fail "connection '$CONNECTION' does not work"
  printf '%s\n' "$OUT" | tail -3
  echo; echo "RESULT: BLOCKING problems found - do not start the install."; exit 1
fi
printf '%s\n' "$OUT" | grep -E "^\|" | tail -2 | sed 's/^/     /'
pass "connection works"

# --- 3. privileges the install assumes. It creates databases, warehouses,
#        compute pools, roles, integrations and an image repository, and imports
#        shares; a role without these fails several steps in, after tens of
#        minutes of work. ACCOUNTADMIN implies all of them, which is what the
#        skill's own docs assume, so the probe reports the role and only nags
#        when it is something else. ---
echo
echo "[3] account privileges"
ROLE_OUT=$(q "SELECT CURRENT_ROLE() AS R;")
if has_i "$ROLE_OUT" "ACCOUNTADMIN"; then
  pass "role is ACCOUNTADMIN (all required privileges implied)"
else
  warn "role is not ACCOUNTADMIN - verify CREATE DATABASE / WAREHOUSE / COMPUTE POOL / ROLE / INTEGRATION and IMPORT SHARE"
  qc "SHOW GRANTS TO ROLE IDENTIFIER(CURRENT_ROLE());" \
    | grep -iE "CREATE (DATABASE|WAREHOUSE|COMPUTE POOL|ROLE|INTEGRATION)|IMPORT SHARE" \
    | sed 's/^/       /' | head -8
fi

# --- 4. Overture Marketplace listings. This is the one that silently degrades
#        five to seven views, so it is probed explicitly rather than inferred. ---
echo
echo "[4] Overture Marketplace listings (catchment, location, sourcing depend on these)"
if [ "$CHECK_LISTINGS" = "1" ]; then
  # id:database pairs exactly as analytic_layer.sql acquires them.
  for pair in "GZT0Z4CM1E9KR:OVERTURE_MAPS__PLACES" \
              "GZT0Z4CM1E9NQ:OVERTURE_MAPS__ADDRESSES" \
              "GZT0Z4CM1E9KJ:OVERTURE_MAPS__TRANSPORTATION" \
              "GZT0Z4CM1E9KN:OVERTURE_MAPS__BUILDINGS" \
              "GZT0Z4CM1E9M9:OVERTURE_MAPS__DIVISIONS"; do
    lid="${pair%%:*}"; db="${pair##*:}"
    OUT=$(q "CALL SYSTEM\$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', '$lid'); CREATE DATABASE IF NOT EXISTS $db FROM LISTING $lid;")
    if has_i "$OUT" "error" || has_i "$OUT" "denied" || has_i "$OUT" "not authorized"; then
      warn "$db (listing $lid) NOT acquirable - the catchment view will be empty; site_impact / closure_impact / sourcing need PLACES + ADDRESSES"
      printf '%s\n' "$OUT" | grep -iE "error|denied|not authorized" | head -1 | sed 's/^/       /'
    else
      pass "$db acquirable"
    fi
  done
else
  warn "listing probe skipped (--no-listings)"
fi

# --- 5. ORS engine. Every live-routing view (delivery_sync, catchment,
#        site_impact, closure_impact, sourcing, mix, vrp, emergency, backload)
#        needs the region's service RUNNING, and a suspended service does NOT
#        raise - it returns NULL and the layer silently disappears. ---
echo
echo "[5] ORS engine"
OUT=$(qc "SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;")
if has_i "$OUT" "does not exist" || has_i "$OUT" "not authorized"; then
  warn "OPENROUTESERVICE_APP absent - expected on a first install (the engine is built by this run unless --no-engine)"
else
  N=$(printf '%s\n' "$OUT" | grep -ciE "ORS_SERVICE|VROOM_SERVICE" || true)
  if [ "${N:-0}" -gt 0 ]; then
    pass "$N ORS/VROOM service(s) already present"
  else
    warn "OPENROUTESERVICE_APP exists but has no ORS/VROOM services"
  fi
fi

# --- 6. Existing fleet objects. A "fresh" install onto an account that already
#        has them is the reuse path, not the clean path, and behaves differently
#        (step 2 is skipped wholesale when DIM_DATASETS and FACT_TRIPS are
#        non-empty, so a partially-loaded account is never re-seeded). ---
echo
echo "[6] pre-existing fleet objects (clean install vs reuse)"
OUT=$(q "SELECT COUNT(*) AS N FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS;")
if has_i "$OUT" "does not exist" || has_i "$OUT" "not authorized"; then
  pass "no FLEET_INTELLIGENCE - this is a clean install"
else
  N=$(printf '%s\n' "$OUT" | grep -oE "^\| [0-9]+" | grep -oE "[0-9]+" | head -1)
  warn "FLEET_INTELLIGENCE.CORE.DIM_DATASETS already has ${N:-?} row(s) - step 2 will SKIP seeding. Flush first for a true clean install."
fi

# --- 7. Python deps the post-install harness needs. Checked here so the
#        verification step at the end of the install is not the thing that
#        discovers a missing package. ---
echo
echo "[7] verification harness dependencies"
python3 -c "import snowflake.connector" 2>/dev/null \
  && pass "snowflake-connector-python present" \
  || warn "snowflake-connector-python missing - validate_app_views.py cannot run"
python3 -c "import yaml" 2>/dev/null \
  && pass "PyYAML present" \
  || warn "PyYAML missing - validate_app_views.py cannot run"

# --- 8. Cowork / Snowflake Intelligence discoverability of the agents.
#        The agents are only visible in the Cowork agent picker to a role that
#        holds USAGE on them, and the installer grants them to the FLEET_APP_*
#        roles - NOT to whichever role a human happens to use. That means a
#        correct install can still look like "Cowork does not know about our SA",
#        which is a grant question, not an install failure. Checked here so it is
#        surfaced before the install rather than discovered afterwards. ---
echo
echo "[8] Cowork agent discoverability"
CURRENT_ROLE_OUT=$(q "SELECT CURRENT_ROLE() AS R;")
GRANTS_OUT=$(qc "SHOW GRANTS TO ROLE FLEET_APP_ADMIN;")
if has "$CURRENT_ROLE_OUT" "ACCOUNTADMIN"; then
  pass "running as ACCOUNTADMIN - it can always see the agents"
elif has "$GRANTS_OUT" "FLEET_APP_ADMIN"; then
  pass "FLEET_APP_ADMIN exists; confirm your own role inherits it to see FLEET_SUPER_AGENT in Cowork"
else
  warn "after install, grant your working role FLEET_APP_ADMIN (or USAGE on FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SUPER_AGENT) or the agent will not appear in the Cowork agent picker"
fi

echo
if [ "$BLOCKING" = "1" ]; then
  echo "RESULT: BLOCKING problems found - do not start the install."
  exit 1
fi
if [ "$DEGRADED" = "1" ]; then
  echo "RESULT: install can proceed, but some features will be degraded (see DEGRADED lines)."
  exit 2
fi
echo "RESULT: ready."
exit 0
