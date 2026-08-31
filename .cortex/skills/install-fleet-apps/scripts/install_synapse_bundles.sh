#!/usr/bin/env bash
#
# install-fleet-apps / install_synapse_bundles.sh
#
# Per-account materialize + deploy of the three role-scoped synapse tool bundles:
#   user/  (routing-tools)    -> OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP    (FLEET_APP_USER)
#   ops/   (fleet-ops-tools)  -> FLEET_INTELLIGENCE.SYNAPSE_OPS.FLEET_OPS_MCP (FLEET_APP_OPS)
#   admin/ (fleet-admin-tools)-> FLEET_INTELLIGENCE.SYNAPSE_ADMIN.FLEET_ADMIN_MCP (FLEET_APP_ADMIN)
#
# The committed _installed/wgb26798/ targets are account-pinned; this script
# generates a fresh _installed/<account>/ target for the ACTIVE connection so a
# clean install works on any account. Idempotent: synapse uses CREATE OR REPLACE.
#
# Usage:
#   bash .cortex/skills/install-fleet-apps/scripts/install_synapse_bundles.sh <connection>
set -euo pipefail

CONNECTION="${1:?usage: install_synapse_bundles.sh <connection>}"
REPO_ROOT=$(git rev-parse --show-toplevel)
TOOLS_DIR="$REPO_ROOT/.cortex/skills/install-fleet-apps/fleet_tools"
GIT_SHA=$(git rev-parse HEAD)

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found"; exit 1; }
command -v snow >/dev/null 2>&1 || { echo "ERROR: snow not found"; exit 1; }

# Resolve the active account (lowercased) for the per-account install dir.
ACCOUNT=$(snow sql -c "$CONNECTION" --format=CSV -q "SELECT LOWER(CURRENT_ACCOUNT());" 2>/dev/null \
  | grep -iE '^[a-z0-9_-]+$' | head -1)
[ -n "$ACCOUNT" ] || { echo "ERROR: could not resolve CURRENT_ACCOUNT() via $CONNECTION"; exit 1; }
echo "[synapse] account=$ACCOUNT connection=$CONNECTION"

# ── Build the vendored synapse framework from source ──────────────────────────
# The framework is vendored as SOURCE at a pinned upstream SHA (see
# fleet_tools/vendor/synapse/VENDOR.md) and dist/ is generated output, NOT
# committed. So the CLI used below (`synapse materialize` / `synapse deploy`)
# does not exist until tsc has run. Two failure modes this guards against:
#   - no dist at all on a fresh clone -> "synapse: command not found"
#   - a STALE dist after a src/ or patch change -> the deploy silently emits
#     old codegen (e.g. a procedure DDL without the tracking COMMENT, or with
#     COMMENT in the position Snowflake rejects), which is very hard to spot
#     because the deploy itself looks normal.
# Hence: rebuild whenever dist/ is missing or older than any source file, and
# fail loudly on a tsc error rather than proceeding with whatever dist exists.
VENDOR_DIR="$TOOLS_DIR/vendor/synapse"

# Dev deps (typescript) are required to build, so this is a full install, not
# --omit=dev as before. node_modules is gitignored.
if [ ! -d "$VENDOR_DIR/node_modules" ]; then
  echo "[synapse] installing vendored framework deps (incl. typescript)..."
  ( cd "$VENDOR_DIR" && npm install >/tmp/synapse_vendor.log 2>&1 ) \
    || { echo "ERROR: vendor synapse npm install failed"; tail -30 /tmp/synapse_vendor.log; exit 1; }
fi

# Rebuild if dist/ is absent, or if any tracked source file is newer than the
# built CLI entrypoint. `find -newer` over src/ + config is enough: package.json
# changes imply an npm install, which the block above handles.
NEEDS_BUILD=0
if [ ! -f "$VENDOR_DIR/dist/cli/index.js" ]; then
  NEEDS_BUILD=1
elif [ -n "$(find "$VENDOR_DIR/src" "$VENDOR_DIR/tsconfig.json" -newer "$VENDOR_DIR/dist/cli/index.js" -print -quit 2>/dev/null)" ]; then
  NEEDS_BUILD=1
fi

if [ "$NEEDS_BUILD" -eq 1 ]; then
  echo "[synapse] building vendored framework (tsc)..."
  ( cd "$VENDOR_DIR" && npm run build >/tmp/synapse_vendor_build.log 2>&1 ) \
    || { echo "ERROR: vendored synapse build (tsc) failed - refusing to deploy a stale dist"; tail -40 /tmp/synapse_vendor_build.log; exit 1; }
else
  echo "[synapse] vendored framework dist is up to date"
fi

# Sanity-check the built codegen still carries the local patches (VENDOR.md).
# Cheap string checks on the emitted CLI/build output; a re-vendor that dropped a
# patch would otherwise only surface as an untagged object or a failed deploy.
grep -q "COMMENT='\${TRACKING_COMMENT}' EXECUTE AS" "$VENDOR_DIR/dist/build/ddl.js" \
  || { echo "ERROR: built synapse codegen is missing the procedure COMMENT tracking tag before EXECUTE AS (see vendor/synapse/VENDOR.md)"; exit 1; }
grep -q "ALTER SESSION SET query_tag" "$VENDOR_DIR/dist/cli/materialize.js" \
  || { echo "ERROR: built synapse codegen is missing the install.sql query_tag preamble (see vendor/synapse/VENDOR.md)"; exit 1; }

# bundle | installed-dir | database | schema | mcpServer | roleKey | roleName
BUNDLES=(
  "user|fleet-user-tools|OPENROUTESERVICE_APP|ROUTING|ROUTING_MCP|user|FLEET_APP_USER"
  "ops|fleet-ops-tools|FLEET_INTELLIGENCE|SYNAPSE_OPS|FLEET_OPS_MCP|ops|FLEET_APP_OPS"
  "admin|fleet-admin-tools|FLEET_INTELLIGENCE|SYNAPSE_ADMIN|FLEET_ADMIN_MCP|admin|FLEET_APP_ADMIN"
)

for row in "${BUNDLES[@]}"; do
  IFS='|' read -r SRC INSTALLED DB SCHEMA MCP ROLEKEY ROLENAME <<< "$row"
  SRC_DIR="$TOOLS_DIR/$SRC"
  TARGET="$TOOLS_DIR/_installed/$ACCOUNT/$INSTALLED"
  APP_NAME=$(grep -m1 -E "name:" "$SRC_DIR/synapse.config.ts" | sed -E "s/.*name: *'([^']+)'.*/\1/")

  echo "[synapse] === $SRC ($APP_NAME) -> $DB.$SCHEMA.$MCP ==="
  mkdir -p "$TARGET"

  # The materialized install.sql does `USE SCHEMA <SCHEMA>` but does not CREATE it.
  # On a fresh install the target schema may not exist yet (e.g.
  # OPENROUTESERVICE_APP.ROUTING - the routing-verb home - or the SYNAPSE_OPS /
  # SYNAPSE_ADMIN bundle schemas), so ensure it first. Idempotent.
  snow sql -c "$CONNECTION" -q "ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"sql\"}}'; CREATE SCHEMA IF NOT EXISTS $DB.$SCHEMA COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"sql\"}}';" >/tmp/synapse_${SRC}_schema.log 2>&1 \
    || { echo "ERROR: could not ensure schema $DB.$SCHEMA"; tail -20 /tmp/synapse_${SRC}_schema.log; exit 1; }

  # Per-account install.json (binds connection + logical->actual role).
  cat > "$TARGET/install.json" <<JSON
{
  "app": "$APP_NAME",
  "account": "$ACCOUNT",
  "runtime": "sproc",
  "warehouse": "MY_WH",
  "database": "$DB",
  "schema": "$SCHEMA",
  "snowCliConn": "$CONNECTION",
  "mcpServerName": "$MCP",
  "roles": { "$ROLEKEY": "$ROLENAME" },
  "materializedFrom": "git:$GIT_SHA"
}
JSON

  ( cd "$SRC_DIR" && { [ -d node_modules ] || npm install >/tmp/synapse_${SRC}_npm.log 2>&1; } ) \
    || { echo "ERROR: npm install failed for $SRC"; tail -30 /tmp/synapse_${SRC}_npm.log; exit 1; }
  ( cd "$SRC_DIR" && npx synapse materialize --install "$TARGET" >/tmp/synapse_${SRC}_mat.log 2>&1 ) \
    || { echo "ERROR: synapse materialize failed for $SRC"; tail -30 /tmp/synapse_${SRC}_mat.log; exit 1; }
  ( cd "$SRC_DIR" && npx synapse deploy --install "$TARGET" >/tmp/synapse_${SRC}_dep.log 2>&1 ) \
    || { echo "ERROR: synapse deploy failed for $SRC"; tail -30 /tmp/synapse_${SRC}_dep.log; exit 1; }
  echo "[synapse] $SRC deployed."
done

echo "[synapse] verifying MCP servers..."
snow sql -c "$CONNECTION" -q "SHOW MCP SERVERS;" --format=CSV 2>/dev/null \
  | grep -iE 'ROUTING_MCP|FLEET_OPS_MCP|FLEET_ADMIN_MCP' || echo "  (none listed yet)"

# Post-deploy smoke verification. The vendored `synapse test:e2e` CLI hardcodes
# `pnpm exec vitest run --dir tests/e2e`, which needs pnpm + vitest + a tests/e2e
# suite that this repo does not ship, and its mock harness verifies envelope logic
# in isolation rather than a real deploy. Instead we run a lightweight,
# engine-independent smoke: CALL one read-only verb per audited bundle through the
# real deployed sproc + envelope, then confirm a VERB_ATTEMPT audit row landed.
# This exercises (and proves) the audited envelope end-to-end on every install
# (Tenet 7 + Tenet 8 verification). Non-fatal: a WARN never blocks the install,
# since engine/region state varies; set SYNAPSE_SKIP_SMOKE=1 to skip entirely.
if [ "${SYNAPSE_SKIP_SMOKE:-0}" != "1" ]; then
  echo "[synapse] post-deploy smoke (audited-envelope verify)..."
  # bundle label | smoke CALL (read-only, no routing-engine dependency) | audit table
  SMOKE=(
    "ops|CALL FLEET_INTELLIGENCE.SYNAPSE_OPS.HEALTHCHECK(NULL)|FLEET_INTELLIGENCE.SYNAPSE_OPS.VERB_ATTEMPT"
    "admin|CALL FLEET_INTELLIGENCE.SYNAPSE_ADMIN.CHECK_SUBSTRATE(NULL)|FLEET_INTELLIGENCE.SYNAPSE_ADMIN.VERB_ATTEMPT"
  )
  for srow in "${SMOKE[@]}"; do
    IFS='|' read -r SLABEL SCALL STABLE <<< "$srow"
    if snow sql -c "$CONNECTION" -q "$SCALL" >/tmp/synapse_smoke_${SLABEL}.log 2>&1; then
      n=$(snow sql -c "$CONNECTION" --format=CSV \
        -q "SELECT COUNT(*) FROM $STABLE;" 2>/dev/null | grep -iE '^[0-9]+$' | head -1)
      echo "  [smoke] $SLABEL: OK (verb returned; ${n:-?} audit rows in VERB_ATTEMPT)"
    else
      echo "  [smoke] $SLABEL: WARN (verb call did not succeed; see /tmp/synapse_smoke_${SLABEL}.log)"
    fi
  done
fi
echo "[synapse] done."
