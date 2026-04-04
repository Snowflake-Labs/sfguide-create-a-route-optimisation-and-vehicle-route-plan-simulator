# Plan: Deploy All Fixes and Test

## What Changed (recap)

Two fixes were made:

1. **SQL fix** (already deployed via ALTER APPLICATION UPGRADE): Added ORS error retry loop in `BUILD_TRAVEL_TIME_RANGE_REGION` in [setup_script.sql](/.cortex/skills/build-routing-solution/native_app/app/setup_script.sql). After batch processing, it detects origins with `MATRIX_RESULT:durations IS NULL`, waits 15s, deletes failed rows, and re-inserts (up to 3 passes).

2. **UI fix** (needs Docker deploy): Updated [MatrixViewer.tsx](/.cortex/skills/build-routing-solution/native_app/services/ors_control_app/src/components/MatrixViewer.tsx) to block clicks on destination-only hexes with a warning message instead of showing "0 reachable".

## Steps

### Step 1: Create Dockerfile.runtime

The [deploy.sh](/.cortex/skills/build-routing-solution/native_app/services/ors_control_app/deploy.sh) script references `Dockerfile.runtime` (line 36) but the file doesn't exist on disk -- it was generated dynamically in earlier builds. Create it at `.cortex/skills/build-routing-solution/native_app/services/ors_control_app/Dockerfile.runtime`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY dist ./dist
COPY dist-server ./dist-server
COPY package.json ./
COPY package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
EXPOSE 3001
CMD ["node", "dist-server/index.js"]
```

### Step 2: Build and Push Docker Image v1.0.29

Run the deploy script (handles everything: build, Docker, push, ALTER SERVICE, verify):

```bash
cd .cortex/skills/build-routing-solution/native_app/services/ors_control_app
./deploy.sh -c fleet_test_evals
```

This will:
- Build React client + TypeScript server locally (already built, but script re-runs it)
- Docker build `linux/amd64` using `Dockerfile.runtime` -- tagged as `v1.0.29`
- Push to `pm-fleet-test.registry.snowflakecomputing.com/openrouteservice_setup/public/image_repository/ors_control_app:v1.0.29`
- Update [ors_control_app_service.yaml](/.cortex/skills/build-routing-solution/native_app/services/ors_control_app/ors_control_app_service.yaml) from `v1.0.28` to `v1.0.29`
- Upload YAML to app package stage
- ALTER SERVICE with new spec
- SUSPEND + RESUME the service
- Poll until READY and verify running image tag

### Step 3: Re-run Berlin/cycling-electric/RES7

After the service is READY, trigger a fresh matrix build:

```sql
-- Drop the old corrupted matrix data
DROP TABLE IF EXISTS OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX.BERLIN_CYCLING_ELECTRIC_MATRIX_RES7;

-- Delete old job record so the UI is clean
DELETE FROM OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
WHERE JOB_ID LIKE 'BERLIN_CYCLING_ELECTRIC_RES7%';
```

Then use the Matrix Builder tab in the ORS Control App to re-trigger Berlin / cycling-electric / RES7. Alternatively, call the procedure directly via SQL.

### Step 4: Verify

After the build completes, check:

```sql
-- Should show 373 origins (not 100)
SELECT COUNT(DISTINCT ORIGIN_H3) AS origins,
       COUNT(*) AS total_pairs
FROM OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX.BERLIN_CYCLING_ELECTRIC_MATRIX_RES7;

-- The previously failing hex should now have data
SELECT COUNT(*) FROM OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX.BERLIN_CYCLING_ELECTRIC_MATRIX_RES7
WHERE ORIGIN_H3 = '871f1d4d6ffffff';
```

In the viewer: clicking any hex (including `871f1d4d6ffffff`) should show reachable destinations. Clicking a destination-only hex should show the warning message.
