#!/usr/bin/env bash
#
# install-fleet-apps / create_agents.sh
#
# Creates the four Cortex Agents the architecture needs, from the trimmed
# (agnostic) specs under fleet_sa_app/app/:
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
# Idempotent: CREATE OR REPLACE AGENT. The synapse MCP servers referenced by the
# specs must exist first (run the synapse bundle install), and the SYNAPSE_USER
# schema is ensured here.
#
# MUST be re-run after EVERY synapse bundle deploy: `synapse deploy` does
# CREATE OR REPLACE MCP SERVER, and an agent binds to its MCP server at creation
# time, so every agent goes stale when a bundle is redeployed. Invariant: each
# agent's created_on is newer than its MCP server's.
#
# CREATE OR REPLACE AGENT DROPS EVERY GRANT ON THE AGENT - so this script
# RE-APPLIES the four USAGE grants at the end. It has to: recreating an agent
# silently revokes access for the role that reaches it, and the authoritative
# grant pass (role_binding.sql) is install step 8 while this is step 6. A full
# install therefore self-corrects, but a STANDALONE re-run of this script - which
# is exactly what the bundle-deploy invariant above tells you to do - used to
# leave all four agents reachable by ACCOUNTADMIN only. The symptom is Snowsight
# showing "grant users access to the agent" unchecked, and every app user losing
# the consumer agent. The re-grant block is best-effort by design: on a fresh
# install the FLEET_APP_* roles do not exist yet at step 6, so a missing role is
# reported as PENDING rather than failing the install. role_binding.sql stays the
# single authoritative source for the grants; this block only mirrors the four
# agent statements so the script cannot leave the account worse than it found it.
#
# Usage:
#   bash .cortex/skills/install-fleet-apps/scripts/create_agents.sh <connection>
set -euo pipefail

CONNECTION="${1:?usage: create_agents.sh <connection>}"
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
#
# Snowflake validates every tool target when a request is SERVED, not when the
# agent is created, so one tool pointing at a missing object fails the whole
# request whatever was asked. On a fresh agnostic install the consumer agent bound
# `query_offers` to SEMANTIC.SV_OFFERS, which install step 4.5 deliberately skips
# (it needs MARKETPLACE, which is out of scope here) - so EVERY FLEET_AGENT
# question, including pure routing ones, failed with a 400 while every
# object-level install check passed.
#
# Pruning here rather than editing the specs keeps them declarative: install the
# owning pack and re-run this script and the tool comes back. If the account
# cannot be inspected the pruner exits 2 and we deploy the specs UNCHANGED, which
# fails loudly at request time rather than silently shipping an emptied agent.
PRUNE="$REPO_ROOT/.cortex/skills/install-fleet-apps/scripts/prune_agent_specs.py"
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
# A second `trap ... EXIT` REPLACES the first rather than adding to it, so every
# trap in this script must name EVERY temporary registered so far - dropping one
# leaks it. The grant step below re-registers this trap with GRANT_FILE added.
SQL_FILE=$(mktemp); trap 'rm -f "$SQL_FILE"; rm -rf "${PRUNED_DIR:-}"' EXIT

{
  echo "ALTER SESSION SET query_tag = '$TRACK';"
  echo "CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SYNAPSE_USER COMMENT = '$TRACK';"
  echo
  echo "CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_AGENT"
  echo "  COMMENT = '$TRACK'"
  echo "  PROFILE = '{\"display_name\": \"Fleet Intelligence (Analytics + Routing)\", \"color\": \"blue\"}'"
  echo "  FROM SPECIFICATION \$\$"
  cat "$USER_SPEC"
  echo "\$\$;"
  echo
  echo "CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_OPS_AGENT"
  echo "  COMMENT = '$TRACK'"
  echo "  PROFILE = '{\"display_name\": \"Fleet Operations (Services)\", \"color\": \"green\"}'"
  echo "  FROM SPECIFICATION \$\$"
  cat "$OPS_SPEC"
  echo "\$\$;"
  echo
  echo "CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_ADMIN_AGENT"
  echo "  COMMENT = '$TRACK'"
  echo "  PROFILE = '{\"display_name\": \"Fleet Admin (Install)\", \"color\": \"orange\"}'"
  echo "  FROM SPECIFICATION \$\$"
  cat "$ADMIN_SPEC"
  echo "\$\$;"
  echo
  echo "CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SUPER_AGENT"
  echo "  COMMENT = '$TRACK'"
  echo "  PROFILE = '{\"display_name\": \"Fleet Superuser (All Capabilities)\", \"color\": \"purple\"}'"
  echo "  FROM SPECIFICATION \$\$"
  cat "$SUPER_SPEC"
  echo "\$\$;"
} > "$SQL_FILE"

echo "[create_agents] applying FLEET_AGENT + FLEET_OPS_AGENT + FLEET_ADMIN_AGENT + FLEET_SUPER_AGENT via $CONNECTION ..."
snow sql -c "$CONNECTION" -f "$SQL_FILE"

# ── re-apply the agent USAGE grants that CREATE OR REPLACE just dropped ──
#
# Mirrors role_binding.sql verbatim (its lines for FLEET_AGENT / FLEET_OPS_AGENT /
# FLEET_ADMIN_AGENT / FLEET_SUPER_AGENT). Keep the two in sync; role_binding.sql
# remains authoritative.
#
# TENET 3: FLEET_SUPER_AGENT goes to FLEET_APP_ADMIN ONLY. Never add
# FLEET_APP_USER here - the super agent attaches all three MCP bundles, so that
# would hand every app user service suspension and region deletion, and this
# GRANT is the only thing preventing it.
#
# Each grant sits in its own exception handler because `snow sql -f` aborts the
# whole file at the first error, and on a fresh install the roles legitimately do
# not exist yet. The block then reports, per agent, whether a USAGE grant is
# actually present - so a silent revocation cannot pass unnoticed again.
GRANT_FILE=$(mktemp); trap 'rm -f "$SQL_FILE" "$GRANT_FILE"; rm -rf "${PRUNED_DIR:-}"' EXIT

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

echo "[create_agents] re-applying agent USAGE grants (CREATE OR REPLACE dropped them) ..."
snow sql -c "$CONNECTION" -f "$GRANT_FILE"

# Verify per agent that a USAGE grant is actually present, not just OWNERSHIP.
# Done from the shell rather than in Snowflake Scripting: the cursor FOR loop
# needs a declared cursor, and four one-line probes are easier to read in CI
# output than a packed status string. Reported, never fatal - PENDING is the
# correct state on a fresh install, where role_binding.sql (step 8) follows.
echo "[create_agents] verifying agent grants ..."
GRANTS_PENDING=0
for AGENT in FLEET_AGENT FLEET_OPS_AGENT FLEET_ADMIN_AGENT FLEET_SUPER_AGENT; do
  GRANTEE=$(snow sql -c "$CONNECTION" --format json \
    -q "SHOW GRANTS ON AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.${AGENT}" 2>/dev/null \
    | python3 -c "
import json,sys
try:
    rows = json.load(sys.stdin)
except Exception:
    print(''); sys.exit(0)
rows = rows[0] if rows and isinstance(rows[0], list) else rows
print(next((r.get('grantee_name','') for r in rows
            if str(r.get('privilege','')).upper() == 'USAGE'), ''))
" 2>/dev/null || echo "")
  if [ -n "$GRANTEE" ]; then
    echo "  [grant] ${AGENT}: OK (USAGE -> ${GRANTEE})"
  else
    echo "  [grant] ${AGENT}: PENDING (no USAGE grant)"
    GRANTS_PENDING=1
  fi
done

if [ "$GRANTS_PENDING" = "1" ]; then
  echo "[create_agents] done, but some agents have NO USAGE grant:"
  echo "[create_agents]   fresh install -> install step 8 (role_binding.sql) applies it;"
  echo "[create_agents]   otherwise     -> run role_binding.sql, the authoritative grant pass."
else
  echo "[create_agents] done. All four agents carry a USAGE grant."
fi
