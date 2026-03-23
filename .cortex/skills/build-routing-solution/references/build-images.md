# Build and Push Container Images

Authenticate, build, and push all 5 container images to the Snowflake SPCS image repository.

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

Use `$CONTAINER_CMD` (podman or docker) as detected in Step 2 of the main workflow.

```bash
# openrouteservice image
cd native_app/services/openrouteservice
$CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/openrouteservice:v9.0.0 .
$CONTAINER_CMD push $REPO_URL/openrouteservice:v9.0.0

# downloader image
cd ../downloader
$CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/downloader:v0.0.3 .
$CONTAINER_CMD push $REPO_URL/downloader:v0.0.3

# gateway image (gunicorn, ThreadPoolExecutor concurrency)
cd ../gateway
$CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/routing_reverse_proxy:v0.9.6 .
$CONTAINER_CMD push $REPO_URL/routing_reverse_proxy:v0.9.6

# vroom image
cd ../vroom
$CONTAINER_CMD build --rm --platform linux/amd64 -t $REPO_URL/vroom-docker:v1.0.1 .
$CONTAINER_CMD push $REPO_URL/vroom-docker:v1.0.1

# ors control app (React management UI)
cd ../ors_control_app
# On ARM Macs (Apple Silicon), esbuild crashes under QEMU amd64 emulation.
# Build locally first, then use a runtime-only Dockerfile:
npm ci && npm run build && npm run build:server
cat > Dockerfile.runtime <<'RTEOF'
FROM node:20-alpine
WORKDIR /app
COPY dist ./dist
COPY dist-server ./dist-server
COPY package.json ./
COPY package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
EXPOSE 3001
CMD ["node", "dist-server/index.js"]
RTEOF
mv .dockerignore .dockerignore.bak 2>/dev/null
$CONTAINER_CMD build --rm --platform linux/amd64 -f Dockerfile.runtime -t $REPO_URL/ors_control_app:v1.0.28 .
mv .dockerignore.bak .dockerignore 2>/dev/null; rm -f Dockerfile.runtime
$CONTAINER_CMD push $REPO_URL/ors_control_app:v1.0.28

# return to working directory
cd ../../..
```

## Image Inventory

| Service | Image | Tag |
|---------|-------|-----|
| OpenRouteService | openrouteservice | v9.0.0 |
| Downloader | downloader | v0.0.3 |
| Gateway | routing_reverse_proxy | v0.9.6 |
| VROOM | vroom-docker | v1.0.1 |
| Control App | ors_control_app | v1.0.28 |

## Expected Duration

5-10 minutes for all 5 images.

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
