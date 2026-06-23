#!/usr/bin/env bash
#
# install-fleet-apps / create_agents.sh
#
# Creates the two Cortex Agents the new architecture needs, from the trimmed
# (agnostic) specs under fleet_sa_app/app/:
#   - FLEET_AGENT      (consumer) from agent-spec.json      -> attaches ROUTING_MCP
#   - FLEET_OPS_AGENT  (operator) from ops-agent-spec.json  -> attaches FLEET_OPS_MCP
#
# Idempotent: CREATE OR REPLACE AGENT. The synapse MCP servers referenced by the
# specs must exist first (run the synapse bundle install), and the SYNAPSE_USER
# schema is ensured here.
#
# Usage:
#   bash .cortex/skills/install-fleet-apps/scripts/create_agents.sh <connection>
set -euo pipefail

CONNECTION="${1:?usage: create_agents.sh <connection>}"
REPO_ROOT=$(git rev-parse --show-toplevel)
APP_DIR="$REPO_ROOT/.cortex/skills/install-fleet-apps/fleet_sa_app/app"
USER_SPEC="$APP_DIR/agent-spec.json"
OPS_SPEC="$APP_DIR/ops-agent-spec.json"

for f in "$USER_SPEC" "$OPS_SPEC"; do
  [ -f "$f" ] || { echo "ERROR: missing agent spec $f"; exit 1; }
  python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" \
    || { echo "ERROR: $f is not valid JSON"; exit 1; }
done

TRACK='{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
SQL_FILE=$(mktemp); trap 'rm -f "$SQL_FILE"' EXIT

{
  echo "ALTER SESSION SET query_tag = '$TRACK';"
  echo "CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SYNAPSE_USER COMMENT = '$TRACK';"
  echo
  echo "CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_AGENT"
  echo "  COMMENT = '$TRACK'"
  echo "  PROFILE = '{\"display_name\": \"Fleet Intelligence\", \"color\": \"blue\"}'"
  echo "  FROM SPECIFICATION \$\$"
  cat "$USER_SPEC"
  echo "\$\$;"
  echo
  echo "CREATE OR REPLACE AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_OPS_AGENT"
  echo "  COMMENT = '$TRACK'"
  echo "  PROFILE = '{\"display_name\": \"Fleet Operations\", \"color\": \"green\"}'"
  echo "  FROM SPECIFICATION \$\$"
  cat "$OPS_SPEC"
  echo "\$\$;"
} > "$SQL_FILE"

echo "[create_agents] applying FLEET_AGENT + FLEET_OPS_AGENT via $CONNECTION ..."
snow sql -c "$CONNECTION" -f "$SQL_FILE"
echo "[create_agents] done."
