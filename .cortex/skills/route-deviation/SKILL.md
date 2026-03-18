---
name: route-deviation
description: "Deploy the Route Deviation Analysis demo: load synthetic truck telemetry from S3, populate ORS route cache, run 5-step ETL pipeline, and deploy Streamlit dashboards. Use when: setting up route deviation demo, detour analytics, fleet deviation analysis. Do NOT use for: general fleet tracking, real-time GPS monitoring, or non-deviation routing tasks. Triggers: deploy route deviation, deploy detour analytics, setup deviation analysis, route deviation demo."
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: fleet-intelligence
---

# Deploy Route Deviation Analysis Demo

End-to-end deployment of a Route Deviation Analysis demo comparing actual truck GPS paths against expected ORS routes to detect detours, delays, and anomalies across a 500-truck German fleet.

## Prerequisites

CRITICAL: Verify these before starting:
- OpenRouteService Native App deployed, activated, and configured for **Germany** map
- Active Snowflake connection with ACCOUNTADMIN or sufficient privileges
- Compute warehouse available (MEDIUM recommended for 15M-row telemetry ETL)

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `SOURCE_DB` | `SYNTHETIC_DATASETS` | Database for source tables |
| `SOURCE_SCHEMA` | `FLEET_INTELLIGENCE` | Schema for source tables |
| `TARGET_DB` | `FLEET_INTELLIGENCE` | Database for ETL output tables |
| `TARGET_SCHEMA` | `DEVIATION_ANALYSIS` | Schema for ETL output tables |
| `ROUTE_CACHE_DB` | `FLEET_DEMOS` | Database containing ROUTE_CACHE |
| `ROUTE_CACHE_SCHEMA` | `ROUTING` | Schema containing ROUTE_CACHE |
| `WAREHOUSE` | `COMPUTE_WH` | Warehouse for ETL execution |
| `S3_BUCKET` | `s3://fleet-intelligence/` | S3 location of Parquet dataset |

## Execution Rules

1. **One statement per `snowflake_sql_execute` call.** Multi-statement blocks can silently fail.
2. **Always use fully qualified object names.** `{SOURCE_DB}.{SOURCE_SCHEMA}.<table>`.
3. **Verify row counts after each CTAS and COPY INTO.** Catch silent failures early.
4. **NEVER minimize ORS calls.** ORS runs inside Snowflake, is cheap, and there are NO constraints on number of calls.
5. **Use `[0-9]` instead of `\d` in REGEXP_LIKE patterns.** Snowflake does not support `\d`.

## Workflow

Before executing SQL, consult `references/sql-pipeline.md` for the exact SQL statements. For dataset details and expected row counts, consult `references/dataset-guide.md`.

### Step 1: Set Query Tag

Set the session query tag for tracking. See `references/sql-pipeline.md` > Query Tag.

### Step 2: Verify ORS is Running with Germany Map

1. Run `SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP` — all 4 services must be RUNNING
2. If suspended, resume compute pool and all 4 services
3. Test routing with Berlin coordinates — must return DISTANCE > 0

**STOP** if ORS is not running or Germany map not loaded. Follow `.cortex/skills/routing-customization/SKILL.md` to change the map.

### Step 3: Create Infrastructure

Create source/target databases, schemas, route cache DB/schema, and warehouse. See `references/sql-pipeline.md` > Infrastructure Setup.

### Step 4: Load Source Data from S3

Load 5 tables from `s3://fleet-intelligence/` Parquet files. Each table has different GEOGRAPHY handling — consult `references/dataset-guide.md` > GEOGRAPHY Column Handling for the correct conversion functions.

Load order:
1. Create external stage and file format
2. GERMANY_DESTINATIONS (~75,242 rows)
3. GERMANY_REST_STOPS (~6,315 rows)
4. TRUCK_FLEET (500 rows)
5. TRIP_SCHEDULE (9,343 rows)
6. FACT_TRUCK_TELEMETRY (~15.1M rows — 2-5 min on MEDIUM warehouse)
7. Run verification query to confirm all 5 tables

**STOP** if any table has 0 rows. Debug before proceeding.

### Step 5: Populate Route Cache

Compute expected ORS routes for all Origin-Destination pairs in TRIP_SCHEDULE.

1. Create ROUTE_CACHE table if not exists
2. Check for missing OD pairs — **SKIP** batch population if MISSING_OD_PAIRS = 0
3. Run Python batch script (200 pairs/batch, ~47 batches, ~4 min total)

The batch Python script is in `references/sql-pipeline.md` > Batch Populate (Python). Never try to minimize ORS calls — route the full set.

### Step 6: Run ETL Pipeline

Execute all 5 ETL steps in order. Each is a CREATE OR REPLACE TABLE. Full SQL in `references/sql-pipeline.md`.

| Step | Table | Expected Rows | Timing |
|------|-------|--------------|--------|
| 6.1 | TRIP_ACTUAL_METRICS | ~4,600-4,700 | 3-8 min (15M rows, window functions) |
| 6.2 | OD_EXPECTED_ROUTES | 9,343 | Seconds |
| 6.3 | TRIP_DEVIATION_ANALYSIS | ~3,500-3,600 | Seconds |
| 6.4 | DRIVER_DEVIATION_SUMMARY | 500 | Seconds |
| 6.5 | DAILY_DEVIATION_TRENDS | 14 | Seconds |

**STOP** after 6.2 if OD_EXPECTED_ROUTES has 0 rows — route cache problem, re-run Step 5.

Run the verification query after all 5 steps to confirm row counts.

### Step 7: Deploy Streamlit Dashboards

Two dashboard pages:
- **Route Deviations** (page 10) — KPIs, driver rankings, daily trends, trip detail with maps
- **Route Inspector** (page 11) — GPS point inspection with teleportation filtering

Dashboard files are in the `dashboard/` directory. Ensure they reference the correct `{TARGET_DB}.{TARGET_SCHEMA}` schemas before deploying.

Deploy via `snow streamlit deploy` or manual stage upload + CREATE STREAMLIT. See `references/sql-pipeline.md` > Streamlit Deployment.

### Step 8: Verify End-to-End

1. Check deviation distribution matches expected pattern (see `references/dataset-guide.md` > Expected Deviation Distribution)
2. Check daily trends show 14 days with correct weekday/weekend patterns
3. Get dashboard URL and confirm it loads

## Common Scenarios

- **Fresh deployment:** Run Steps 1-8 sequentially (~15 min total on MEDIUM warehouse)
- **Re-run after failure:** All statements use CREATE OR REPLACE — safe to re-run from failed step
- **Route cache already populated:** Check MISSING_OD_PAIRS count; if 0 skip Step 5.3 entirely

## Stopping Points

- Step 2: STOP if ORS is not running or Germany map not loaded
- Step 4.7: STOP if any source table has 0 rows
- Step 5.2: SKIP Step 5.3 if all OD pairs already cached
- Step 6.2: STOP if OD_EXPECTED_ROUTES has 0 rows (route cache problem)
- Step 8: Verify deviation distribution matches expected pattern

## Troubleshooting

### ORS not installed
**Cause:** OpenRouteService Native App not deployed from Marketplace
**Solution:** Install OpenRouteService from Snowflake Marketplace, then activate and configure for Germany map

### Wrong map region
**Cause:** ORS is running but returns NULL for Germany coordinates
**Solution:** Follow `.cortex/skills/routing-customization/SKILL.md` to load Germany map

### Route cache empty
**Cause:** OD_EXPECTED_ROUTES has 0 rows after ETL Step 6.2
**Solution:** Re-run Step 5. Check that TRIP_SCHEDULE OD IDs match GERMANY_DESTINATIONS IDs

### COPY INTO fails
**Cause:** Permission error on S3 stage
**Solution:** Verify the S3 bucket `s3://fleet-intelligence/` is publicly accessible or add credentials

### GEOMETRY load errors
**Cause:** TO_GEOGRAPHY fails during COPY INTO
**Solution:** Each table uses a different export method. Consult `references/dataset-guide.md` > GEOGRAPHY Column Handling for the correct conversion function per table

### Low TRIP_DEVIATION_ANALYSIS row count
**Cause:** ~25% fewer rows than TRIP_ACTUAL_METRICS
**Solution:** This is expected. HOS limits, time cutoffs, and random-destination trips cause the drop

### `\d` in REGEXP_LIKE
**Cause:** Using Perl-style `\d` in Snowflake regex
**Solution:** Use `[0-9]` instead of `\d` — Snowflake does not support `\d`

### `COUNT(*) AS ROWS` syntax error
**Cause:** `ROWS` is a reserved word in Snowflake
**Solution:** Use `ROW_CNT` as the column alias instead

### Batch ORS too large
**Cause:** Response exceeds 20MB for a batch
**Solution:** Reduce batch size from 200 to 100 in the Python script

## Recovery

All statements use `CREATE OR REPLACE` or `IF NOT EXISTS`, making re-runs safe. No manual cleanup needed — fix the underlying issue and re-run from the failed step.

## Output

Complete Route Deviation Analysis demo with:
- 5 source tables loaded from S3 (~15.1M telemetry points)
- Route cache with ~9,343 OD pairs computed via ORS
- 5 ETL analytics tables (trip metrics, expected routes, deviation analysis, driver summary, daily trends)
- Streamlit dashboard with driver rankings, daily trends, and interactive route maps
