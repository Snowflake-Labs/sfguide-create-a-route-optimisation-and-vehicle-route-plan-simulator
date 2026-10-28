#!/usr/bin/env bash
#
# check_container_runtime_negative.sh - prove check_container_runtime.sh fails
# on both shipped defects:
#   1. selection by CLI presence alone (docker CLI with its daemon down won), and
#   2. selection by `info` alone (Docker Desktop under an org sign-in policy
#      answers `info` and then refuses every build).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d -t ctrneg.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0

cat >"$WORK/presence_only.sh" <<'EOF'
resolve_container_runtime() {
  if [ -n "${CONTAINER_CMD:-}" ]; then return 0; fi
  if command -v docker >/dev/null 2>&1; then CONTAINER_CMD=docker
  elif command -v podman >/dev/null 2>&1; then CONTAINER_CMD=podman
  else CONTAINER_RUNTIME_ERROR="neither docker nor podman found"; return 1; fi
}
EOF

# The real resolver with the build probe removed.
sed -e 's/^  _with_deadline "\$((secs \* 3))".*$/  true/' \
  "$HERE/lib/container_runtime.sh" >"$WORK/info_only.sh"
grep -q '^  true$' "$WORK/info_only.sh" \
  || { echo "FAIL: could not strip the build probe (resolver changed shape)"; exit 1; }

# mutant <file> <case label that must be convicted>
mutant() {
  if bash "$HERE/check_container_runtime.sh" "$1" >"$WORK/out" 2>&1; then
    echo "FAIL: gate passed $(basename "$1")"; FAILS=$((FAILS + 1))
  elif ! grep -q "FAIL  $2" "$WORK/out"; then
    echo "FAIL: $(basename "$1") not convicted on: $2"; cat "$WORK/out"; FAILS=$((FAILS + 1))
  else
    echo "PASS: $(basename "$1") rejected ($2)"
  fi
}

mutant "$WORK/presence_only.sh" "docker CLI, daemon down; podman up"
mutant "$WORK/info_only.sh" "docker answers info but refuses build"
[ "$FAILS" -eq 0 ] || exit 1
