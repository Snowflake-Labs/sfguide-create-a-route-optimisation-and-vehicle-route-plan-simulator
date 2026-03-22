#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR"
CONNECTION="fleet_test_evals"
PKG_STAGE="@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c|--connection) CONNECTION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== Uploading setup_script.sql + modules ==="

echo "--- [1/3] Upload setup_script.sql ---"
snow sql -c "$CONNECTION" -q "PUT 'file://${APP_DIR}/setup_script.sql' ${PKG_STAGE}/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;"

echo "--- [2/3] Upload modules/ ---"
for f in "$APP_DIR"/modules/*.sql; do
  fname=$(basename "$f")
  echo "  uploading $fname"
  snow sql -c "$CONNECTION" -q "PUT 'file://${f}' ${PKG_STAGE}/modules/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;"
done

echo "--- [3/3] ALTER APPLICATION UPGRADE ---"
snow sql -c "$CONNECTION" -q "ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING ${PKG_STAGE};"

echo "=== App upgraded successfully ==="
