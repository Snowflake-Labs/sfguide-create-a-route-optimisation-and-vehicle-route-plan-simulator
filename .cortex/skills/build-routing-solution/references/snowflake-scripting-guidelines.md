# Snowflake SQL Scripting Guidelines

Coding and deployment guidelines for stored procedures in the ORS App.

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

## 2. Table Schema Checklist

All tables are created with complete schemas from the start via `CREATE OR REPLACE TABLE` or `CREATE TABLE IF NOT EXISTS`. Define all columns (including JOB_ID, GEOGRAPHY columns, etc.) in the initial DDL. Do not use `ALTER TABLE ADD COLUMN` as a migration step -- assume a clean install.

When adding a new column to a table:
1. Add the column to the `CREATE TABLE` DDL in the relevant SQL file (e.g., `load-seed-data.sql`, `ensureTables()` in `jobs.ts`)
2. Update every procedure that reads/writes to the table to use the new column
3. Sandbox-test the procedure against the live table with the new column

## 3. EXECUTE IMMEDIATE Patterns

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

## 4. Common Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| PUT to wrong stage path | Upgrades don't apply changes | PUT to stage ROOT, not `app/` |
| Computed expression in DML SET | "invalid identifier" | Pre-compute with LET, then use `:var` |
| Direct procedure CREATE in app DB | GRANT fails "Insufficient privileges" | Only create via setup_script + upgrade |
| Missing column in existing table | "invalid identifier 'COL'" | Add column to CREATE TABLE DDL and re-run (CREATE OR REPLACE) |
| Bare variable in static DML | "invalid identifier" | Add `:` prefix |
| Colon in assignment | Syntax error | Remove `:` — assignments use bare variables |
| City ORS service auto-suspends mid-build | 500 Internal Server Error from MATRIX_TABULAR | Wrapper now suspends then resumes the city service before building to reset the auto-suspend timer. Traffic via gateway does NOT count as direct service activity for SPCS auto-suspend. |
| Gateway processes rows sequentially (pre-v0.9.6) | Matrix builds very slow (~62s per batch of 50) | Gateway v0.9.6 uses `ThreadPoolExecutor(MATRIX_CONCURRENCY)` (default 6) for concurrent ORS calls within each batch. Do NOT revert to sequential processing. |
| Work queue row has >1000 destinations | ORS error 6099 "too many locations" or gateway 500 | BUILD_WORK_QUEUE chunks destinations to max 1000 per row via `FLOOR((dest_seq - 1) / 1000)`. Do NOT revert to all-destinations-per-origin. |

## 5. Compute Pool & Service Sizing Guidelines

### Instance type
- **HIGHMEM_X64_S** (6 vCPU, 58 GB RAM, 100 GB storage): Standard choice for ORS (memory-heavy graph loading).
- All containers in a service instance run on a single node.
- Stage volume mount limit: **8 per node** (across all services).

### Service instance counts
- **ORS_SERVICE** (default region): 3 instances for dev/test, 5-10 for production traffic.
- **ROUTING_GATEWAY_SERVICE**: 3 instances is sufficient — lightweight gunicorn proxy (2 workers, 4 threads, 300s timeout). `MATRIX_CONCURRENCY=6` env var controls ThreadPoolExecutor parallelism per batch.
- **ORS_SERVICE_\<REGION\>** (city-specific): 1 instance per region.
- **Other services** (vroom, control app): 1 instance each.
- **Never set ORS and gateway to the same instance count** unless explicitly needed. Use the 3-arg `SCALE_SERVICES(ors, gateway, pool_nodes)` overload.

### Pool node formula
```
total_containers = ors_instances + gateway_instances + region_services + 3  -- (vroom + control app)
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
| Gateway | routing_reverse_proxy | v1.0.0 |
| VROOM | vroom-docker | v1.0.1 |
| Control App | ors_control_app | v1.0.98 |
