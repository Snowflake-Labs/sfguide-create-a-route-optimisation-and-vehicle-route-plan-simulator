#!/usr/bin/env bash
#
# install-fleet-apps / lib/container_runtime.sh  (sourced, not executed)
#
# Picks a container runtime by HEALTH, not by presence. `command -v docker`
# only proves the CLI is on PATH: with Docker Desktop installed but not running
# it still selected docker, the build failed, and podman was never tried.
#
# A daemon that answers is still not enough: Docker Desktop under an
# organization sign-in policy answers `docker info` and then refuses every
# `docker build`. So a runtime is usable only once a local no-network build of a
# FROM-scratch image succeeds; the refusal text is kept for the error message.
#
#   resolve_container_runtime [--no-start]
#     Sets CONTAINER_CMD to a runtime that answers `info` AND can build, or returns 1
#     with CONTAINER_RUNTIME_ERROR set. Docker is preferred when healthy (a
#     default 2 GB podman machine OOMs the ORS image build). A stopped podman
#     machine is started once unless --no-start (preflight must not change state).
#     An explicit CONTAINER_CMD is health-checked too, never silently replaced.

# Run a command with a deadline, output to $2; macOS ships no `timeout`, and a
# wedged Docker Desktop can hang `docker info` indefinitely.
#   _with_deadline <secs> <outfile> <cmd...>
_with_deadline() {
  local secs="$1" out="$2" pid i
  shift 2
  "$@" >"$out" 2>&1 &
  pid=$!
  for ((i = 0; i < secs * 2; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      return $?
    fi
    sleep 0.5
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  echo "timed out after ${secs}s" >>"$out"
  return 1
}

# Usable = `info` answers and a FROM-scratch image builds. Sets
# _RUNTIME_REFUSAL to the build's first error line when only the build fails.
_runtime_healthy() {
  local cmd="$1" secs="${CONTAINER_PROBE_SECS:-20}" dir rc tag="fleet-runtime-probe:latest"
  command -v "$cmd" >/dev/null 2>&1 || return 1
  dir=$(mktemp -d -t fleetprobe.XXXXXX) || return 1
  if ! _with_deadline "$secs" "$dir/info.log" "$cmd" info; then
    rm -rf "$dir"; return 1
  fi
  printf 'FROM scratch\nLABEL fleet.runtime.probe=1\n' >"$dir/Dockerfile"
  _with_deadline "$((secs * 3))" "$dir/build.log" "$cmd" build -q -t "$tag" "$dir"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    _RUNTIME_REFUSAL="$cmd build refused: $(grep -m1 -iE 'error|denied|sign|requir|refus|timed out' "$dir/build.log" || head -1 "$dir/build.log")"
  else
    "$cmd" rmi "$tag" >/dev/null 2>&1 || true
  fi
  rm -rf "$dir"
  return "$rc"
}

_podman_start_machine() {
  command -v podman >/dev/null 2>&1 || return 1
  # Only a machine that exists can be started; creating one is the user's call.
  [ -n "$(podman machine list --format '{{.Name}}' 2>/dev/null | head -1)" ] || return 1
  echo "[container-runtime] podman machine not running; starting it" >&2
  podman machine start >/dev/null 2>&1 || true
  _runtime_healthy podman
}

_remedy() {
  case "$1" in
    docker) echo "start Docker Desktop (signed in, if your organization requires it) and retry" ;;
    podman) echo "run 'podman machine start' (or 'podman machine init' first) and retry" ;;
  esac
}

resolve_container_runtime() {
  local start=1
  [ "${1:-}" = "--no-start" ] && start=0
  CONTAINER_RUNTIME_ERROR=""
  _RUNTIME_REFUSAL=""
  if [ -n "${CONTAINER_CMD:-}" ]; then
    if _runtime_healthy "$CONTAINER_CMD" \
       || { [ "$CONTAINER_CMD" = podman ] && [ "$start" = 1 ] && _podman_start_machine; }; then
      return 0
    fi
    CONTAINER_RUNTIME_ERROR="CONTAINER_CMD=$CONTAINER_CMD is not usable (${_RUNTIME_REFUSAL:-'$CONTAINER_CMD info' failed}): $(_remedy "$CONTAINER_CMD")"
    return 1
  fi
  local refused=""
  if _runtime_healthy docker; then CONTAINER_CMD=docker; return 0; fi
  [ -n "$_RUNTIME_REFUSAL" ] && { refused="$_RUNTIME_REFUSAL"; \
    echo "[container-runtime] $refused; trying podman" >&2; }
  if _runtime_healthy podman; then CONTAINER_CMD=podman; return 0; fi
  if [ "$start" = 1 ] && _podman_start_machine; then CONTAINER_CMD=podman; return 0; fi
  local seen=""
  if [ -n "$refused" ]; then seen="$refused; "
  elif command -v docker >/dev/null 2>&1; then seen="docker CLI found but daemon not reachable; "; fi
  command -v podman >/dev/null 2>&1 && seen="${seen}podman CLI found but no running machine; "
  [ -z "$seen" ] && seen="neither docker nor podman is installed; "
  CONTAINER_RUNTIME_ERROR="${seen}either $(_remedy docker), or $(_remedy podman) (CONTAINER_CMD=podman forces it)"
  return 1
}

# Log the selected runtime in to the SPCS registry. `snow spcs image-registry
# login` drives the docker CLI, so podman logs in with a session token instead.
#   container_registry_login <connection> <registry-host-or-repo-url>
container_registry_login() {
  local conn="$1" host="${2%%/*}"
  if [ "$CONTAINER_CMD" = podman ]; then
    snow spcs image-registry token --format=JSON -c "$conn" \
      | podman login "$host" -u 0sessiontoken --password-stdin >/dev/null
  else
    snow spcs image-registry login -c "$conn" >/dev/null
  fi
}
