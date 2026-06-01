#!/usr/bin/env bash
# =============================================================================
# Emergency Response Intelligence -- single-command installer.
# =============================================================================
# Runs the full SQL pipeline AND uploads the bundled IPAWS seed parquet so the
# install needs zero manual steps.
#
# Usage:
#   ./scripts/install.sh                       # uses default snow connection
#   ./scripts/install.sh -c my-connection      # uses a named snow connection
#
# Prerequisites (per SKILL.md):
#   * snow CLI authenticated (snow connection list)
#   * ORS app deployed via build-routing-solution (4 services RUNNING)
#   * fleet-intelligence-taxis already deployed (provides the DRIVERS layer)
#   * ROUTING_ANALYTICS warehouse exists
# =============================================================================
set -euo pipefail

CONN_ARG=""
if [[ "${1:-}" == "-c" && -n "${2:-}" ]]; then
  CONN_ARG="-c $2"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE_ONLY_SQL="$SKILL_DIR/references/sql-pipeline-stage-only.sql"
FULL_SQL="$SKILL_DIR/references/sql-pipeline.sql"
PARQUET_FILE="$SKILL_DIR/assets/ipaws_sf.parquet"
STAGE="@EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE/"

if [[ ! -f "$STAGE_ONLY_SQL" ]]; then
  echo "ERROR: missing $STAGE_ONLY_SQL" >&2
  exit 1
fi
if [[ ! -f "$FULL_SQL" ]]; then
  echo "ERROR: missing $FULL_SQL" >&2
  exit 1
fi
if [[ ! -f "$PARQUET_FILE" ]]; then
  echo "ERROR: missing $PARQUET_FILE -- run scripts/build_ipaws_sf_seed.py first" >&2
  exit 1
fi

echo "[1/3] Installing Marketplace listings, database, schemas, and IPAWS_SEED_STAGE"
# shellcheck disable=SC2086
snow sql $CONN_ARG -f "$STAGE_ONLY_SQL"

echo "[2/3] Uploading $(basename "$PARQUET_FILE") to $STAGE"
# shellcheck disable=SC2086
snow stage copy $CONN_ARG --overwrite "$PARQUET_FILE" "$STAGE"

echo "[3/3] Running full sql-pipeline.sql (Dynamic Tables, COPY INTO, verification)"
# shellcheck disable=SC2086
snow sql $CONN_ARG -f "$FULL_SQL"

echo
echo "Install complete. Verify with:"
echo "  snow sql $CONN_ARG -q \"SELECT 'IPAWS_SF', COUNT(*) FROM EMERGENCY_RESPONSE.SOURCE.IPAWS_SF\""
