#!/usr/bin/env bash
#
# install-fleet-apps / provision_engine.sh
#
# Build + provision the LIVE ORS/VROOM routing engine end-to-end so the neutral
# ROUTING_PLATFORM.CONTRACT seam resolves to a real engine. This is the native
# replacement for the retired build-routing-solution skill (Phase C).
#
# It is intentionally HEAVY (builds 4 SPCS images + a region routing graph, tens
# of minutes), so install_fleet_apps.sh calls it by default (unless --no-engine)
# AND only when the engine is absent.
#
# The engine keeps the OPENROUTESERVICE_APP.CORE runtime namespace (the
# ROUTING_PLATFORM.PROVIDERS adapters abstract the DB name). Engine images are
# pushed to OPENROUTESERVICE_APP.core.image_repository because the committed
# service YAMLs reference that repo path; the engine DB/stages are created here
# (IF NOT EXISTS) independent of whatever infra the app images use.
#
# Usage:
#   bash scripts/provision_engine.sh <connection>
#
# Env overrides:
#   CONTAINER_CMD=podman|docker   Force the container runtime (else auto-detect)
#   SKIP_IMAGES=1                 Skip the 4-image build/push (images already pushed)
#   SKIP_MODULES=1                Skip the SQL module load (engine SQL already applied)
#   REGION=SanFrancisco           Informational; the default region is bootstrapped
#                                 by the tail of 03_region_management.sql.
set -euo pipefail

CONN="${1:?connection name required as 1st arg}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ORS_APP_DIR="$SKILL_DIR/openrouteservice_app"
MODULES_DIR="$ORS_APP_DIR/app/modules"
SCRIPTS="$SKILL_DIR/scripts"
REGION="${REGION:-SanFrancisco}"
ENGINE_REPO="OPENROUTESERVICE_APP.core.image_repository"

note() { echo "[provision-engine] $*"; }

# Every `snow sql` invocation opens a NEW session, so the AGENTS.md-mandated
# query_tag has to be prepended to each -q payload rather than set once up front.
TRACK='{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"engine"}}'
TAG_SQL="ALTER SESSION SET query_tag = '$TRACK';"

# ── 0. preflight: container runtime ─────────────────────────────
# Auto-detect prefers docker: a default podman machine is 2 GB and OOMs the ORS
# image build, and Docker Desktop is usually larger-provisioned. Override with
# CONTAINER_CMD=docker|podman.
if [ -z "${CONTAINER_CMD:-}" ]; then
  if command -v docker >/dev/null 2>&1; then CONTAINER_CMD=docker
  elif command -v podman >/dev/null 2>&1; then CONTAINER_CMD=podman
  else echo "ERROR: neither docker nor podman found"; exit 1; fi
fi
note "container runtime: $CONTAINER_CMD (override with CONTAINER_CMD=docker|podman)"
# Warn on a small podman machine - the ORS image build is memory-heavy.
if [ "$CONTAINER_CMD" = "podman" ] && command -v podman >/dev/null 2>&1; then
  PODMAN_MEM_MB=$(podman machine inspect --format '{{.Resources.Memory}}' 2>/dev/null | head -1)
  if [ -n "${PODMAN_MEM_MB:-}" ] && [ "${PODMAN_MEM_MB:-0}" -lt 4096 ] 2>/dev/null; then
    note "  WARN: podman machine has ${PODMAN_MEM_MB} MB (<4 GB); image builds may OOM. Use CONTAINER_CMD=docker or grow the podman machine."
  fi
fi
# crane gives a reliable SPCS manifest commit; `docker push` intermittently hangs
# on the final manifest PUT (bearer token expires mid-upload). build_push prefers
# crane when present (docker runtime only - crane reads ~/.docker/config.json).
if command -v crane >/dev/null 2>&1; then
  note "  crane found: using crane for SPCS image pushes (avoids docker-push manifest hang)"
else
  note "  crane NOT found: falling back to '$CONTAINER_CMD push' (may hang on SPCS manifest commit). Recommended: brew install crane"
fi
command -v snow >/dev/null 2>&1 || { echo "ERROR: 'snow' CLI not found"; exit 1; }
snow sql -c "$CONN" -q "$TAG_SQL SELECT CURRENT_ACCOUNT();" >/dev/null 2>&1 \
  || { echo "ERROR: connection '$CONN' does not work"; exit 1; }

# ── 1. ensure OPENROUTESERVICE_APP engine infra (db/schemas/stages/repo) ──
note "[1/6] ensuring OPENROUTESERVICE_APP engine infra..."
# Warehouses come from the single owner, scripts/warehouses.sql. This script used
# to run a bare `CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS` with no size
# and no auto-suspend at all, so on an account where this step ran first the
# warehouse silently took Snowflake's defaults instead of the spec the three
# .sql layers declared.
snow sql -c "$CONN" -f "$SCRIPTS/warehouses.sql" >/dev/null 2>&1 || true

snow sql -c "$CONN" -q "
  $TAG_SQL
  CREATE DATABASE IF NOT EXISTS OPENROUTESERVICE_APP
    COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\",\"component\":\"engine\"}}';
  ALTER DATABASE OPENROUTESERVICE_APP SET DATA_RETENTION_TIME_IN_DAYS = 0;
  CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_APP.CORE
    COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\",\"component\":\"engine\"}}';
  CREATE SCHEMA IF NOT EXISTS OPENROUTESERVICE_APP.TRAVEL_MATRIX
    COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\",\"component\":\"matrix\"}}';
  CREATE IMAGE REPOSITORY IF NOT EXISTS OPENROUTESERVICE_APP.CORE.IMAGE_REPOSITORY
    COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\",\"component\":\"engine\"}}';
  CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE ENCRYPTION = (TYPE='SNOWFLAKE_SSE') DIRECTORY = (ENABLE=TRUE)
    COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\",\"component\":\"engine\"}}';
  CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE ENCRYPTION = (TYPE='SNOWFLAKE_SSE') DIRECTORY = (ENABLE=TRUE)
    COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\",\"component\":\"engine\"}}';
  CREATE FILE FORMAT IF NOT EXISTS OPENROUTESERVICE_APP.CORE.RAW_TEXT_FF
    TYPE = CSV
    FIELD_DELIMITER = NONE
    RECORD_DELIMITER = NONE
    SKIP_HEADER = 0
    FIELD_OPTIONALLY_ENCLOSED_BY = NONE
    COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\",\"component\":\"engine\"}}';
  CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.ORS_ELEVATION_CACHE_SPCS_STAGE ENCRYPTION = (TYPE='SNOWFLAKE_SSE') DIRECTORY = (ENABLE=TRUE)
    COMMENT = '{\"origin\":\"sf_sit-is-fleet\",\"name\":\"oss-install-fleet-apps\",\"version\":{\"major\":1,\"minor\":0},\"attributes\":{\"is_quickstart\":1,\"source\":\"app\",\"component\":\"engine\"}}';
" >/tmp/ifa_engine_infra.log 2>&1 \
  || { echo "ERROR: engine infra creation failed"; tail -30 /tmp/ifa_engine_infra.log; exit 1; }

# ── 2. image-tag consistency pre-flight ─────────────────────────
note "[2/6] validating engine image tags vs service YAMLs..."
bash "$SCRIPTS/check_image_versions.sh" || exit 1

# ── 2b. gateway resilience + observability window pre-flight ─────
# Wired HERE because this script is what ships routing_service.py into an image,
# and because .githooks/pre-commit does not run in this repo (core.hooksPath is
# unset), which makes the deploy the only place a regression can actually be
# stopped. Guards three silent defects measured in
# OBSERVABILITY.ORS_REQUEST_LOG: a deterministic ORS 6099 retried at full size
# (44 logical calls -> 119 error events), a circuit breaker that cleared its own
# counter on the final failed attempt and so had never opened, and metrics
# windows computed against SYSDATE() on a TIMESTAMP_LTZ column, which put the
# "last hour" cutoff 360 minutes in the future and left that panel permanently
# empty. Opt out with ORS_OBSERVABILITY_VERIFY=0.
if [ "${ORS_OBSERVABILITY_VERIFY:-1}" != "0" ]; then
  note "[2/6] validating gateway retry/breaker policy + metrics windows..."
  python3 "$SCRIPTS/check_ors_observability.py" \
    || { echo "ERROR: ORS observability/resilience gate failed (see above)."; exit 1; }
fi

# ── 3. build + push the 4 engine images ─────────────────────────
if [ "${SKIP_IMAGES:-0}" != "1" ]; then
  note "[3/6] building + pushing 4 engine images (see references/build-images.md)..."
  # shellcheck disable=SC1091
  source "$SKILL_DIR/image-versions.env"
  if [ "$CONTAINER_CMD" = "podman" ]; then
    REGISTRY_HOST=$(snow spcs image-repository url "$ENGINE_REPO" -c "$CONN" | cut -d'/' -f1)
    snow spcs image-registry token --format=JSON -c "$CONN" | "$CONTAINER_CMD" login "$REGISTRY_HOST" -u 0sessiontoken --password-stdin
  else
    snow spcs image-registry login -c "$CONN" >/dev/null
  fi
  REPO_URL=$(snow spcs image-repository url "$ENGINE_REPO" -c "$CONN" --format JSON \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['message'])")
  note "  registry=$REPO_URL"

  # Push one image ref. Prefers crane (docker runtime only): `docker push` to the
  # SPCS registry intermittently hangs on the final manifest PUT when the bearer
  # token expires mid-upload; crane commits the manifest reliably. Refresh the
  # registry token before each crane push so multi-image sequences don't expire.
  # Falls back to the native push if crane is absent or the crane path errors.
  push_image() { # <full-image-ref>
    local ref="$1"
    if command -v crane >/dev/null 2>&1 && [ "$CONTAINER_CMD" = "docker" ] && [ "${USE_CRANE_PUSH:-1}" = "1" ]; then
      [ "${REGISTRY_LOGGED_IN:-0}" = "1" ] || snow spcs image-registry login -c "$CONN" >/dev/null 2>&1 || true
      local tar; tar="$(mktemp -t orsimg.XXXXXX).tar"
      if "$CONTAINER_CMD" save "$ref" -o "$tar" && crane push "$tar" "$ref"; then
        rm -f "$tar"; return 0
      fi
      rm -f "$tar"
      echo "  crane push failed for $ref; falling back to '$CONTAINER_CMD push'"
    fi
    "$CONTAINER_CMD" push "$ref"
  }

  # Registry-to-registry copy for upstream images with zero added layers. Skips
  # the local daemon, the tar round-trip, and amd64 emulation on ARM Macs.
  # --platform linux/amd64 flattens the upstream multi-arch manifest list; SPCS
  # needs a single-platform manifest.
  copy_image() { # <upstream-ref> <dest-ref>
    if command -v crane >/dev/null 2>&1; then
      [ "${REGISTRY_LOGGED_IN:-0}" = "1" ] || snow spcs image-registry login -c "$CONN" >/dev/null 2>&1 || true
      crane copy --platform linux/amd64 "$1" "$2" && return 0
      echo "  crane copy failed for $1 -> $2; falling back to local build"
    fi
    return 1
  }

  build_push() { # <context-subdir> <image-name> <tag>
    note "  -> $2:$3"
    "$CONTAINER_CMD" build --rm --platform linux/amd64 \
      -t "$REPO_URL/$2:$3" "$ORS_APP_DIR/services/$1" >/tmp/ifa_img_$2.log 2>&1 \
      || { echo "ERROR: build $2 failed"; tail -40 /tmp/ifa_img_$2.log; exit 1; }
    push_image "$REPO_URL/$2:$3" >/tmp/ifa_push_$2.log 2>&1 \
      || { echo "ERROR: push $2 failed (see /tmp/ifa_push_$2.log). For reliable SPCS pushes install crane: brew install crane"; tail -20 /tmp/ifa_push_$2.log; exit 1; }
  }

  # The openrouteservice Dockerfile is a bare `FROM openrouteservice/openrouteservice:<tag>`
  # with zero added layers, so a registry-to-registry copy is digest-identical to
  # building it locally - and skips a ~500 MB docker save + tar round-trip (~15 min).
  # Guard: if the Dockerfile grows a layer beyond the two-line passthrough, or the
  # tags diverge, fall back to build_push (the copy would no longer be equivalent).
  ORS_DOCKERFILE="$ORS_APP_DIR/services/openrouteservice/Dockerfile"
  ORS_NON_BOILERPLATE=$(grep -cvE '^\s*(#|ARG |FROM |$)' "$ORS_DOCKERFILE" || true)
  ors_image() {
    if [ "${ORS_NON_BOILERPLATE:-0}" -eq 0 ] \
       && [ "$OPENROUTESERVICE_TAG" = "$OPENROUTESERVICE_BASE_TAG" ]; then
      note "  -> openrouteservice:$OPENROUTESERVICE_TAG (crane copy from Docker Hub - zero added layers)"
      if ! copy_image "openrouteservice/openrouteservice:${OPENROUTESERVICE_BASE_TAG}" \
                      "$REPO_URL/openrouteservice:${OPENROUTESERVICE_TAG}"; then
        note "  crane copy unavailable or failed; falling back to local build"
        build_push openrouteservice openrouteservice "$OPENROUTESERVICE_TAG"
      fi
    else
      note "  openrouteservice Dockerfile has custom layers or tags diverge; building locally"
      build_push openrouteservice openrouteservice "$OPENROUTESERVICE_TAG"
    fi
  }

  # ── run all four image jobs CONCURRENTLY ──────────────────────────────────
  # Measured serially: openrouteservice 15m22s, downloader 3m31s,
  # routing_reverse_proxy 3m44s, vroom-docker 6m04s -> 29m40s, which was 32% of a
  # 93m install. ONE image dominates the other three combined, so running them
  # together bounds the phase at the slowest single image (~15m) instead of their
  # sum, saving ~13m. The dominant job is a network-bound registry-to-registry
  # copy while the other three are small local builds, so they contend little.
  #
  # TRAP: `build_push` reports failure with `exit 1`. From a BACKGROUND job that
  # exits only that subshell - it CANNOT abort this script. Backgrounding without
  # collecting each job's status would turn a failed image into a phase that looks
  # successful here and then dies minutes later at CREATE SERVICE, with the real
  # cause far upstream of the visible error. So each PID is waited on
  # INDIVIDUALLY, its status is checked, and the phase fails loudly naming every
  # job that failed. Do not replace this with a bare `wait` (which reports only
  # the LAST job) or with `&&` chaining (which serialises them again).
  #
  # The registry login is hoisted OUT of push_image/copy_image on purpose. Each
  # ran `snow spcs image-registry login`, which writes ~/.docker/config.json;
  # four concurrent writers to one credential file is a torn-write race, and the
  # symptom would be an unrelated-looking auth failure on a random image. One
  # login up front also fits the new timing better than the old per-push refresh
  # did: serially the 4th push started ~24 min in and genuinely needed a fresh
  # token, whereas now all four start at t0 and finish inside one token lifetime.
  snow spcs image-registry login -c "$CONN" >/dev/null 2>&1 || true
  REGISTRY_LOGGED_IN=1

  IMG_JOB_PIDS=(); IMG_JOB_NAMES=()
  ors_image & IMG_JOB_PIDS+=("$!"); IMG_JOB_NAMES+=("openrouteservice")
  build_push downloader downloader "$DOWNLOADER_TAG" \
    & IMG_JOB_PIDS+=("$!"); IMG_JOB_NAMES+=("downloader")
  build_push gateway routing_reverse_proxy "$ROUTING_REVERSE_PROXY_TAG" \
    & IMG_JOB_PIDS+=("$!"); IMG_JOB_NAMES+=("routing_reverse_proxy")
  build_push vroom vroom-docker "$VROOM_DOCKER_TAG" \
    & IMG_JOB_PIDS+=("$!"); IMG_JOB_NAMES+=("vroom-docker")

  note "  4 image jobs running concurrently (pids: ${IMG_JOB_PIDS[*]}); waiting..."
  IMG_FAILED=""
  for i in "${!IMG_JOB_PIDS[@]}"; do
    if ! wait "${IMG_JOB_PIDS[$i]}"; then
      IMG_FAILED="$IMG_FAILED ${IMG_JOB_NAMES[$i]}"
    fi
  done
  if [ -n "$IMG_FAILED" ]; then
    echo "ERROR: engine image job(s) failed:$IMG_FAILED"
    echo "       build logs: /tmp/ifa_img_<name>.log   push logs: /tmp/ifa_push_<name>.log"
    echo "       Re-run after fixing; completed images are already in the repo and"
    echo "       a repeat push of an unchanged image is a cheap no-op."
    exit 1
  fi
  note "  all 4 image jobs succeeded"
  note "  verifying pushed images..."

  snow spcs image-repository list-images "$ENGINE_REPO" -c "$CONN" 2>/dev/null | tail -8 || true
else
  note "[3/6] SKIP_IMAGES=1 - skipping image build/push."
fi

# ── 3b. ONLY_IMAGES: stop here so the caller can overlap the image phase ──────
# install_fleet_apps.sh runs this script TWICE when it overlaps the image build
# with the ~204 MB seed upload: once with ONLY_IMAGES=1 in the background (phases
# 1-3), then again with SKIP_IMAGES=1 in the foreground (phases 1,2,4,5,6).
#
# The split point is here, and not later, because everything above touches only
# the engine namespace's own DDL (CREATE ... IF NOT EXISTS) plus the image
# repository and registry, which the seed never reads or writes. Phases 4-6 are
# what must NOT overlap the seed: `seed_data.sql` pre-creates a stub
# OPENROUTESERVICE_APP.CORE + an empty REGION_CATALOG for the loader to LEFT JOIN,
# and the region bootstrap in module 03 writes that same namespace for real.
# (Verified safe to overlap phases 1-3: no engine module does CREATE OR REPLACE
# or DROP on REGION_CATALOG, so the concurrent stub can never be clobbered.)
#
# Phases 1-2 are deliberately re-run by the second invocation rather than skipped:
# they are seconds of idempotent DDL plus the tag pre-flight, and re-running keeps
# the foreground pass self-sufficient if the overlap is disabled.
if [ "${ONLY_IMAGES:-0}" = "1" ]; then
  note "ONLY_IMAGES=1 - engine images done; leaving stage/modules/services to the caller."
  exit 0
fi

# ── 4. upload staged map/config + service specs ─────────────────
note "[4/6] uploading staged files + service specs to @ORS_SPCS_STAGE..."
snow stage copy "$ORS_APP_DIR/staged_files/SanFrancisco.osm.pbf" \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ -c "$CONN" --overwrite >/dev/null && \
snow stage copy "$ORS_APP_DIR/staged_files/ors-config.yml" \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/SanFrancisco/ -c "$CONN" --overwrite >/dev/null && \
snow stage copy "$SCRIPTS/download_map.py" \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/scripts/ -c "$CONN" --overwrite >/dev/null && \
snow stage copy "$ORS_APP_DIR/services/downloader/downloader_spec.yaml" \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/downloader/ -c "$CONN" --overwrite >/dev/null && \
snow stage copy "$ORS_APP_DIR/services/gateway/routing-gateway-service.yaml" \
  @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/gateway/ -c "$CONN" --overwrite >/dev/null \
  || { echo "ERROR: staging engine files/specs failed"; exit 1; }

# ── 5. load engine SQL modules (fail-fast) ──────────────────────
if [ "${SKIP_MODULES:-0}" != "1" ]; then
  note "[5/6] loading engine SQL modules 01-08,15 (default region bootstraps in 03)..."
  for m in 01_core_infra.sql 02_routing_functions.sql 03_region_management.sql \
           04_service_lifecycle.sql 05_matrix_pipeline.sql 06_matrix_ops.sql \
           07_studio_jobs.sql 08_observability.sql 15_route_optimization_seed.sql; do
    bash "$SCRIPTS/run_sql_module.sh" "$CONN" "$MODULES_DIR/$m" || exit 1
  done
  # Resume observability ingest + retention tasks (created suspended by module 08).
  snow sql -c "$CONN" -q "
    $TAG_SQL
    ALTER TASK IF EXISTS OPENROUTESERVICE_APP.OBSERVABILITY.ORS_METRICS_INGEST_TASK RESUME;
    ALTER TASK IF EXISTS OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG_PURGE_TASK RESUME;
  " >/dev/null 2>&1 || true
else
  note "[5/6] SKIP_MODULES=1 - skipping SQL module load."
fi

# ── 6. verify ───────────────────────────────────────────────────
note "[6/6] engine services (ORS_SERVICE_${REGION} builds its graph on first boot, 5-15 min):"
snow sql -c "$CONN" -q "$TAG_SQL SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;" 2>/dev/null | tail -12 || true

echo
echo "================================================================"
echo " ORS engine provisioning complete."
echo "   region (default bootstrap): $REGION"
echo "   ORS_SERVICE_${REGION} may take 5-15 min to finish building graphs."
echo "   Re-run install_fleet_apps.sh (idempotent) - layer 3 will report LIVE."
echo "================================================================"
