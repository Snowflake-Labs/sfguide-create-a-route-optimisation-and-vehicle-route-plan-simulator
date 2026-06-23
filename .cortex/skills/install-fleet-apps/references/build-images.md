# Build and Push Container Images

Authenticate, build, and push all 5 container images to the Snowflake SPCS image repository.

> **Working directory:** All commands below must be run from `.cortex/skills/build-routing-solution/`. Run `cd .cortex/skills/build-routing-solution` before starting.

All paths below are relative to the skill directory (`.cortex/skills/build-routing-solution/`). Each build command uses `-f` and a build context path so no `cd` commands are needed.

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
source openrouteservice_app/image-versions.env

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

# ors control app (React management UI)
# On ARM Macs (Apple Silicon), esbuild crashes under QEMU amd64 emulation.
# Build the React app and server locally first, then use --ignorefile to allow dist/ into context:
cd openrouteservice_app/services/ors_control_app
npm install --legacy-peer-deps && npm run build && npm run build:server
$CONTAINER_CMD build --rm --platform linux/amd64 \
  --ignorefile .dockerignore.prebuilt \
  -f Dockerfile.runtime \
  -t $REPO_URL/ors_control_app:$ORS_CONTROL_APP_TAG .
$CONTAINER_CMD push $REPO_URL/ors_control_app:$ORS_CONTROL_APP_TAG
cd ../../..
```

**Note:** The ors_control_app build requires `cd` because `npm install` must run in the package directory. The `--ignorefile .dockerignore.prebuilt` flag uses an alternative ignore file that allows `dist/` and `dist-server/` into the build context. Do NOT rename or edit `.dockerignore`. The `Dockerfile.runtime` already exists in the directory — do NOT recreate it with a heredoc.

> **Docker on ARM Mac:** Docker does not support the `--ignorefile` flag (it is Podman-only). Instead, temporarily swap the ignore file before building:
> ```bash
> source ../../../openrouteservice_app/image-versions.env
> cp .dockerignore .dockerignore.bak && cp .dockerignore.prebuilt .dockerignore
> docker build --rm --platform linux/amd64 \
>   -f Dockerfile.runtime \
>   -t $REPO_URL/ors_control_app:$ORS_CONTROL_APP_TAG .
> mv .dockerignore.bak .dockerignore
> docker push $REPO_URL/ors_control_app:$ORS_CONTROL_APP_TAG
> ```

> **CRITICAL — shell operator precedence:** Run the npm commands and the `docker`/`podman` commands as **separate bash calls** (or at minimum separate lines). Do NOT chain them all with `&&` into one call with `|| true` at the end. Due to shell left-associativity, `a && b && c || true` means `(a && b && c) || true` — so if `npm run build` fails, `|| true` swallows the error and docker still runs with an incomplete dist, producing a white-page app.

> **luma.gl version pins:** All four `@luma.gl/*` packages in `package.json` must be pinned to `~9.2.6` (not `^9.1.0` or `^9.2.x`). Using `^` allows npm to resolve `@luma.gl/core` and `@luma.gl/webgl` to `9.3.x`, which removed the `getVertexFormatFromAttribute` export still used by `@luma.gl/engine@9.2.6`, causing the vite build to fail.

> `npm install --legacy-peer-deps` is required due to peer dependency conflicts between `@deck.gl@9.2.x` and `@luma.gl` packages. Vulnerability warnings in dev/build dependencies do not affect the runtime container.

## 4. Verify All Images Pushed

Push progress output uses carriage returns (`\r`) for in-place updates. When piped through `tail` or captured in logs, progress lines overwrite each other and appear invisible. Do not assume a push is stuck — verify completion separately:

```bash
snow spcs image-repository list-images OPENROUTESERVICE_APP.core.image_repository -c <connection>
```

To see real-time progress, redirect stderr to a file: `podman push $URL 2>push.log && tail -5 push.log`

Expected: 5 images with tags matching the Image Inventory below.

## Image Inventory

Tag values are the single source of truth in [`openrouteservice_app/image-versions.env`](../openrouteservice_app/image-versions.env). The `source` command in the build/push block above loads them as shell variables.

| Service | Image | Tag variable |
|---------|-------|--------------|
| OpenRouteService | openrouteservice | `$OPENROUTESERVICE_TAG` |
| Downloader | downloader | `$DOWNLOADER_TAG` |
| Gateway | routing_reverse_proxy | `$ROUTING_REVERSE_PROXY_TAG` |
| VROOM | vroom-docker | `$VROOM_DOCKER_TAG` |
| Control App | ors_control_app | `$ORS_CONTROL_APP_TAG` |

## Expected Duration

| Image | Approx Size | Build | First Push |
|-------|-------------|-------|------------|
| openrouteservice | ~500 MB | 3-5 min | 10-15 min |
| downloader | <100 MB | <1 min | 1-2 min |
| routing_reverse_proxy | <100 MB | <1 min | 1-2 min |
| vroom-docker | ~200 MB | 2-3 min | 3-5 min |
| ors_control_app | ~150 MB | 2-3 min | 2-4 min |

Total first push: 20-30 minutes. Subsequent pushes with cached layers: ~5 minutes.

## Pinned Upstream Base Images

All upstream base images are pinned to explicit versions — never use `:latest`. Pinned versions are documented in `openrouteservice_app/image-versions.env` (variables `OPENROUTESERVICE_BASE_TAG`, `VROOM_BASE_TAG`).

| Service | Base image | Pinned version | Source |
|---------|-----------|----------------|--------|
| OpenRouteService | `openrouteservice/openrouteservice` | `v9.0.0` | [Docker Hub](https://hub.docker.com/r/openrouteservice/openrouteservice/tags) |
| VROOM | `ghcr.io/vroom-project/vroom-docker` | `v1.14.0` | [GHCR](https://github.com/VROOM-Project/vroom-docker/pkgs/container/vroom-docker) |
| Downloader | `python:3.10-slim-buster` | `3.10-slim-buster` | [Docker Hub](https://hub.docker.com/_/python/tags) |
| Gateway | `python:3.10-slim-buster` | `3.10-slim-buster` | [Docker Hub](https://hub.docker.com/_/python/tags) |

### Bumping an upstream version

1. Check the upstream release notes for breaking changes.
2. Test locally: `docker run --rm <image>:<new_tag>` — verify it starts cleanly.
3. Update the `ARG BASE_IMAGE=` line in the corresponding Dockerfile.
4. Update `image-versions.env` (`OPENROUTESERVICE_BASE_TAG` or `VROOM_BASE_TAG`).
5. Rebuild and push the SPCS image (bump `*_TAG` in `image-versions.env`).
6. Redeploy: update service YAML, upload to stage, `ALTER SERVICE … SUSPEND` / update spec / `RESUME`.
7. Verify: `SHOW SERVICES` — confirm status is `RUNNING`.

## Common Errors

- **Authentication failure**: Run `snow spcs image-registry login` (Docker) or use session token (Podman) before pushing
- **Podman machine not running**: `podman machine start`
- **Docker daemon not running**: Start Docker Desktop
- **ARM Mac esbuild crash**: Build React app locally first, use `--ignorefile .dockerignore.prebuilt` (see ors_control_app section above)
- **Podman pushes to wrong registry**: Use manual `--creds` flag, see `references/troubleshooting.md`