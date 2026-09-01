#!/usr/bin/env bash
#
# install-fleet-apps / create_agents.sh
#
# Creates or updates the four Cortex Agents the architecture needs, from the
# trimmed (agnostic) specs under fleet_sa_app/app/:
#   - FLEET_AGENT       (consumer) from agent-spec.json        -> attaches ROUTING_MCP
#   - FLEET_OPS_AGENT   (operator) from ops-agent-spec.json    -> attaches FLEET_OPS_MCP
#   - FLEET_ADMIN_AGENT (installer) from admin-agent-spec.json -> attaches FLEET_ADMIN_MCP
#   - FLEET_SUPER_AGENT (superuser) from super-agent-spec.json -> attaches ALL THREE
#
# The first three attach exactly one role-scoped MCP bundle each. FLEET_SUPER_AGENT
# attaches all three and exists for the single operator who wants one assistant
# (notably in Cowork / Snowflake Intelligence, where a user cannot hand off between
# agents mid-conversation). Tenet 3 still holds, because the isolation boundary is
# the GRANT, not the spec: role_binding.sql grants FLEET_SUPER_AGENT to
# FLEET_APP_ADMIN ONLY and never to FLEET_APP_USER, so an app user cannot reach the
# ops or admin verbs through it.
#
# super-agent-spec.json is GENERATED from agent-spec.json by
# scripts/build_super_agent_spec.py - do not hand-edit it. Two hand-maintained
# copies of a 12,000-character instruction block drift within a release, and the
# drift is invisible until the two agents answer the same question differently.
#
# LIFECYCLE (per the Snowflake best-practices guide for evaluating Cortex Agents):
#   - absent:  CREATE AGENT (auto-creates VERSION$1 + LIVE)
#   - present: ALTER AGENT MODIFY LIVE VERSION SET SPECIFICATION (preserves
#              grants, eval history, and monitoring traces)
#   After either path: COMMIT a named version, then assign the PRODUCTION alias.
#   The committed version is what scheduled evaluations and API traffic target;
#   the alias is how callers address it without knowing the version number.
#
# WHY NOT CREATE OR REPLACE: that command drops every grant on the agent AND
# destroys all evaluation runs and monitoring traces. Since this script must be
# re-run after every synapse bundle deploy (because `synapse deploy` does
# CREATE OR REPLACE MCP SERVER and agents bind to their MCP at creation/alter
# time), CREATE OR REPLACE would wipe eval history on a routine cadence - making
# scheduled evaluations, version comparison, and CI/CD quality gates pointless.
#
# The --recreate flag is available for deliberate destructive resets (e.g. when
# the agent schema or ownership needs to change). It falls back to CREATE OR
# REPLACE and re-applies grants.
#
# MUST be re-run after EVERY synapse bundle deploy: `synapse deploy` does
# CREATE OR REPLACE MCP SERVER, and ALTER AGENT MODIFY LIVE VERSION SET
# SPECIFICATION re-binds the spec (including mcp_servers) so the agent picks up
# the new MCP server. Invariant: each agent's last-committed version is newer
# than its MCP server's created_on.
#
# Usage:
#   bash .cortex/skills/install-fleet-apps/scripts/create_agents.sh <connection>
#   bash .../create_agents.sh <connection> --recreate
set -euo pipefail

CONNECTION="${1:?usage: create_agents.sh <connection> [--recreate]}"
shift || true

RECREATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --recreate) RECREATE=1 ;;
    *) echo "ERROR: unknown argument $1"; exit 1 ;;
  esac
  shift
done

REPO_ROOT=$(git rev-parse --show-toplevel)
APP_DIR="$REPO_ROOT/.cortex/skills/install-fleet-apps/fleet_sa_app/app"
USER_SPEC="$APP_DIR/agent-spec.json"
OPS_SPEC="$APP_DIR/ops-agent-spec.json"
ADMIN_SPEC="$APP_DIR/admin-agent-spec.json"
SUPER_SPEC="$APP_DIR/super-agent-spec.json"

# Regenerate the derived super spec if the generator is present, so a stale copy
# can never be deployed after an agent-spec.json edit.
GEN="$REPO_ROOT/.cortex/skills/install-fleet-apps/scripts/build_super_agent_spec.py"
if [ -f "$GEN" ]; then
  python3 "$GEN" >/dev/null || { echo "ERROR: failed to generate $SUPER_SPEC"; exit 1; }
fi

for f in "$USER_SPEC" "$OPS_SPEC" "$ADMIN_SPEC" "$SUPER_SPEC"; do
  [ -f "$f" ] || { echo "ERROR: missing agent spec $f"; exit 1; }
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" \
    || { echo "ERROR: $f is not valid JSON"; exit 1; }
done

# Drop tools whose backing object is absent in THIS account.
PRUNE="$REPO_ROOT/.cortex/skills/install-fleet-apps/scripts/prune_agent_specs.py"
PRUNED_DIR=""
if [ -f "$PRUNE" ]; then
  PRUNED_DIR=$(mktemp -d)
  if python3 "$PRUNE" --connection "$CONNECTION" --out-dir "$PRUNED_DIR" \
       "$USER_SPEC" "$OPS_SPEC" "$ADMIN_SPEC" "$SUPER_SPEC"; then
    USER_SPEC="$PRUNED_DIR/$(basename "$USER_SPEC")"
    OPS_SPEC="$PRUNED_DIR/$(basename "$OPS_SPEC")"
    ADMIN_SPEC="$PRUNED_DIR/$(basename "$ADMIN_SPEC")"
    SUPER_SPEC="$PRUNED_DIR/$(basename "$SUPER_SPEC")"
  else
    echo "[create_agents] WARN: spec pruning skipped; deploying specs unchanged"
  fi
fi

TRACK='{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
TAG_SQL="ALTER SESSION SET query_tag = '$TRACK';"
SCHEMA_SQL="CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SYNAPSE_USER COMMENT = '$TRACK';"

note() { echo "[create_agents] $*"; }
q()    { snow sql -c "$CONNECTION" -q "$TAG_SQL $1" --enable-templating NONE 2>&1; }

# Agent name -> spec file -> display name -> color
AGENTS=(
  "FLEET_AGENT:$USER_SPEC:Fleet Intelligence (Analytics + Routing):blue"
  "FLEET_OPS_AGENT:$OPS_SPEC:Fleet Operations (Services):green"
  "FLEET_ADMIN_AGENT:$ADMIN_SPEC:Fleet Admin (Install):orange"
  "FLEET_SUPER_AGENT:$SUPER_SPEC:Fleet Superuser (All Capabilities):purple"
)

# Ensure the schema exists (single call, not per-agent).
q "$SCHEMA_SQL" >/dev/null

# Probe which agents already exist. TAG_SQL prepends a statement, so snow sql
# returns multiple result sets [[{status}],[{agent},{agent}...]]. Take the LAST
# result set (the SHOW output), not the first (the tag status).
EXISTING_AGENTS=$(snow sql -c "$CONNECTION" --format json \
  -q "$TAG_SQL SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.SYNAPSE_USER;" 2>/dev/null \
  | python3 -c "
import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
rows = data[-1] if data and isinstance(data[0], list) else data
for r in rows:
    print(r.get('name',''))
" 2>/dev/null || true)

STAMP=$(date -u +%Y%m%d-%H%M%S)
SQL_FILE=$(mktemp)
GRANT_FILE=$(mktemp)
trap 'rm -f "$SQL_FILE" "$GRANT_FILE"; rm -rf "${PRUNED_DIR:-}"' EXIT

note "deploying agents via $CONNECTION (recreate=$RECREATE) ..."

for entry in "${AGENTS[@]}"; do
  IFS=: read -r AGENT_NAME SPEC_FILE DISPLAY_NAME COLOR <<<"$entry"
  FQN="FLEET_INTELLIGENCE.SYNAPSE_USER.${AGENT_NAME}"
  PROFILE="{\"display_name\": \"${DISPLAY_NAME}\", \"color\": \"${COLOR}\"}"
  SPEC=$(cat "$SPEC_FILE")

  AGENT_EXISTS=0
  if echo "$EXISTING_AGENTS" | grep -qx "$AGENT_NAME"; then
    AGENT_EXISTS=1
  fi

  if [ "$AGENT_EXISTS" = "1" ] && [ "$RECREATE" = "0" ]; then
    # ── ALTER path: preserves grants, eval history, monitoring traces ──
    note "  $AGENT_NAME: ALTER (exists, preserving history)"

    # Update the live version's specification. If no live version exists (it is
    # not auto-created after a COMMIT), create one from the last committed version
    # first. The ADD LIVE VERSION call fails harmlessly if one already exists, so
    # we try it and absorb the error via EXECUTE IMMEDIATE (snow sql -f does not
    # support bare BEGIN...EXCEPTION...END).
    q "EXECUTE IMMEDIATE \$\$ BEGIN BEGIN ALTER AGENT ${FQN} ADD LIVE VERSION FROM LAST; EXCEPTION WHEN OTHER THEN NULL; END; END; \$\$;" >/dev/null

    # Write the spec to a temp file to avoid shell-escaping the JSON.
    {
      echo "$TAG_SQL"
      echo "ALTER AGENT ${FQN} MODIFY LIVE VERSION SET SPECIFICATION = \$\$"
      echo "$SPEC"
      echo "\$\$;"
      echo "ALTER AGENT ${FQN} SET COMMENT = '${TRACK}', PROFILE = '${PROFILE}';"
      echo "ALTER AGENT ${FQN} COMMIT COMMENT = 'deploy ${STAMP}';"
    } > "$SQL_FILE"

    snow sql -c "$CONNECTION" -f "$SQL_FILE" \
      || { note "ERROR: ALTER path failed for $AGENT_NAME"; exit 1; }

    # Assign the PRODUCTION alias to the version just committed. MODIFY VERSION
    # needs the actual VERSION$N name (LAST is a shortcut for API calls, not for
    # ALTER AGENT DDL), so we capture it from SHOW VERSIONS.
    COMMITTED_VER=$(snow sql -c "$CONNECTION" --format json \
      -q "SHOW VERSIONS IN AGENT ${FQN}" 2>/dev/null \
      | python3 -c "
import json,sys
data = json.load(sys.stdin)
rows = data[-1] if data and isinstance(data[0], list) else data
named = sorted([r for r in rows if r.get('name')], key=lambda r: r['created_on'], reverse=True)
print(named[0]['name'] if named else '')
" 2>/dev/null || echo "")

    if [ -n "$COMMITTED_VER" ]; then
      q "ALTER AGENT ${FQN} MODIFY VERSION ${COMMITTED_VER} SET ALIAS = PRODUCTION;" >/dev/null \
        && note "    -> committed ${COMMITTED_VER}, alias PRODUCTION" \
        || note "    WARN: committed ${COMMITTED_VER} but alias failed"
    else
      note "    WARN: could not determine committed version for alias"
    fi
  else
    # ── CREATE path: fresh agent (or --recreate) ──
    if [ "$RECREATE" = "1" ] && [ "$AGENT_EXISTS" = "1" ]; then
      note "  $AGENT_NAME: CREATE OR REPLACE (--recreate, grants will be re-applied)"
    else
      note "  $AGENT_NAME: CREATE (new agent)"
    fi

    {
      echo "$TAG_SQL"
      if [ "$RECREATE" = "1" ]; then
        echo "CREATE OR REPLACE AGENT ${FQN}"
      else
        echo "CREATE AGENT ${FQN}"
      fi
      echo "  COMMENT = '${TRACK}'"
      echo "  PROFILE = '${PROFILE}'"
      echo "  FROM SPECIFICATION \$\$"
      echo "$SPEC"
      echo "\$\$;"
    } > "$SQL_FILE"

    snow sql -c "$CONNECTION" -f "$SQL_FILE" \
      || { note "ERROR: CREATE path failed for $AGENT_NAME"; exit 1; }

    # CREATE auto-creates VERSION$1 as default. Set the PRODUCTION alias.
    q "ALTER AGENT ${FQN} MODIFY VERSION VERSION\$1 SET ALIAS = PRODUCTION;" >/dev/null \
      && note "    -> created VERSION\$1, alias PRODUCTION" \
      || note "    WARN: created but alias failed"
  fi
done

# ── re-apply the agent USAGE grants ──
#
# On the ALTER path grants survive, so this is a no-op safety net.
# On the CREATE/--recreate path this is load-bearing: CREATE OR REPLACE drops
# every grant.
#
# Mirrors role_binding.sql verbatim (its lines for the four agents). Keep the
# two in sync; role_binding.sql remains authoritative.
#
# TENET 3: FLEET_SUPER_AGENT goes to FLEET_APP_ADMIN ONLY. Never add
# FLEET_APP_USER here.
#
# Each grant sits in its own exception handler because on a fresh install the
# roles do not exist yet at step 6.
cat > "$GRANT_FILE" <<'GRANTSQL'
EXECUTE IMMEDIATE $$
DECLARE
  granted INTEGER DEFAULT 0;
  skipped INTEGER DEFAULT 0;
BEGIN
  BEGIN
    GRANT USAGE ON AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_AGENT
      TO ROLE FLEET_APP_USER;
    granted := granted + 1;
  EXCEPTION WHEN OTHER THEN skipped := skipped + 1;
  END;

  BEGIN
    GRANT USAGE ON AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_OPS_AGENT
      TO ROLE FLEET_APP_OPS;
    granted := granted + 1;
  EXCEPTION WHEN OTHER THEN skipped := skipped + 1;
  END;

  BEGIN
    GRANT USAGE ON AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_AGENT
      TO ROLE FLEET_APP_ADMIN;
    granted := granted + 1;
  EXCEPTION WHEN OTHER THEN skipped := skipped + 1;
  END;

  -- Tenet 3 boundary: ADMIN only.
  BEGIN
    GRANT USAGE ON AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SUPER_AGENT
      TO ROLE FLEET_APP_ADMIN;
    granted := granted + 1;
  EXCEPTION WHEN OTHER THEN skipped := skipped + 1;
  END;

  RETURN 'agent grants: ' || granted || ' applied, ' || skipped
      || ' skipped (a skip means the role does not exist yet = fresh install)';
END;
$$;
GRANTSQL

note "applying agent USAGE grants ..."
snow sql -c "$CONNECTION" -f "$GRANT_FILE"

# Verify per agent: USAGE grant present + committed version + PRODUCTION alias.
note "verifying agents ..."
GRANTS_PENDING=0
for entry in "${AGENTS[@]}"; do
  IFS=: read -r AGENT_NAME _ _ _ <<<"$entry"
  FQN="FLEET_INTELLIGENCE.SYNAPSE_USER.${AGENT_NAME}"

  # Grant check (no TAG_SQL prefix, so single result set)
  GRANTEE=$(snow sql -c "$CONNECTION" --format json \
    -q "SHOW GRANTS ON AGENT ${FQN}" 2>/dev/null \
    | python3 -c "
import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(''); sys.exit(0)
rows = data[-1] if data and isinstance(data[0], list) else data
print(next((r.get('grantee_name','') for r in rows
            if str(r.get('privilege','')).upper() == 'USAGE'), ''))
" 2>/dev/null || echo "")

  # Version + alias check
  VERSION_INFO=$(snow sql -c "$CONNECTION" --format json \
    -q "SHOW VERSIONS IN AGENT ${FQN}" 2>/dev/null \
    | python3 -c "
import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    print('0 versions, no alias'); sys.exit(0)
rows = data[-1] if data and isinstance(data[0], list) else data
named = [r for r in rows if r.get('name')]
aliases = [r.get('alias','') for r in named if r.get('alias')]
prod = 'PRODUCTION' in [a.upper() for a in aliases if a]
print(f'{len(named)} version(s), production={prod}')
" 2>/dev/null || echo "unknown")

  if [ -n "$GRANTEE" ]; then
    echo "  ${AGENT_NAME}: grant=OK(${GRANTEE}) ${VERSION_INFO}"
  else
    echo "  ${AGENT_NAME}: grant=PENDING ${VERSION_INFO}"
    GRANTS_PENDING=1
  fi
done

if [ "$GRANTS_PENDING" = "1" ]; then
  note "done, but some agents have NO USAGE grant:"
  note "  fresh install -> install step 8 (role_binding.sql) applies it;"
  note "  otherwise     -> run role_binding.sql, the authoritative grant pass."
else
  note "done. All four agents carry a USAGE grant and a PRODUCTION alias."
fi
