#!/usr/bin/env bash
#
# check_container_runtime_negative.sh - prove check_container_runtime.sh fails
# on the shipped defect: a resolver that selects by CLI presence alone.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d -t ctrneg.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/presence_only.sh" <<'EOF'
resolve_container_runtime() {
  if [ -n "${CONTAINER_CMD:-}" ]; then return 0; fi
  if command -v docker >/dev/null 2>&1; then CONTAINER_CMD=docker
  elif command -v podman >/dev/null 2>&1; then CONTAINER_CMD=podman
  else CONTAINER_RUNTIME_ERROR="neither docker nor podman found"; return 1; fi
}
EOF

if bash "$HERE/check_container_runtime.sh" "$WORK/presence_only.sh" >"$WORK/out" 2>&1; then
  echo "FAIL: gate passed a presence-only resolver"; cat "$WORK/out"; exit 1
fi
grep -q "docker CLI, daemon down; podman up: expected podman, got: docker" "$WORK/out" \
  || { echo "FAIL: gate did not convict the daemon-down case"; cat "$WORK/out"; exit 1; }
echo "PASS: presence-only resolver rejected"
