# Plan: Update Skill Docs and References

## What Changed (recent sessions)

| Area | Old | New |
|------|-----|-----|
| Gateway image | `v0.9.5`, Flask dev server, sequential row processing | `v0.9.6`, gunicorn (2w/4t), ThreadPoolExecutor (6 concurrent) |
| Matrix work queue | 1 row per origin, all dests in one array | Chunked: max 1000 dests per row |
| Worker batch_size | Per-resolution (10-100) | Uniform `50` |
| Parallel workers | `LEAST(GREATEST(instances, 1), 4)` | `LEAST(GREATEST(instances * 2, 2), 4)` |
| Error retry | Fire all failed rows at once | Batched retry in groups of `batch_size` |
| Wrapper sweep | None | 2-pass single-threaded retry (batch=25) after AWAIT ALL |
| City AUTO_SUSPEND | 3600s (1h) | 14400s (4h) |
| SCALE_SERVICES (2-arg) | Only scaled default ORS + gateway | Also loops through `ORS_SERVICE_%` city services |
| UI progress | "N / M origins" | "N / M chunks (K origins)" |

## Files to Update

### 1. [references/available-functions.md](references/available-functions.md)

**Matrix Builder section** -- currently describes 4 parallel workers and old batch sizing. Update to document:

- **Destination chunking**: Work queue splits destinations into groups of max 1000. Each ORS call is always 1x1000 regardless of resolution or hex count.
- **Adaptive parallelism**: Worker count = `LEAST(GREATEST(service_instances * 2, 2), 4)`. Default ORS (3 instances) = 4 workers; city ORS (1 instance) = 2 workers.
- **Uniform batch_size**: Always 50, not resolution-dependent.
- **Gateway concurrency**: Each gateway instance processes up to 6 ORS calls concurrently (ThreadPoolExecutor). Configurable via `MATRIX_CONCURRENCY` env var.
- **3-layer error recovery**: (1) per-batch 5-retry with exponential backoff, (2) per-worker 3-pass batched retry loop, (3) wrapper-level 2-pass sweep after AWAIT ALL.
- **SCALE_SERVICES (2-arg)**: Now also scales all `ORS_SERVICE_%` city services and accounts for them in pool sizing.

**Lifecycle Procedures** -- add note that SCALE_SERVICES 2-arg now includes city services.

### 2. [references/snowflake-scripting-guidelines.md](references/snowflake-scripting-guidelines.md)

**Section 7 (Common Pitfalls)** -- add row:

| Pitfall | Fix |
|---------|-----|
| Gateway processes rows sequentially | v0.9.6 uses ThreadPoolExecutor(6). For large matrix builds, concurrency is critical. |
| Work queue rows too large | Destinations chunked to max 1000 per row. Do NOT revert to all-dests-per-origin. |

**Section 12 (Compute Pool & Service Sizing)** -- update:

- Gateway image: `v0.9.6` (gunicorn 2 workers, 4 threads, 300s timeout)
- Note `MATRIX_CONCURRENCY=6` env var (configurable in service YAML)
- City ORS AUTO_SUSPEND: 14400s (was 3600s, caused frequent suspensions)
- Matrix parallel workers formula: `LEAST(GREATEST(instances * 2, 2), 4)`

**Section 8 (Stage File Map)** -- verify module list matches current 6 modules.

### 3. [references/troubleshooting.md](references/troubleshooting.md)

**Issue 10 (Matrix build 500 errors)** -- rewrite to reflect current architecture:

- Old problem: Gateway v0.9.5 processed rows sequentially; large batches overwhelmed ORS.
- Current state: v0.9.6 with ThreadPoolExecutor handles this. If errors still occur, the 3-layer retry system recovers them.
- Tuning knob: Reduce `MATRIX_CONCURRENCY` env var in `routing-gateway-service.yaml` if ORS is overwhelmed.

**Add new issue: "Matrix build slow for city regions"**
- Cause: City ORS has 1 instance vs 3 for default. Combined with sequential gateway, throughput was 1/3.
- Fix: Gateway v0.9.6 concurrency + 2 SQL workers formula. Berlin RES8 went from 163min to estimated 15-25min.

**Update control app version reference** from `v1.0.27` to `v1.0.28`.

### 4. [SKILL.md](SKILL.md)

Already updated with gateway `v0.9.6` image tag (done during implementation). Verify:
- Step 5 image list shows `routing_reverse_proxy:v0.9.6` -- already correct
- Add note about gunicorn in Step 5 or a new subsection under "Gateway Configuration"

### 5. No new reference files needed

The existing 3 reference files cover the right topics. The matrix pipeline details fit naturally in `available-functions.md` (which already has a Matrix Builder section). Architecture details fit in `snowflake-scripting-guidelines.md` section 12. No need for separate `matrix-pipeline.md` or `architecture.md` files -- that would fragment the docs unnecessarily.
