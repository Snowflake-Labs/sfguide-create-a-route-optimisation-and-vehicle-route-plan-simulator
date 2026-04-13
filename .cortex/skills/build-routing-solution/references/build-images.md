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
REGISTRY_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection> | cut -d'/' -f1)
snow spcs image-registry token --format=JSON -c <connection> | podman login $REGISTRY_URL -u 0sessiontoken --password-stdin
```

## 2. Get Repository URL

```bash
REPO_URL=$(snow spcs image-repository url openrouteservice_setup.public.image_repository -c <connection>)
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
  native_app/services/openrouteservice
$CONTAINER_CMD push $REPO_URL/openrouteservice:v9.0.0

# downloader image
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/downloader:v0.0.3 \
  native_app/services/downloader
$CONTAINER_CMD push $REPO_URL/downloader:v0.0.3

# gateway image (gunicorn, ThreadPoolExecutor concurrency)
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/routing_reverse_proxy:v1.0.0 \
  native_app/services/gateway
$CONTAINER_CMD push $REPO_URL/routing_reverse_proxy:v1.0.0

# vroom image
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -t $REPO_URL/vroom-docker:v1.0.1 \
  native_app/services/vroom
$CONTAINER_CMD push $REPO_URL/vroom-docker:v1.0.1

# ors control app (React management UI)
# On ARM Macs (Apple Silicon), esbuild crashes under QEMU amd64 emulation.
# Build the React app and server locally first, then use the runtime-only Dockerfile:
cd native_app/services/ors_control_app
npm ci && npm run build && npm run build:server
mv .dockerignore .dockerignore.bak 2>/dev/null || true
$CONTAINER_CMD build --rm --platform linux/amd64 \
  -f Dockerfile.runtime \
  -t $REPO_URL/ors_control_app:v1.0.98 .
mv .dockerignore.bak .dockerignore 2>/dev/null || true
$CONTAINER_CMD push $REPO_URL/ors_control_app:v1.0.98
cd ../../..
```

**Note:** The ors_control_app build requires `cd` because `npm ci` must run in the package directory and `.dockerignore` must be renamed in place. The `Dockerfile.runtime` already exists in the directory — do NOT recreate it with a heredoc.

> `npm ci` may report vulnerabilities. These are in dev/build dependencies and do not affect the runtime container.

## 4. Verify All Images Pushed

Docker push progress output uses carriage returns that may be invisible in some terminals. Always verify pushes completed:

```bash
snow spcs image-repository list-images openrouteservice_setup.public.image_repository -c <connection>
```

Expected: 5 images with tags matching the Image Inventory below.

## Image Inventory

| Service | Image | Tag |
|---------|-------|-----|
| OpenRouteService | openrouteservice | v9.0.0 |
| Downloader | downloader | v0.0.3 |
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

## CRITICAL: Pre-Deploy Version Check

Before running `snow app run`, you MUST verify that all image version tags in
`manifest.yml` match the tags you just built and pushed. A version mismatch
causes deployment to fail with `Image ... not found`.

Run the validation script:
```bash
bash scripts/check_image_versions.sh
```

Or manually compare:
```bash
grep -ohE '[a-z_-]+:v[0-9.]+' native_app/app/manifest.yml | sort
grep -rohE '[a-z_-]+:v[0-9.]+' native_app/services/*/*.yaml | sort -u
```

All 5 pairs must match: openrouteservice, downloader, routing_reverse_proxy, vroom-docker, ors_control_app.
