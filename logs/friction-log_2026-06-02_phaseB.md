# build-routing-solution — Friction Log (Phase B: MMAP + follow-ups)

- **Date:** 2026-06-02 (Phase B execution)
- **Task:** Plan `phaseb-mmap-and-followups` — add per-region MMAP, CPU_X64_SL small runtime family, apply+benchmark on Europe, fix run_sql_module.sh, refresh heap telemetry comment.
- **Connection:** TIB (tib85385 / GEOLAB / ACCOUNTADMIN)
- **Outcome:** COMPLETED_WITH_WORKAROUNDS (2 deploy-time SQL bugs hit + fixed in source; benchmark gate passed; MMAP adopted for Europe)

## Step status

| Step | Description | Status |
|------|-------------|--------|
| B2 | MMAP reload-vs-rebuild determination | OK (load-time; reload, no rebuild) |
| Schema | REGION_ORS_MAP.GRAPHS_DATA_ACCESS column | OK (no dependent views; EXCEPTION-wrapped backfill) |
| WRITE_ORS_CONFIG | emit graphs_data_access:MMAP gated | OK |
| BUILD_ORS_SERVICE_SPEC | CPU_X64_SL heap 4G/24G | OK |
| DOWNSIZE | P_GRAPHS_DATA_ACCESS + M->CPU_X64_SL | OK (after 2 fixes below) |
| Apply | Europe -> CPU_X64_SL + MMAP + snapping 5000 | OK (service_ready=true) |
| Benchmark | RAM_STORE vs MMAP | OK (MMAP comparable; adopted) |
| F-A | run_sql_module.sh error detection | OK (self-tested) |
| F-B | stale heap telemetry comment | OK |

## Friction points

### F-B2.1 (BLOCKER->fixed): tagged dollar-quote in EXECUTE IMMEDIATE
- `EXECUTE IMMEDIATE $MIGRATE_GDA$ ... $MIGRATE_GDA$;` -> "syntax error ... unexpected '$'". Snowflake EXECUTE IMMEDIATE (and snow CLI statement splitter) only accept plain `$$` for the anonymous block, not a named tag.
- Resolution: use `$$ ... $$`. Redeploy clean.
- Recommendation: never use tagged dollar-quotes for top-level EXECUTE IMMEDIATE blocks in module files.

### F-B2.2 (BLOCKER->fixed): ambiguous PROCEDURE overloading on DOWNSIZE
- Adding a 3rd defaulted param to DOWNSIZE_REGION_AFTER_BUILD created a new overload alongside the existing 2-arg proc; defaults made them ambiguous -> "000949 (42723): ambiguous PROCEDURE overloading" at CREATE time.
- Resolution: `DROP PROCEDURE IF EXISTS ...DOWNSIZE_REGION_AFTER_BUILD(VARCHAR, VARCHAR);` before the CREATE.
- Recommendation: when widening a proc's arg list with defaults, always drop the prior signature first.

### F-B2.3 (INFO): create_region_ors_service does NOT regenerate ors-config.yml
- The staged ors-config.yml is written by WRITE_ORS_CONFIG (provisioning / APPLY_ORS_LIMITS), not by create_region_ors_service. So DOWNSIZE had to call WRITE_ORS_CONFIG itself BEFORE recreating the service — critical because CPU_X64_SL has a 24G heap and a RAM_STORE start would OOM the 24GB graph. Ordering: set REGION_ORS_MAP (family+GDA) -> WRITE_ORS_CONFIG -> create_region_ors_service.

### F-B2.4 (INFO): stage file read needs a named file format
- `SELECT $1 FROM @stage/file (FILE_FORMAT => (TYPE=CSV ...))` fails ("argument required to be a constant"). Use a pre-created (TEMP) named FILE FORMAT instead.

## Benchmark (Europe, driving-hgv)
| Call | RAM_STORE HIGHMEM_X64_M (240GB) | MMAP CPU_X64_SL (58GB) |
|------|---|---|
| Directions long, warm | 347 ms | 147 ms |
| Directions long, cold | 2127 ms | 517 ms |
| Isochrone 1800s | 90-165 ms | 123 ms |
Conclusion: MMAP latency comparable/better after page-cache warmup, on a much smaller/cheaper box. Snapping changed to 5000 between runs (not a pure A/B) but conclusion holds. MMAP adopted.

## Verified end state
- ORS_POOL_EUROPE = CPU_X64_SL (max_nodes 1), num_services 2; ORS+VROOM READY; service_ready=true.
- Staged config: `graphs_data_access: MMAP`, `maximum_snapping_radius: 5000`.
- REGION_ORS_MAP Europe: INSTANCE_FAMILY=CPU_X64_SL, COMPUTE_SIZE=M, GRAPHS_DATA_ACCESS=MMAP.
- RECONCILE_AUTO_SUSPEND: 8 reconciled, 0 pinned.

## Commits (branch feat/sfc-gh-obielov-feat)
- 085bf92 feat: per-region MMAP + CPU_X64_SL runtime tier
- a5a2032 fix(scripts): run_sql_module.sh box-drawn error detection
