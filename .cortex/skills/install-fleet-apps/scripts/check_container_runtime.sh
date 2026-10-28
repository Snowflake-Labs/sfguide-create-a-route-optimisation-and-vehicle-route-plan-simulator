#!/usr/bin/env bash
#
# check_container_runtime.sh [resolver.sh]
#
# Behavioural test of lib/container_runtime.sh with fake docker/podman binaries.
# The defect it pins: selection by `command -v docker` picked a docker CLI whose
# daemon was down (Docker Desktop installed, not running), so the engine build
# failed and podman was never tried. Also statically checks that every image
# build site goes through the resolver instead of hardcoding docker.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="${1:-$HERE/lib/container_runtime.sh}"
WORK="$(mktemp -d -t ctrruntime.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0

# fake <name> <info: ok|fail|hang> [machine: none|stopped] [build: ok|refuse]
fake() {
  local name="$1" info="$2" machine="${3:-none}" build="${4:-ok}" bin="$WORK/bin"
  mkdir -p "$bin"
  cat >"$bin/$name" <<EOF
#!/usr/bin/env bash
state="$WORK/$name.started"
case "\$1" in
  info)
    case "$info" in ok) exit 0 ;; hang) sleep 30; exit 0 ;; esac
    [ -f "\$state" ] && exit 0; exit 1 ;;
  build)
    [ "$build" = refuse ] && { echo "ERROR: Sign in to continue using Docker Desktop. Membership in the [snowflakeinc] organization is required." >&2; exit 1; }
    exit 0 ;;
  machine)
    case "\$2" in
      list) [ "$machine" = stopped ] && echo podman-machine-default; exit 0 ;;
      start) touch "\$state"; exit 0 ;;
    esac ;;
esac
exit 0
EOF
  chmod +x "$bin/$name"
}

# case <label> <expect: docker|podman|ERROR> <resolve args> -- env assignments...
run_case() {
  local label="$1" expect="$2" args="$3"; shift 3
  local out
  out=$(env -i PATH="$WORK/bin:/usr/bin:/bin" CONTAINER_PROBE_SECS=1 "$@" bash -c \
    "source '$LIB'; if resolve_container_runtime $args; then echo \"\$CONTAINER_CMD\"; else echo \"ERROR \$CONTAINER_RUNTIME_ERROR\"; fi" 2>/dev/null)
  case "$out" in
    "$expect"*) echo "  ok    $label -> ${out%% *}" ;;
    *) echo "  FAIL  $label: expected $expect, got: $out"; FAILS=$((FAILS + 1)) ;;
  esac
}

reset() { rm -rf "$WORK/bin" "$WORK"/*.started; }

echo "container runtime resolver ($LIB)"
reset; fake docker fail; fake podman ok
run_case "docker CLI, daemon down; podman up" podman ""
reset; fake docker ok; fake podman ok
run_case "both healthy prefers docker" docker ""
reset; fake docker hang; fake podman ok
run_case "wedged docker info times out" podman ""
reset; fake docker fail; fake podman fail stopped
run_case "stopped podman machine is started" podman ""
reset; fake docker fail; fake podman fail stopped
run_case "--no-start never starts a machine" ERROR "--no-start"
reset; fake docker fail; fake podman fail none
run_case "nothing usable names both remedies" "ERROR docker CLI found" ""
reset; fake docker ok none refuse; fake podman ok
run_case "docker answers info but refuses build (sign-in policy)" podman ""
reset; fake docker ok none refuse; fake podman fail none
run_case "refused build names the refusal" "ERROR docker build refused: ERROR: Sign in" ""
reset; fake docker ok none refuse; fake podman ok
run_case "explicit refused docker reports the refusal" "ERROR CONTAINER_CMD=docker is not usable (docker build refused" "" CONTAINER_CMD=docker
reset; fake docker fail; fake podman ok
run_case "explicit CONTAINER_CMD is not replaced" ERROR "" CONTAINER_CMD=docker
reset
run_case "nothing installed" "ERROR neither" ""

echo "image build sites use the resolver"
for f in provision_engine.sh deploy_fleet_sa_app.sh deploy_fleet_admin_app.sh; do
  src=$(grep -v '^[[:space:]]*#' "$HERE/$f")
  if ! printf '%s' "$src" | grep -q 'resolve_container_runtime'; then
    echo "  FAIL  $f does not call resolve_container_runtime"; FAILS=$((FAILS + 1))
  elif printf '%s' "$src" | grep -Eq '(^|[[:space:];&|(])docker (build|push)|command -v docker'; then
    echo "  FAIL  $f hardcodes docker build/push or selects by CLI presence"; FAILS=$((FAILS + 1))
  else
    echo "  ok    $f"
  fi
done

[ "$FAILS" -eq 0 ] && echo "PASS" || { echo "FAILED: $FAILS"; exit 1; }
