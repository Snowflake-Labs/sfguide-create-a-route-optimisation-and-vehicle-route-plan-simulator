# Build Routing Solution - Execution Log

- **Date:** 2026-06-02 12:27
- **Skill:** build-routing-solution (level-driven serving-tier downsize change)
- **Connection:** TIB
- **Role:** ACCOUNTADMIN
- **Warehouse:** MEDIUM
- **Outcome:** COMPLETED_WITH_WORKAROUNDS

## Summary

Implemented a level-driven serving-tier downsize policy in `03_region_management.sql`:
- `city` -> `GEN_X64_G2_4` (3 vCPU / 13 GB) / RAM_STORE
- `country` | `sub-region` | `continent` -> `CPU_X64_SL` (14 vCPU / 58 GB) / MMAP
- Unknown level -> legacy `P_RUNTIME_SIZE` mapping (back-compat).

Added `GEN_X64_G2_4` heap (XMS 1G / XMX 9G) to `BUILD_ORS_SERVICE_SPEC`. Extended
auto-downsize triggers to fire for EVERY completed build (city included) in
`PROVISION_REGION_WRAPPER` and `RESCUE_PENDING_PROVISIONS`, plus a one-time city
downsize in `FINALIZE_DEFAULT_REGION_IF_READY` so a fresh install lands
SanFrancisco on `GEN_X64_G2_4` automatically.

Retroactively reconciled live regions:
- SanFrancisco: `GEN_X64_G2_8` -> `GEN_X64_G2_4` / RAM_STORE (49 graphs reused, no rebuild). service_ready=true; DIRECTIONS driving-car 1989 m / 259 s.
- Europe: `CPU_X64_SL` / MMAP (family no-op; service recreated, 29 graphs reused). service_ready=true; DIRECTIONS driving-hgv 1254 m / 213 s.

Pools ACTIVE, 2 services each, pool auto_suspend 3600, service auto_suspend 14400 (correct steady-state).

## Issues

### Issue 1: Europe canary returned NULL with driving-car

- **Step:** Verification (DIRECTIONS canary)
- **Severity:** INFO
- **Category:** UNEXPECTED_DATA

**What happened:**
DIRECTIONS for Europe returned `None`/`None` for `driving-car`. RESPONSE showed
`{"error":{"code":2003,"message":"Parameter 'profile' has incorrect value of 'unknown'."}}`.

**Resolution:**
Europe was provisioned with only the `driving-hgv` profile (DHL freight use case),
not `driving-car`. Re-ran the canary with `driving-hgv` -> route returned
1254 m / 213 s. Not a regression; the serving-tier change for Europe was a family
no-op (`CPU_X64_SL` -> `CPU_X64_SL`, MMAP -> MMAP).

**Suggested fix:**
Verification helpers should read the loaded profile from `ORS_STATUS(...).profiles`
rather than assuming `driving-car`.

---

### Issue 2: SHOW COMPUTE POOLS / SHOW SERVICES wide output garbles in terminal

- **Step:** Verification
- **Severity:** INFO
- **Category:** DOCS_GAP

**What happened:**
`SHOW COMPUTE POOLS` / `SHOW SERVICES` have many columns; piping the raw SHOW
output to the terminal produced unreadable wrapped rows.

**Resolution:**
Wrapped each SHOW in `SELECT ... FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))`
selecting only `name,state,instance_family,num_services,auto_suspend_secs`.

**Suggested fix:**
Standardize verification queries on RESULT_SCAN projections in the skill docs.

---

## Notes
- No image rebuild required - backend SQL module only.
- Continental MMAP service (Europe) took ~5 min to reach service_ready after
  recreation (lazy page-in of the memory-mapped graph); city RAM_STORE box was
  ready in ~90 s. Expected.
