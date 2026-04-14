# Troubleshooting

Common issues and their solutions when deploying the ORS App.

## Container Runtime Not Running

**Symptom:** "Cannot connect to the Docker daemon" or "Cannot connect to Podman"
**Solution:**
- Podman: `podman machine start`
- Docker: Start Docker Desktop application

## Authentication Required

**Symptom:** "unauthorized" or "authentication required" or "invalid username/password"
**Solution:**
- Docker: Run `snow spcs image-registry login -c <connection>`
- Podman: Use session token with password-stdin:
  ```bash
  REGISTRY_URL=$(snow spcs image-repository url openrouteservice_app.core.image_repository -c <connection> | cut -d'/' -f1)
  snow spcs image-registry token --format=JSON -c <connection> | podman login $REGISTRY_URL -u 0sessiontoken --password-stdin
  ```

## Wrong Directory Error

**Symptom:** "cd: services/openrouteservice: No such file or directory"
**Solution:** Ensure script runs from `openrouteservice_app/` directory


## ARM Mac esbuild Crash (ors_control_app)

**Symptom:** `esbuild` crashes with QEMU segfault during `npm run build` inside `podman build --platform linux/amd64`
**Solution:** Build the React app locally (native ARM) first, then use a runtime-only Dockerfile that copies the pre-built `dist/` and `dist-server/` directories. See Step 5 in SKILL.md for the exact commands. Must temporarily rename `.dockerignore` since it excludes `dist/`.

## Podman Registry Auth for Wrong Host

**Symptom:** `podman push` fails with "unable to retrieve auth token: invalid username/password: unauthorized" even after `snow spcs image-registry login`
**Solution:** `snow spcs image-registry login` may store credentials for the wrong registry hostname. Use the manual token approach with `--creds` flag:
```bash
REGISTRY_URL=$(snow spcs image-repository url openrouteservice_app.core.image_repository -c <connection> | cut -d'/' -f1)
TOKEN=$(snow spcs image-registry token --format=JSON -c <connection>)
podman push --creds "0sessiontoken:$TOKEN" $REGISTRY_URL/ors_control_app:v1.0.28
```

## Services Going PENDING (Resource Exhaustion)

**Symptom:** Services transition from RUNNING to PENDING with "Unschedulable due to insufficient resources" or silently fail to schedule.
**Root Cause:** Compute pool has too many containers relative to available nodes. All containers in a service instance run on a single node; stage volume mounts limited to 8 per node.
**Solution:**
1. **Right-size instances:** ORS and gateway DON'T need the same count. Gateway is a lightweight proxy; 3 instances handles most workloads. ORS is heavy (graph loading); keep at 3 unless high traffic.
2. **Use the 3-arg SCALE_SERVICES:** `CALL CORE.SCALE_SERVICES(ors_instances, gateway_instances, pool_nodes)` to set them independently.
3. **Rule of thumb:** total_containers / 3 = minimum nodes. Example: 3 ORS + 3 gateway + 1 Berlin + 3 others = 10 containers → 4-5 nodes.
4. **During matrix builds:** Suspend unused ORS_SERVICE if only building for a specific region (the region-specific ORS handles it).
5. **Pool sizing formula:** `GREATEST(requested_nodes, CEIL(total_active_containers / 3))` to ensure at least 3 containers per node.

## ALTER SESSION Not Allowed in EXECUTE AS OWNER

**Symptom:** `Unsupported statement type 'ALTER_SESSION'` in stored procedures
**Root Cause:** `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS` is not allowed in EXECUTE AS OWNER procedures.
**Solution:** Remove ALTER SESSION statements. Use retry+backoff logic and service resume instead of statement timeouts. Warehouse-level timeout can be set externally if needed.

## Matrix Build 500 Errors from Gateway

**Symptom:** `Request failed for external function MATRIX_TABULAR with remote service error: 500`
**Root Causes and Fixes:**
1. **Gateway can't reach ORS:** Service was PENDING/upgrading. Fix: Add service resume logic before build, reduce compute pressure.
2. **Gateway Python bug (fixed in v0.9.6):** `resp.get('error', {}).get('code')` crashes with AttributeError when `error` is a string (connection failure) instead of a dict (ORS error). Fix: Check `isinstance(error_obj, dict)` before calling `.get('code')`.
3. **ORS overwhelmed:** Too many concurrent calls to a single-instance city ORS. Fix: Gateway v0.9.6 uses `MATRIX_CONCURRENCY=6` (configurable). Reduce to 3-4 if a city ORS is overwhelmed.
4. **Recovery:** The 3-layer error recovery (per-batch retry, per-worker batched retry, wrapper-level sweep) handles transient 500 errors automatically. Check `MATRIX_BUILD_JOBS.MESSAGE` for error counts after build completes.

## Matrix Build Slow for City Regions

**Symptom:** City region matrix builds take much longer than default region builds (e.g., Berlin RES8: 163 min for 6M pairs)
**Root Cause:** City ORS has 1 instance vs 3 for default. Pre-v0.9.6 gateway processed rows sequentially (50 rows × ~1.25s = 62s per batch).
**Solution (all applied in v0.9.6):**
1. **Gateway ThreadPoolExecutor**: 6 concurrent ORS calls per batch instead of sequential. Set via `MATRIX_CONCURRENCY` env var in `routing-gateway-service.yaml`.
2. **Gunicorn server**: 2 workers + 4 threads (replaces Flask dev server). Handles concurrent SQL worker batches.
3. **Adaptive parallelism**: City services get 2 SQL workers (`LEAST(GREATEST(1*2, 2), 4) = 2`). Default gets 4.
4. **Actual result**: Berlin RES8 from 163min to **6min** (2,611 hexagons, ~6.8M pairs). ~27x speedup.

## Matrix Build Performance Tuning

**Batch size:** Uniform `50` for all resolutions. Each batch calls MATRIX_TABULAR for 50 work queue rows.
**Destination chunking:** Work queue rows are capped at 1000 destinations each via `FLOOR((dest_seq - 1) / 1000)` partitioning. A 2600-hex region produces ~3 chunks per origin.
**Gateway concurrency:** `MATRIX_CONCURRENCY=6` (default). Each gateway instance processes up to 6 ORS calls in parallel via ThreadPoolExecutor. Reduce to 3-4 if error rate is high.
**SQL worker parallelism:** `LEAST(GREATEST(service_instances * 2, 2), 4)`. Default ORS (3 instances) = 4 workers; city ORS (1 instance) = 2 workers.
**Gateway server:** gunicorn with 2 workers, 4 threads, 300s timeout (replaced Flask dev server in v0.9.6).

## Stale/Zombie Build Jobs

**Symptom:** Jobs stuck in RUNNING status indefinitely after services went PENDING
**Solution:** BUILD_MATRIX_JOB_WRAPPER now auto-cleans jobs RUNNING for >2 hours before starting a new build. Manual fix: `UPDATE travel_matrix.MATRIX_BUILD_JOBS SET STATUS = 'ERROR' WHERE STATUS = 'RUNNING' AND STARTED_AT < DATEADD('HOUR', -2, CURRENT_TIMESTAMP())`
