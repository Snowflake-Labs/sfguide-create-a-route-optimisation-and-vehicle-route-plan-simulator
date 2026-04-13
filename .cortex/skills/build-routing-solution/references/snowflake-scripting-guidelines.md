# Snowflake SQL Scripting Guidelines

Coding and deployment guidelines for stored procedures in the ORS Native App (`setup_script.sql`).

## 1. Variable Binding Rules (Colon Prefix)

Snowflake SQL Scripting uses `:` to bind variables in DML statements. The rules are nuanced:

### REQUIRES colon (`:var`)
- **WHERE clauses**: `WHERE JOB_ID = :P_JOB_ID`
- **SET clauses with direct assignment**: `SET HEXAGONS = :hex_count`
- **SET clauses with string concatenation**: `SET ERROR_MSG = 'Warning: ' || :error_count || ' of ' || :raw_count`
- **INSERT VALUES**: `VALUES (:P_JOB_ID, :P_REGION)`
- **SELECT expressions**: `SELECT :my_var AS COL`

### Does NOT use colon
- **Assignments**: `wait_attempt := wait_attempt + 1;`
- **IF/WHILE conditions**: `IF (wait_attempt < max_wait_attempts) THEN`
- **LET declarations**: `LET wait_secs INTEGER := wait_attempt * 15;`
- **String concatenation for EXECUTE IMMEDIATE**: `'... ' || P_PROFILE || ' ...'`

### FAILS — computed expressions in SET clauses
Snowflake cannot resolve local variable arithmetic inside static DML SET clauses:

```sql
-- FAILS: "invalid identifier 'WAIT_ATTEMPT'"
UPDATE my_table SET ERROR_MSG = 'timeout after ' || (wait_attempt * 15) || ' seconds' WHERE ...;

-- FAILS: even with colon prefix
UPDATE my_table SET ERROR_MSG = 'timeout after ' || (:wait_attempt * 15) || ' seconds' WHERE ...;
```

**Fix**: Pre-compute the value, then use it:

```sql
-- CORRECT: pre-compute + EXECUTE IMMEDIATE
LET wait_secs INTEGER := wait_attempt * 15;
EXECUTE IMMEDIATE 'UPDATE my_table SET ERROR_MSG=''timeout after ' || wait_secs || ' seconds'' WHERE JOB_ID=''' || P_JOB_ID || '''';

-- ALSO CORRECT: pre-compute + static DML with colon
LET wait_secs INTEGER := wait_attempt * 15;
UPDATE my_table SET ERROR_MSG = 'timeout after ' || :wait_secs || ' seconds' WHERE JOB_ID = :P_JOB_ID;
```

### Quick reference

| Context | Syntax | Example |
|---------|--------|---------|
| Static DML value | `:var` | `SET COL = :my_var` |
| Static DML concat | `:var` | `'text' \|\| :var` |
| Computed expression | Pre-compute + `:var` | `LET x := a * b; SET COL = :x` |
| EXECUTE IMMEDIATE concat | bare `var` | `'...' \|\| my_var \|\| '...'` |
| Assignment | bare `var` | `x := x + 1;` |
| IF/WHILE | bare `var` | `IF (x < 10) THEN` |

## 2. Stage Path for setup_script.sql

The `manifest.yml` declares:
```yaml
artifacts:
  setup_script: setup_script.sql
```

This means the setup script is read from the **ROOT** of the stage, NOT from `app/`.

### Correct PUT command
```sql
PUT file:///path/to/setup_script.sql @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;
```

### WRONG (will be ignored by upgrade)
```sql
PUT file:///path/to/setup_script.sql @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/app/ OVERWRITE=TRUE AUTO_COMPRESS=FALSE;
```

The `app/` subdirectory copy is used by `snow app run` during initial deployment. For upgrades via `ALTER APPLICATION UPGRADE`, only the root-level file is used.

**Always verify** after PUT:
```sql
LIST @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE PATTERN='.*setup_script.*';
-- Check the ROOT file has the expected size and timestamp
```

## 3. Native App Upgrade Lifecycle

### What happens during `ALTER APPLICATION UPGRADE`
1. The full `setup_script.sql` is re-executed (all CREATE OR REPLACE statements run)
2. Then `version_init()` is called (the lifecycle callback)
3. All procedures are re-created with **application ownership** (not ACCOUNTADMIN)

### What does NOT work
- **Creating procedures directly** via `USE DATABASE <app>; CREATE OR REPLACE PROCEDURE ...` — the procedure will be owned by ACCOUNTADMIN, and `GRANT USAGE ... TO APPLICATION ROLE app_user` will fail with "Insufficient privileges"
- **Dropping and recreating** — same ownership problem
- If a procedure is accidentally dropped or created with wrong ownership, the only fix is a proper upgrade cycle

### Hotfix procedure changes
1. Edit `setup_script.sql` locally
2. PUT to stage ROOT: `@stage/` (NOT `@stage/app/`)
3. Upgrade: `ALTER APPLICATION OPENROUTESERVICE_NATIVE_APP UPGRADE USING @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE;`
4. Verify: `SELECT PROCEDURE_OWNER FROM <app>.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_NAME = '<name>';` — must show the application name, NOT ACCOUNTADMIN

## 4. Sandbox Testing Workflow

Before deploying any SQL Scripting change, validate it in a sandbox first. This takes seconds vs. minutes for a full deploy cycle.

### Pattern: Test procedure in OPENROUTESERVICE_SETUP
```sql
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.TEST_MY_PATTERN()
RETURNS VARCHAR
LANGUAGE SQL
EXECUTE AS CALLER
AS
$$
DECLARE
    -- Mirror the variables from the real procedure
    wait_attempt INTEGER DEFAULT 3;
    P_PROFILE VARCHAR DEFAULT 'cycling-electric';
    P_JOB_ID VARCHAR DEFAULT 'SANDBOX_TEST';
BEGIN
    -- Test the exact DML pattern you'll use in production
    INSERT INTO OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        (JOB_ID, REGION, PROFILE, RESOLUTION) VALUES (:P_JOB_ID, 'TEST', :P_PROFILE, 'RES7');

    -- Test your pattern here
    LET wait_secs INTEGER := wait_attempt * 15;
    EXECUTE IMMEDIATE 'UPDATE OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET MESSAGE=''test ' || wait_secs || ''' WHERE JOB_ID=''' || P_JOB_ID || '''';

    -- Cleanup
    DELETE FROM OPENROUTESERVICE_NATIVE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE JOB_ID = :P_JOB_ID;
    RETURN 'OK';
END;
$$;
CALL OPENROUTESERVICE_SETUP.PUBLIC.TEST_MY_PATTERN();
DROP PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.TEST_MY_PATTERN();
```

### Rules
- Use `EXECUTE AS CALLER` (not OWNER) so the test proc can access cross-database tables
- Always insert a test row with a known JOB_ID and clean it up at the end
- Test ALL DML patterns from the real procedure, not just the one you think is broken
- Only deploy after sandbox test returns success

## 5. Table Schema Checklist

All tables are created with complete schemas from the start via `CREATE OR REPLACE TABLE` or `CREATE TABLE IF NOT EXISTS`. Define all columns (including JOB_ID, GEOGRAPHY columns, etc.) in the initial DDL. Do not use `ALTER TABLE ADD COLUMN` as a migration step -- assume a clean install.

When adding a new column to a table:
1. Add the column to the `CREATE TABLE` DDL in the relevant SQL file (e.g., `load-seed-data.sql`, `ensureTables()` in `jobs.ts`)
2. Update every procedure that reads/writes to the table to use the new column
3. Sandbox-test the procedure against the live table with the new column

## 6. EXECUTE IMMEDIATE Patterns

Use EXECUTE IMMEDIATE when:
- Table/column names are dynamic (built from variables)
- You need computed expressions in SET clauses
- You need to call procedures with dynamic arguments

### String escaping
Single quotes inside EXECUTE IMMEDIATE strings must be doubled:

```sql
-- Original static SQL:
UPDATE t SET MSG = 'Profile ready' WHERE ID = :my_id;

-- As EXECUTE IMMEDIATE:
EXECUTE IMMEDIATE 'UPDATE t SET MSG=''Profile ready'' WHERE ID=''' || my_id || '''';
```

### Capturing results from EXECUTE IMMEDIATE
```sql
LET rs RESULTSET := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || table_name);
LET c CURSOR FOR rs;
FOR r IN c DO my_count := r.CNT; END FOR;
```

## 7. Common Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| PUT to wrong stage path | Upgrades don't apply changes | PUT to stage ROOT, not `app/` |
| Computed expression in DML SET | "invalid identifier" | Pre-compute with LET, then use `:var` |
| Direct procedure CREATE in app DB | GRANT fails "Insufficient privileges" | Only create via setup_script + upgrade |
| Missing column in existing table | "invalid identifier 'COL'" | Add column to CREATE TABLE DDL and re-run (CREATE OR REPLACE) |
| Bare variable in static DML | "invalid identifier" | Add `:` prefix |
| Colon in assignment | Syntax error | Remove `:` — assignments use bare variables |
| City ORS service auto-suspends mid-build | 500 Internal Server Error from MATRIX_TABULAR | Wrapper now suspends then resumes the city service before building to reset the auto-suspend timer. Traffic via gateway does NOT count as direct service activity for SPCS auto-suspend. |
| `CREATE TEMPORARY TABLE` in native app | "Operation CREATE on TEMPORARY TABLE is not permitted within APPLICATION" | Native apps prohibit temporary tables. Replace with inline DELETE + INSERT using NOT IN subquery. Pattern: DELETE rows with NULL results, then INSERT missing SEQ_IDs from queue where SEQ_ID NOT IN (SELECT SEQ_ID FROM raw_table). |
| Gateway processes rows sequentially (pre-v0.9.6) | Matrix builds very slow (~62s per batch of 50) | Gateway v0.9.6 uses `ThreadPoolExecutor(MATRIX_CONCURRENCY)` (default 6) for concurrent ORS calls within each batch. Do NOT revert to sequential processing. |
| Work queue row has >1000 destinations | ORS error 6099 "too many locations" or gateway 500 | BUILD_WORK_QUEUE chunks destinations to max 1000 per row via `FLOOR((dest_seq - 1) / 1000)`. Do NOT revert to all-destinations-per-origin. |

## 8. Stage File Map

`snowflake.yml` maps `src: app/*` to `dest: ./` (stage root). This means files in the local `app/` directory are deployed to the **root** of the stage, not into an `app/` subdirectory. Service YAMLs preserve their relative path.

```
@OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE
├── setup_script.sql          <-- app/setup_script.sql
├── manifest.yml              <-- app/manifest.yml
├── README.md                 <-- app/README.md
├── modules/
│   ├── 01_core_infra.sql
│   ├── 02_routing_functions.sql
│   ├── 03_region_management.sql
│   ├── 04_service_lifecycle.sql
│   ├── 05_matrix_pipeline.sql
│   └── 06_matrix_ops.sql
├── services/
│   ├── ors_control_app/
│   │   └── ors_control_app_service.yaml
│   ├── gateway/
│   │   └── routing-gateway-service.yaml
│   ├── openrouteservice/
│   │   └── openrouteservice.yaml
│   ├── downloader/
│   │   └── downloader_spec.yaml
│   └── vroom/
│       └── vroom-service.yaml
```

| Local File (relative to `native_app/`) | Stage Destination | Deployed By |
|----------------------------------------|-------------------|-------------|
| `app/setup_script.sql` | `@STAGE/` (ROOT) | `deploy.sh`, manual PUT |
| `app/manifest.yml` | `@STAGE/` (ROOT) | `deploy.sh`, `snow app run` |
| `app/README.md` | `@STAGE/` (ROOT) | `snow app run` |
| `services/ors_control_app/ors_control_app_service.yaml` | `@STAGE/services/ors_control_app/` | `deploy.sh`, `ors_control_app/deploy.sh` |
| `services/gateway/routing-gateway-service.yaml` | `@STAGE/services/gateway/` | `deploy.sh` |
| `services/openrouteservice/openrouteservice.yaml` | `@STAGE/services/openrouteservice/` | `snow app run` |
| `services/downloader/downloader_spec.yaml` | `@STAGE/services/downloader/` | `snow app run` |
| `services/vroom/vroom-service.yaml` | `@STAGE/services/vroom/` | `snow app run` |

If you see `@STAGE/app/setup_script.sql` on the stage, it is a **stale leftover**. `deploy.sh` automatically removes it. If deploying manually, remove it:
```sql
REMOVE @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/app/setup_script.sql;
```

## 9. Deployment Verification SQL

Run these queries after every deployment to confirm changes were applied correctly.

### Check staged files
```sql
LIST @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE PATTERN='.*setup_script.*';
LIST @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE PATTERN='.*manifest.*';
-- Root-level files must have the expected size and recent timestamp.
-- If app/setup_script.sql also appears, it is stale — remove it.
```

### Check procedure ownership
```sql
SELECT PROCEDURE_NAME, PROCEDURE_OWNER, CREATED
FROM OPENROUTESERVICE_NATIVE_APP.INFORMATION_SCHEMA.PROCEDURES
WHERE PROCEDURE_SCHEMA = 'CORE'
  AND PROCEDURE_NAME IN (
    'BUILD_MATRIX_JOB_WRAPPER',
    'BUILD_TRAVEL_TIME_RANGE_REGION',
    'VERSION_INIT',
    'GET_BUILD_STATUS'
  )
ORDER BY PROCEDURE_NAME;
-- PROCEDURE_OWNER must be OPENROUTESERVICE_NATIVE_APP, never ACCOUNTADMIN.
```

### Check running service images
```sql
SHOW SERVICES IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;
-- Compare spec_image_info or container status to expected image tags.
```

### Check manifest image tags on stage
```sql
SELECT $1 FROM @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/manifest.yml
WHERE $1 LIKE '%image_repository%';
-- Each image tag should match the actually pushed image version.
```

### Verify a specific procedure fix
```sql
-- Example: confirm BUILD_MATRIX_JOB_WRAPPER has the wait_secs pattern
SELECT CASE
  WHEN POSITION('wait_secs' IN GET_DDL('PROCEDURE',
    'OPENROUTESERVICE_NATIVE_APP.CORE.BUILD_MATRIX_JOB_WRAPPER(VARCHAR,VARCHAR,FLOAT,FLOAT,FLOAT,FLOAT,VARCHAR,VARCHAR,VARCHAR)')) > 0
  THEN 'OK: has wait_secs fix'
  ELSE 'STALE: missing wait_secs'
END AS status;
```

### Check for stale app/ copies
```sql
LIST @OPENROUTESERVICE_NATIVE_APP_PKG.APP_SRC.STAGE/app/ PATTERN='.*setup_script.*';
-- Should return 0 rows. If any results, remove the stale copy.
```

## 10. Pre-Deployment Checklist

Run through this checklist before and after every `ALTER APPLICATION UPGRADE`.

### Before deploying

- [ ] All changed SQL patterns sandbox-tested (Section 4)
- [ ] PUT targets stage ROOT for `setup_script.sql` and `manifest.yml` (Section 8)
- [ ] No stale `@STAGE/app/setup_script.sql` on stage (remove if present)
- [ ] `manifest.yml` image tags match the actually pushed image tags
- [ ] Service YAML image tags match the actually pushed image tags
- [ ] Any new table columns included in the CREATE TABLE DDL (Section 5)

### After deploying

- [ ] Run verification queries (Section 9) to confirm changes applied
- [ ] All `PROCEDURE_OWNER` values show application name, not ACCOUNTADMIN
- [ ] No stale `app/` copies remain on stage
- [ ] Tested the changed functionality end-to-end (e.g., trigger a matrix build)

## 11. Object Tracking Tags (MANDATORY)

Every `CREATE` statement in the setup_script modules MUST include a tracking COMMENT tag. No exceptions.

**Format:**
```sql
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"<component>"}}'
```

Where `<component>` matches the module domain:

| Module | Component tag |
|--------|---------------|
| `01_core_infra.sql` | `core` |
| `02_routing_functions.sql` | `routing` |
| `03_region_management.sql` | `region-catalog` / `provisioner` / `multi-region` |
| `04_service_lifecycle.sql` | `lifecycle` |
| `05_matrix_pipeline.sql` | `matrix` |
| `06_matrix_ops.sql` | `matrix` |

**Rules:**

1. **Procedures** — COMMENT goes before `AS $$`. When `EXECUTE AS OWNER` is present, COMMENT must come BEFORE it:
   ```sql
   CREATE OR REPLACE PROCEDURE core.my_proc()
   RETURNS VARCHAR
   LANGUAGE SQL
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}'
   EXECUTE AS OWNER
   AS
   $$
   ```

2. **Tables** — COMMENT goes after column definitions:
   ```sql
   CREATE TABLE IF NOT EXISTS travel_matrix.MY_TABLE (
       COL1 VARCHAR
   )
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
   ```
   Note: `CREATE TABLE IF NOT EXISTS` does NOT update COMMENT on an existing table — use `ALTER TABLE ... SET COMMENT` if the table already exists.

3. **Schemas** — COMMENT goes inline:
   ```sql
   CREATE SCHEMA IF NOT EXISTS core
       COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';
   ```

4. **Streamlit / Services / Functions created at top level** — same pattern with appropriate component tag.

5. **Dynamic objects (inside procedure bodies)** — use `ALTER ... SET COMMENT` after creation when the DDL syntax does not support inline COMMENT (e.g., CTAS, service functions with `SERVICE=` clause).

6. **New modules** — if adding a new module file, register it in `setup_script.sql` with `EXECUTE IMMEDIATE FROM` and add a row to the module table above.

7. **Pre-commit check** — before uploading, run: `grep -c COMMENT modules/*.sql` and verify every module has at least as many COMMENT clauses as CREATE statements.

8. **`REBUILD_GRAPHS` must always be `"false"`** — in any ORS service spec (YAML or inline JSON), set `REBUILD_GRAPHS: "false"`. This tells ORS to load cached graphs from the persistent stage volume instead of rebuilding from the PBF file on every container start. Graphs are built automatically on first provision when no cache exists; subsequent restarts reuse the cache. Never set this to `"true"` unless explicitly performing a one-off forced rebuild.

## 12. Compute Pool & Service Sizing Guidelines

### Instance type
- **HIGHMEM_X64_S** (6 vCPU, 58 GB RAM, 100 GB storage): Standard choice for ORS (memory-heavy graph loading).
- All containers in a service instance run on a single node.
- Stage volume mount limit: **8 per node** (across all services).

### Service instance counts
- **ORS_SERVICE** (default region): 3 instances for dev/test, 5-10 for production traffic.
- **ROUTING_GATEWAY_SERVICE**: 3 instances is sufficient — lightweight gunicorn proxy (2 workers, 4 threads, 300s timeout). `MATRIX_CONCURRENCY=6` env var controls ThreadPoolExecutor parallelism per batch.
- **ORS_SERVICE_\<REGION\>** (city-specific): 1 instance per region.
- **Other services** (downloader, vroom, control app): 1 instance each.
- **Never set ORS and gateway to the same instance count** unless explicitly needed. Use the 3-arg `SCALE_SERVICES(ors, gateway, pool_nodes)` overload.

### Pool node formula
```
total_containers = ors_instances + gateway_instances + region_services + 3  -- (downloader + vroom + control app)
min_nodes = CEIL(total_containers / 3)  -- ~3 containers per node max
```
Example: 3 ORS + 3 gateway + 1 Berlin + 3 = 10 containers → 4 nodes minimum (use 5 for margin).

### Preventing PENDING services
1. Set `min_nodes = max_nodes` to avoid autoscaling surprises.
2. Never exceed ~3 containers per node on HIGHMEM_X64_S.
3. During matrix builds: suspend unused ORS_SERVICE if only the region-specific ORS is needed.
4. After builds: resume ORS_SERVICE at reduced count and right-size pool.

### MAX_BATCH_ROWS for service functions
- Default (non-region) functions: `MAX_BATCH_ROWS=1000` (high concurrency, many ORS instances)
- Region-aware functions: `MAX_BATCH_ROWS=50` (single ORS instance)
- With gateway v0.9.6 concurrency (6 threads), 50 rows complete in ~10-15s vs 100s sequentially.

### Matrix parallel workers formula
- `LEAST(GREATEST(service_instances * 2, 2), 4)` — adapts to ORS instance count.
- Default ORS (3 instances) = 4 SQL workers; city ORS (1 instance) = 2 SQL workers.
- Detected at runtime via `SHOW SERVICES LIKE 'ORS_SERVICE_%'`.
- Benchmark: Berlin RES8 (2,611 hexagons, ~6.8M pairs, 1-instance city ORS, 2 workers) = **6 minutes**.

### City ORS AUTO_SUSPEND
- City services use `AUTO_SUSPEND_SECS=14400` (4 hours). Previous value of 3600s caused frequent mid-build suspensions because SPCS auto-suspend only counts direct API calls to the service, not traffic routed through the gateway.

### ALTER SESSION not allowed
`ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS` is **not supported** in EXECUTE AS OWNER procedures. Use retry+backoff logic and service resume instead.

### Current image tags
| Service | Image | Tag |
|---------|-------|-----|
| ORS | openrouteservice | v9.0.0 |
| Downloader | downloader | v0.0.3 |
| Gateway | routing_reverse_proxy | v1.0.0 |
| VROOM | vroom-docker | v1.0.1 |
| Control App | ors_control_app | v1.0.95 |
