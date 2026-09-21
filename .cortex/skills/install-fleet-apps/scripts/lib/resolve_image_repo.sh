#!/usr/bin/env bash
#
# install-fleet-apps / lib/resolve_image_repo.sh
#
# Resolve the SPCS image repository an app image should be pushed to, and whose
# path the rendered service spec must reference.
#
# WHY THIS EXISTS
# ---------------
# An account can legitimately hold TWO image repositories:
#
#   OPENROUTESERVICE_APP.core.image_repository  - the 4 ENGINE images. Pinned
#       there unconditionally by provision_engine.sh, because the committed
#       engine service YAMLs under openrouteservice_app/services/ reference that
#       path literally and are NOT rewritten at deploy time.
#   FLEET_INTELLIGENCE.CORE.IMAGE_REPOSITORY    - the self-provisioned FLEET-owned
#       repo (references/infra.sql), used for the two APP images whenever the ORS
#       infra did not already exist when install_fleet_apps.sh resolved step 1.
#
# On a from-scratch install the engine has not run yet at step 1, so the apps land
# in the FLEET repo while the engine later creates its own. install_fleet_apps.sh
# exports IMAGE_REPO_SQL_NAME so its child deploys agree.
#
# A STANDALONE deploy has no such export. The previous behaviour was to default to
# the ORS repo, which made the effective repo depend on the invocation path rather
# than on account state: after the engine created the ORS repo, standalone
# redeploys started pushing there and flipped the live service off the repo the
# installer had used - fragmenting one app's tags across both repos. Worse, on a
# `--no-engine` account the ORS repo does not exist at all, so the hardcoded
# default failed at `snow spcs image-repository url`.
#
# Resolution order (first match wins):
#   1. an already-exported IMAGE_REPO_SQL_NAME (installer path stays authoritative)
#   2. the repo the LIVE service's spec already points at (makes a redeploy sticky,
#      so an app never silently migrates repos mid-life)
#   3. FLEET_INTELLIGENCE.CORE.IMAGE_REPOSITORY, if it exists (installer default)
#   4. OPENROUTESERVICE_APP.core.image_repository, if it exists (reuse-ORS installs)
#   5. hard failure with the remedy - never a guess
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve_image_repo.sh"
#   IMAGE_REPO_SQL_NAME=$(resolve_image_repo "$CONNECTION" fleet_sa_app "$SERVICE_FQN")
#
# Read-only: issues only ALTER SESSION SET query_tag + DESCRIBE/SHOW.

# Every `snow sql` invocation opens a NEW session, so the AGENTS.md-mandated
# query_tag has to be prepended to each payload (a tag set by a previous
# invocation does not carry over).
_RIR_TAG_SQL="ALTER SESSION SET query_tag = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\"}}';"

# _rir_repo_exists <connection> <database> <schema> <repo-name>
_rir_repo_exists() {
  local conn="$1" db="$2" schema="$3" repo="$4" out
  out=$(snow sql -c "$conn" --format=CSV \
          -q "$_RIR_TAG_SQL SHOW IMAGE REPOSITORIES IN SCHEMA ${db}.${schema};" 2>/dev/null) || return 1
  printf '%s' "$out" | grep -qiF "\"${repo}\"" && return 0
  printf '%s' "$out" | grep -qiE "(^|,)${repo}(,|$)" && return 0
  return 1
}

# _rir_repo_from_service <connection> <service-fqn> <image-name>
# Echoes "<db>.<schema>.<repo>" derived from the running spec's image path, or
# nothing when the service does not exist / has no parseable image line.
_rir_repo_from_service() {
  local conn="$1" svc="$2" img="$3" out path
  out=$(snow sql -c "$conn" --format=CSV \
          -q "$_RIR_TAG_SQL DESCRIBE SERVICE ${svc};" 2>/dev/null) || return 0
  # Spec image paths are always lowercase, '<db>/<schema>/<repo>/<image>:<tag>'.
  path=$(printf '%s' "$out" \
           | grep -oE '[a-z0-9_]+/[a-z0-9_]+/[a-z0-9_]+/'"${img}"':' \
           | head -1)
  [ -n "$path" ] || return 0
  # Strip the trailing '<image>:' then swap separators back to a SQL name.
  printf '%s' "${path%/${img}:}" | tr '/' '.'
}

# resolve_image_repo <connection> <image-name> [service-fqn]
resolve_image_repo() {
  local conn="${1:?connection required}" img="${2:?image name required}" svc="${3:-}"
  local from_svc

  if [ -n "${IMAGE_REPO_SQL_NAME:-}" ]; then
    printf '%s' "$IMAGE_REPO_SQL_NAME"
    return 0
  fi

  if [ -n "$svc" ]; then
    from_svc=$(_rir_repo_from_service "$conn" "$svc" "$img")
    if [ -n "$from_svc" ]; then
      printf '%s' "$from_svc"
      return 0
    fi
  fi

  if _rir_repo_exists "$conn" FLEET_INTELLIGENCE CORE IMAGE_REPOSITORY; then
    printf '%s' "FLEET_INTELLIGENCE.CORE.IMAGE_REPOSITORY"
    return 0
  fi

  if _rir_repo_exists "$conn" OPENROUTESERVICE_APP CORE image_repository; then
    printf '%s' "OPENROUTESERVICE_APP.core.image_repository"
    return 0
  fi

  echo "ERROR: could not resolve an SPCS image repository for '${img}' on connection '${conn}'." >&2
  echo "       Neither FLEET_INTELLIGENCE.CORE.IMAGE_REPOSITORY nor" >&2
  echo "       OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY exists, and ${svc:-the service} has no image path." >&2
  echo "       Run install_fleet_apps.sh (step 1 provisions the FLEET-owned infra)," >&2
  echo "       or export IMAGE_REPO_SQL_NAME=<db>.<schema>.<repo> explicitly." >&2
  return 1
}
