#!/usr/bin/env bash
#
# install-fleet-apps / verify_gateway_version.sh
#
# MANDATORY first post-deploy check for any ORS/VROOM GATEWAY (routing_reverse_proxy)
# image change. SPCS serves container images BY TAG and does NOT re-pull an
# unchanged tag on `ALTER SERVICE ... FROM SPEC` or SUSPEND/RESUME - it uses the
# node-cached image. As a result SYSTEM$GET_SERVICE_STATUS reports the SPEC's tag
# (looks correct) even when the running container is stale. This probe reads the
# version BAKED INTO the running gateway image (GATEWAY_VERSION, surfaced via
# ORS_STATUS(region):gateway_version) and asserts it equals ROUTING_REVERSE_PROXY_TAG
# from image-versions.env. If they differ, the deploy did NOT take effect - bump to
# a NEW tag and redeploy.
#
# Usage:
#   bash scripts/verify_gateway_version.sh <connection> [region]
#
# Read-only: issues a single SELECT ORS_STATUS(...). Creates no objects.

set -euo pipefail

CONN="${1:?connection name required as 1st arg}"
REGION="${2:-}"   # optional; NULL/default region works (probe tests the gateway, not ORS graphs)
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="$SKILL_DIR/image-versions.env"

# shellcheck disable=SC1090
source "$VERSION_FILE"
EXPECTED="${ROUTING_REVERSE_PROXY_TAG:?ROUTING_REVERSE_PROXY_TAG missing from image-versions.env}"

if [ -n "$REGION" ]; then
  ARG="'$REGION'"
else
  ARG="NULL"
fi

echo "[verify-gateway] expected gateway build = $EXPECTED (ROUTING_REVERSE_PROXY_TAG)"

# ORS_STATUS returns VARIANT; :gateway_version is attached by the gateway regardless
# of ORS graph state, so this works even when the region's ORS is suspended.
RUNNING=$(snow sql -c "$CONN" --format json \
  -q "SELECT OPENROUTESERVICE_APP.CORE.ORS_STATUS(${ARG}):gateway_version::string AS V" 2>/dev/null \
  | python3 -c "import sys,json
try:
    d=json.load(sys.stdin)
    print((d[0].get('V') or d[0].get('v') or '') if d else '')
except Exception:
    print('')" 2>/dev/null || true)

if [ -z "$RUNNING" ] || [ "$RUNNING" = "None" ]; then
  echo "[verify-gateway] FAIL: could not read ORS_STATUS(...):gateway_version."
  echo "  - Ensure OPENROUTESERVICE_APP.CORE.routing_gateway_service is RUNNING (resume it), then re-run."
  echo "  - If gateway_version is absent, the running image predates this probe (rebuild + bump tag)."
  exit 1
fi

echo "[verify-gateway] running gateway build  = $RUNNING (reported by the live container)"

# Cross-check the spec tag SPCS THINKS it is running (may differ from the code).
SPEC_TAG=$(snow sql -c "$CONN" --format json \
  -q "SELECT SYSTEM\$GET_SERVICE_STATUS('OPENROUTESERVICE_APP.CORE.routing_gateway_service') AS S" 2>/dev/null \
  | python3 -c "import sys,json,re
try:
    d=json.load(sys.stdin); tags=set(re.findall(r'routing_reverse_proxy:(v[0-9.]+)', str(d)))
    print(sorted(tags)[-1] if tags else '')
except Exception:
    print('')" 2>/dev/null || true)
[ -n "$SPEC_TAG" ] && echo "[verify-gateway] spec image tag (status)  = $SPEC_TAG"

if [ "$RUNNING" != "$EXPECTED" ]; then
  echo ""
  echo "[verify-gateway] FAIL: running gateway build ($RUNNING) != expected ($EXPECTED)."
  echo "  SPCS serves images BY TAG and does not re-pull an unchanged tag. Re-pushing the"
  echo "  same tag with new code keeps the OLD image live. Fix: bump ROUTING_REVERSE_PROXY_TAG"
  echo "  AND GATEWAY_VERSION to a NEW value, rebuild + push, ALTER SERVICE ... FROM SPEC, re-run."
  exit 1
fi

echo "[verify-gateway] PASS: running gateway build matches expected tag ($EXPECTED)."
exit 0
