# build-routing-solution friction log — 2026-05-10 17:00 (holistic recovery)

## Summary

After the earlier resolver SQL fix (commit 8405fa5, PR #96) cleared the compile error, USA / driving-hgv deployment claimed `STATUS=COMPLETE / STAGE=READY` while the actual SPCS service was OOM-restarting (`lastExitCode=137`, `restartCount=27`, build cannot finish). Three correlated latent bugs in `03_region_management.sql` were responsible. All three are now patched, USA recovery is clean, and future deployments are self-healing.

## Bugs fixed

### A. Stale compute pool family mismatch
- `CREATE COMPUTE POOL IF NOT EXISTS` silently kept the prior `CPU_X64_L` (116 GB) pool even after the resolver returned `MEM_X64_G2_192` (1436 GB). Service spec `XMS=110G XMX=1100G` could not run on a 116 GB node → continuous OOM-kill loop.
- SPCS forbids `ALTER COMPUTE POOL ... INSTANCE_FAMILY`, so the only fix is drop+recreate.
- **Patch:** `create_region_ors_service` now probes `SHOW COMPUTE POOLS LIKE`, detects family mismatch, drops the dependent service + pool, then lets the existing `CREATE` recreate them.

### B. Premature READY claim
- After the 10-min `BUILDING_GRAPH` wait loop expired without `service_ready=true`, the procedure set `STATUS=COMPLETE / STAGE=READY` with a soft "check ORS_STATUS" message. UI showed green for ~11h while the container was OOM-looping.
- Country-scale HGV builds on `MEM_X64_G2_192` legitimately take 60-120 min, so the 10-min ceiling was always too short.
- **Patch:**
  - Wait ceiling now scales with compute size: `XXL` = 240 × 30 s = 2 h; `M/L/XL` = 120 × 30 s = 1 h; default 40 × 30 s = 20 min.
  - On timeout, `PROVISION_REGION_WRAPPER` now hard-fails: `REGION_PROVISION_JOBS.STATUS=ERROR`, `STAGE=BUILDING_GRAPH`, `ERROR_MSG=graph_load_timeout`; `REGION_ORS_MAP.STATUS=FAILED`; `ORS_BUILD_HISTORY.EXIT_STATUS=TIMEOUT`. No more silent green.

### C. Partial-graph reuse hazard
- `create_region_ors_service` set `REBUILD_GRAPHS=false` whenever the graphs stage had any files, including partial files left by a crashed prior build.
- **Patch:**
  - Success path in `PROVISION_REGION_WRAPPER` writes a `_BUILD_OK` marker via `COPY INTO @stage/<region>/_BUILD_OK FROM (SELECT 'ok') FILE_FORMAT=(TYPE=CSV) SINGLE=TRUE OVERWRITE=TRUE` immediately after `service_ready=true`.
  - `create_region_ors_service` now requires the `_BUILD_OK` marker to set `REBUILD_GRAPHS=false`. If marker absent and stage has files (partial/crashed prior build) the procedure issues `REMOVE @stage/<region>/` and forces `REBUILD_GRAPHS=true`.

## Deployment

```
snow sql -f .cortex/skills/build-routing-solution/openrouteservice_app/app/modules/03_region_management.sql
```

All procedures recreated. No image rebuild required.

## USA recovery executed

```sql
DROP SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_UNITEDSTATESOFAMERICA;          -- dropped
ALTER COMPUTE POOL ORS_POOL_UNITEDSTATESOFAMERICA STOP ALL;                                  -- ok
DROP COMPUTE POOL IF EXISTS ORS_POOL_UNITEDSTATESOFAMERICA;                                  -- dropped
REMOVE @OPENROUTESERVICE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/UnitedStatesOfAmerica/;              -- 1 file (driving-hgv/gh.lock) removed
UPDATE REGION_PROVISION_JOBS SET DISMISSED=TRUE WHERE REGION='UnitedStatesOfAmerica';
UPDATE REGION_ORS_MAP SET STATUS='NOT_DEPLOYED' WHERE REGION='UnitedStatesOfAmerica';
```

Verified: `SHOW COMPUTE POOLS LIKE 'ORS_POOL_UNITEDSTATESOFAMERICA'` → no rows; `LIST @stage/UnitedStatesOfAmerica/` → no rows.

## Step status

| Step | Status | Notes |
|------|--------|-------|
| Diagnose 3 correlated bugs | OK | Pool family mismatch, premature READY, partial-graph reuse. |
| Patch `create_region_ors_service` (Fix A + C) | OK | Family reconciliation block + marker-aware probe with auto-purge. |
| Patch `PROVISION_REGION_WRAPPER` (Fix B.1, B.2, B.3) | OK | Marker write, hard-fail on timeout, scaled wait ceiling. |
| Redeploy module 03 | OK | All procedures recreated. |
| USA service + pool drop + stage purge | OK | One stale `gh.lock` removed. |
| Re-provision USA | DEFERRED | User action via Region Builder UI; ~1-2h build. |

## Friction points & recommendations

1. **`CREATE ... IF NOT EXISTS` is dangerously silent.** SPCS makes `INSTANCE_FAMILY` immutable but `IF NOT EXISTS` does not signal mismatch. **Recommendation:** establish a repo-wide pattern of probing `SHOW` then dropping on mismatch for any "immutable attribute" object (pools, services, warehouses with size differences).
2. **Wait ceiling was a single hardcoded constant (`40 × 15 s`) regardless of region size.** **Recommendation:** scale all long-running waits by `P_COMPUTE_SIZE` or by `PBF_SIZE_GIB` going forward. Document in `references/snowflake-sql-gotchas.md`.
3. **No marker-based "successful build" signal.** Without it, "stage non-empty" was an unreliable proxy. **Recommendation:** generalize the `_BUILD_OK` pattern across other stage-persisted artifacts (matrix builds, derived analytics caches).

## Total time

~30 min from status check to verified clean recovery state.
