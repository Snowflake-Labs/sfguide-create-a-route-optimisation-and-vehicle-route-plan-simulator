# Build and Push the ORS Engine Container Images

Authenticate, build, and push the four ORS/VROOM engine container images to the Snowflake SPCS image repository. (The two app images - FLEET_SA_APP / FLEET_ADMIN_APP - are built by their own `deploy_fleet_*_app.sh` scripts, not here.)

> **Working directory:** All commands below must be run from `.cortex/skills/install-fleet-apps/`. Run `cd .cortex/skills/install-fleet-apps` before starting.

All paths below are relative to the skill directory (`.cortex/skills/install-fleet-apps/`). Each build command uses `-f` and a build context path so no `cd` commands are needed.

## 1. Authenticate with SPCS Image Registry

**Docker:**
```bash
snow spcs image-registry login -c <connection>
```

**Podman:**
```bash
REGISTRY_URL=$(snow spcs image-repository url OPENROUTESERVICE_APP.core.image_repository -c <connection> | cut -d'/' -f1)
snow spcs image-registry token --format=JSON -c <connection> | podman login $REGISTRY_URL -u 0sessiontoken --password-stdin
```

## 2. Get Repository URL

Use `--format JSON` to avoid line-wrapping confusion in captured stdout:

```bash
REPO_URL=$(snow spcs image-repository url OPENROUTESERVICE_APP.core.image_repository -c <connection> --format JSON \
  | python3 -c "import sys, json; print(json.load(sys.stdin)['message'])")
echo "$REPO_URL"
```

## 3. Build and Push Images

Use `$CONTAINER_CMD` (podman or docker) as detected in Step 2 of the main workflow. All commands run from the skill directory without changing directories.

> **Agent note:** `$CONTAINER_CMD` does not persist across separate bash calls. Prefix each command
> with `CONTAINER_CMD=podman` (or `docker`) inline, or chain all commands with `&&` in one call.

```bash
# Load image tags from the single source of truth
source image-versions.env

# openrouteservice image
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/openrouteservice:$OPENROUTESERVICE_TAG \
  openrouteservice_app/services/openrouteservice
$CONTAINER_CMD push $REPO_URL/openrouteservice:$OPENROUTESERVICE_TAG

# downloader image
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/downloader:$DOWNLOADER_TAG \
  openrouteservice_app/services/downloader
$CONTAINER_CMD push $REPO_URL/downloader:$DOWNLOADER_TAG

# gateway image (gunicorn, ThreadPoolExecutor concurrency)
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/routing_reverse_proxy:$ROUTING_REVERSE_PROXY_TAG \
  openrouteservice_app/services/gateway
$CONTAINER_CMD push $REPO_URL/routing_reverse_proxy:$ROUTING_REVERSE_PROXY_TAG

# vroom image
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/vroom-docker:$VROOM_DOCKER_TAG \
  openrouteservice_app/services/vroom
$CONTAINER_CMD push $REPO_URL/vroom-docker:$VROOM_DOCKER_TAG
```

## 4. Verify All Images Pushed

Push progress output uses carriage returns (`\r`) for in-place updates. When piped through `tail` or captured in logs, progress lines overwrite each other and appear invisible. Do not assume a push is stuck - verify completion separately:

```bash
snow spcs image-repository list-images OPENROUTESERVICE_APP.core.image_repository -c <connection>
```

To see real-time progress, redirect stderr to a file: `podman push $URL 2>push.log && tail -5 push.log`

Expected: 4 images with tags matching the Image Inventory below.

## Image Inventory

Tag values are the single source of truth in [`image-versions.env`](../image-versions.env). The `source` command in the build/push block above loads them as shell variables.

| Service | Image | Tag variable |
|---------|-------|--------------|
| OpenRouteService | openrouteservice | `$OPENROUTESERVICE_TAG` |
| Downloader | downloader | `$DOWNLOADER_TAG` |
| Gateway | routing_reverse_proxy | `$ROUTING_REVERSE_PROXY_TAG` |
| VROOM | vroom-docker | `$VROOM_DOCKER_TAG` |

## Expected Duration

| Image | Approx Size | Build | First Push |
|-------|-------------|-------|------------|
| openrouteservice | ~500 MB | 3-5 min | 10-15 min |
| downloader | <100 MB | <1 min | 1-2 min |
| routing_reverse_proxy | <100 MB | <1 min | 1-2 min |
| vroom-docker | ~200 MB | 2-3 min | 3-5 min |

Total first push: 20-30 minutes. Subsequent pushes with cached layers: ~5 minutes.

## Pinned Upstream Base Images

All upstream base images are pinned to explicit versions - never use `:latest`. Pinned versions are documented in `image-versions.env` (variables `OPENROUTESERVICE_BASE_TAG`, `VROOM_BASE_TAG`).

| Service | Base image | Pinned version | Source |
|---------|-----------|----------------|--------|
| OpenRouteService | `openrouteservice/openrouteservice` | `v9.0.0` | [Docker Hub](https://hub.docker.com/r/openrouteservice/openrouteservice/tags) |
| VROOM | `ghcr.io/vroom-project/vroom-docker` | `v1.14.0` | [GHCR](https://github.com/VROOM-Project/vroom-docker/pkgs/container/vroom-docker) |
| Downloader | `python:3.10-slim-buster` | `3.10-slim-buster` | [Docker Hub](https://hub.docker.com/_/python/tags) |
| Gateway | `python:3.10-slim-buster` | `3.10-slim-buster` | [Docker Hub](https://hub.docker.com/_/python/tags) |

### Bumping an upstream version

1. Check the upstream release notes for breaking changes.
2. Test locally: `docker run --rm <image>:<new_tag>` - verify it starts cleanly.
3. Update the `ARG BASE_IMAGE=` line in the corresponding Dockerfile.
4. Update `image-versions.env` (`OPENROUTESERVICE_BASE_TAG` or `VROOM_BASE_TAG`).
5. Rebuild and push the SPCS image (bump `*_TAG` in `image-versions.env`).
6. Redeploy: update service YAML, upload to stage, `ALTER SERVICE … SUSPEND` / update spec / `RESUME`.
7. Verify: `SHOW SERVICES` - confirm status is `RUNNING`.

## Common Errors

- **Authentication failure**: Run `snow spcs image-registry login` (Docker) or use session token (Podman) before pushing
- **Podman machine not running**: `podman machine start`
- **Docker daemon not running**: Start Docker Desktop
- **Podman pushes to wrong registry**: Use manual `--creds` flag, see `references/troubleshooting.md`