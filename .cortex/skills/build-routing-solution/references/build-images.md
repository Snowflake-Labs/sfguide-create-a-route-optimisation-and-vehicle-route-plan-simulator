# Build and Push Container Images

Authenticate, build, and push all 5 container images to the Snowflake SPCS image repository.

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

```bash
REPO_URL=$(snow spcs image-repository url OPENROUTESERVICE_APP.core.image_repository -c <connection>)
echo $REPO_URL
```

## 3. Build and Push Images

Use `$CONTAINER_CMD` (podman or docker) as detected in Step 2 of the main workflow. All commands run from the skill directory without changing directories.

> **Agent note:** `$CONTAINER_CMD` does not persist across separate bash calls. Prefix each command
> with `CONTAINER_CMD=podman` (or `docker`) inline, or chain all commands with `&&` in one call.

```bash
# openrouteservice image
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/openrouteservice:v9.0.0 \
  openrouteservice_app/services/openrouteservice
$CONTAINER_CMD push $REPO_URL/openrouteservice:v9.0.0

# downloader image
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/downloader:v0.0.3 \
  native_app/services/downloader
$CONTAINER_CMD push $REPO_URL/downloader:v0.0.3

# gateway image (gunicorn, ThreadPoolExecutor concurrency)
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/routing_reverse_proxy:v1.0.0 \
  openrouteservice_app/services/gateway
$CONTAINER_CMD push $REPO_URL/routing_reverse_proxy:v1.0.0

# vroom image
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/vroom-docker:v1.0.1 \
  openrouteservice_app/services/vroom
$CONTAINER_CMD push $REPO_URL/vroom-docker:v1.0.1

# ors control app (React management UI)
# On ARM Macs (Apple Silicon), esbuild crashes under QEMU amd64 emulation.
# Build the React app and server locally first, then use the runtime-only Dockerfile:
cd openrouteservice_app/services/ors_control_app
npm install --legacy-peer-deps && npm run build && npm run build:server
mv .dockerignore .dockerignore.bak 2>/dev/null || true
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -f Dockerfile.runtime \
  -t $REPO_URL/ors_control_app:v1.0.98 .
mv .dockerignore.bak .dockerignore 2>/dev/null || true
$CONTAINER_CMD push $REPO_URL/ors_control_app:v1.0.98
cd ../../..
```

**Note:** The ors_control_app build requires `cd` because `npm install` must run in the package directory and `.dockerignore` must be renamed in place. The `Dockerfile.runtime` already exists in the directory — do NOT recreate it with a heredoc.

> **CRITICAL — shell operator precedence:** Run the npm commands and the `mv`/`docker` commands as **separate bash calls** (or at minimum separate lines). Do NOT chain them all with `&&` into one call with `|| true` at the end. Due to shell left-associativity, `a && b && c || true` means `(a && b && c) || true` — so if `npm run build` fails, `|| true` swallows the error and docker still runs with an incomplete dist, producing a white-page app. The `mv .dockerignore.bak ... || true` must only apply to the `mv` itself.

> **luma.gl version pins:** All four `@luma.gl/*` packages in `package.json` must be pinned to `~9.2.6` (not `^9.1.0` or `^9.2.x`). Using `^` allows npm to resolve `@luma.gl/core` and `@luma.gl/webgl` to `9.3.x`, which removed the `getVertexFormatFromAttribute` export still used by `@luma.gl/engine@9.2.6`, causing the vite build to fail.

> `npm install --legacy-peer-deps` is required due to peer dependency conflicts between `@deck.gl@9.2.x` and `@luma.gl` packages. Vulnerability warnings in dev/build dependencies do not affect the runtime container.

## 4. Verify All Images Pushed

Docker push progress output uses carriage returns that may be invisible in some terminals. Always verify pushes completed:

```bash
snow spcs image-repository list-images OPENROUTESERVICE_APP.core.image_repository -c <connection>
```

Expected: 5 images with tags matching the Image Inventory below.

## Image Inventory

| Service | Image | Tag |
|---------|-------|-----|
| OpenRouteService | openrouteservice | v9.0.0 |
| Downloader | downloader | v0.3.3 |
| Gateway | routing_reverse_proxy | v1.0.0 |
| VROOM | vroom-docker | v1.0.1 |
| Control App | ors_control_app | v1.0.98 |

## Expected Duration

10-20 minutes for all 5 images on first push. Subsequent pushes with cached layers take ~5 minutes.

## Common Errors

- **Authentication failure**: Run `snow spcs image-registry login` (Docker) or use session token (Podman) before pushing
- **Podman machine not running**: `podman machine start`
- **Docker daemon not running**: Start Docker Desktop
- **ARM Mac esbuild crash**: Build React app locally first, use `Dockerfile.runtime` (see ors_control_app section above)
- **Podman pushes to wrong registry**: Use manual `--creds` flag, see `references/troubleshooting.md`