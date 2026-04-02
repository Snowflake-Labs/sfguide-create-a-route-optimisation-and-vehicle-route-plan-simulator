---
name: route-deviation
description: "Deploy the Route Deviation Analysis demo: load synthetic truck telemetry from S3, populate ORS route cache, run 5-step ETL pipeline, and register React dashboard pages. Use when: setting up route deviation demo, detour analytics, fleet deviation analysis. Do NOT use for: general fleet tracking, real-time GPS monitoring, or non-deviation routing tasks. Triggers: deploy route deviation, deploy detour analytics, setup deviation analysis, route deviation demo."
depends_on:
  - build-routing-solution
  - routing-customization
  - synthetic-datasets-generator
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
- Active Snowflake connection with a role that has privileges listed in the Required Privileges section below
- Compute warehouse available (MEDIUM recommended for 15M-row telemetry ETL)

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates SYNTHETIC_DATASETS and FLEET_INTELLIGENCE databases |
| CREATE WAREHOUSE | Account | Creates COMPUTE_WH warehouse |
| USAGE ON DATABASE OPENROUTESERVICE_NATIVE_APP | Database | Calls ORS DIRECTIONS_GEO for route cache |
| CREATE SCHEMA | Database (SYNTHETIC_DATASETS, FLEET_INTELLIGENCE) | Creates source, target, and route cache schemas |
| CREATE TABLE | Schema (multiple) | Creates source tables, ETL tables, route cache |
| CREATE STAGE | Schema (SYNTHETIC_DATASETS.FLEET_INTELLIGENCE) | Creates S3 external stage |
| CREATE FILE FORMAT | Schema (SYNTHETIC_DATASETS.FLEET_INTELLIGENCE) | Creates PARQUET_FF file format |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges, or use any role that has them.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `SOURCE_DB` | `SYNTHETIC_DATASETS` | Database for source tables |
| `SOURCE_SCHEMA` | `FLEET_INTELLIGENCE` | Schema for source tables |
| `TARGET_DB` | `FLEET_INTELLIGENCE` | Database for ETL output tables |
| `TARGET_SCHEMA` | `ROUTE_DEVIATION` | Schema for ETL output tables |
| `ROUTE_CACHE_DB` | `FLEET_INTELLIGENCE` | Database containing ROUTE_CACHE |
| `ROUTE_CACHE_SCHEMA` | `ROUTE_CACHE` | Schema containing ROUTE_CACHE |
| `WAREHOUSE` | `COMPUTE_WH` | Warehouse for ETL execution |
| `S3_BUCKET` | `s3://fleet-intelligence/` | S3 location of Parquet dataset |

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `route-deviation_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Execution Rules

1. **One statement per `snowflake_sql_execute` call.** Multi-statement blocks can silently fail.
2. **Always use fully qualified object names.** `{SOURCE_DB}.{SOURCE_SCHEMA}.<table>`.
3. **Verify row counts after each CTAS and COPY INTO.** Catch silent failures early.
4. **NEVER minimize ORS calls.** ORS runs inside Snowflake, is cheap, and there are NO constraints on number of calls.
5. **Use `[0-9]` instead of `\d` in REGEXP_LIKE patterns.** Snowflake does not support `\d`.

## Step 0: Load San Francisco Baseline (Recommended)

The fastest path to a working demo. Loads pre-computed San Francisco data from S3 in ~2 minutes. No ORS calls needed.

### Quick check

```sql
SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS;
```

If the table exists and has rows, data is already loaded. Skip to Step 7 (Verify End-to-End).

### Load from S3

Execute `references/seed-data.sql`. This creates all tables and loads San Francisco baseline data from `s3://fleet-intelligence/SanFrancisco/route-deviation/`.

This also loads the ROUTE_CACHE table in FLEET_INTELLIGENCE.ROUTE_CACHE.

### Generate data for other regions (optional)

To generate data for a region other than San Francisco, use the full pipeline starting at Step 2.

Or use the centralized provisioner:
```sql
CALL FLEET_INTELLIGENCE.CORE.PROVISION_REGION('<RegionName>', ARRAY_CONSTRUCT('route-deviation'));
```

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

### Step 4: Check & Load Source Data

Check if the synthetic fleet dataset already exists in `SYNTHETIC_DATASETS.FLEET_INTELLIGENCE`. Run the verification query from `references/sql-pipeline.md` > Verify All Source Tables.

**If all 5 tables exist with expected row counts** (FACT_TRUCK_TELEMETRY ~15.1M, TRIP_SCHEDULE 9,343, TRUCK_FLEET 500, GERMANY_DESTINATIONS ~75,242, GERMANY_REST_STOPS ~6,315): **SKIP** to Step 5.

**If any table is missing or has 0 rows:** Load from S3 by executing the canonical loading script at `synthetic-datasets-generator` skill (`s3-load-fleet-intelligence.sql` in its references folder). Run each statement sequentially via `snowflake_sql_execute`. This creates the database, schema, file format, external stage, and loads all 5 tables from `s3://fleet-intelligence/`.

**STOP** if any table still has 0 rows after loading. Debug before proceeding.

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

### Step 7: Verify End-to-End

1. Check deviation distribution matches expected pattern (see `references/dataset-guide.md` > Expected Deviation Distribution)
2. Check daily trends show 14 days with correct weekday/weekend patterns

### Step 8: Register with Demo Dashboard

> **DEPRECATED:** `DEMO_DASHBOARD_APP` has been removed. All demo pages are now built into `ORS_CONTROL_APP` (in `OPENROUTESERVICE_NATIVE_APP`). No registration step is needed — Route Deviation pages are available automatically in the ORS sidebar.

## Dashboard Schema Contract

The React Demo Dashboard pages query these exact tables and columns. If the ETL pipeline changes column names, the React pages must be updated to match.

### TRIP_DEVIATION_ANALYSIS
| Column | Type | Used By |
|--------|------|---------|
| TRIP_ID | VARCHAR | DeviationDashboard, RouteComparison, RouteInspector |
| DRIVER_ID | VARCHAR | DeviationDashboard |
| TRUCK_ID | VARCHAR | RouteInspector (truck selector) |
| TRIP_DATE | DATE | RouteComparison |
| DISTANCE_DEVIATION_PCT | FLOAT | DeviationDashboard, RouteComparison |
| DISTANCE_DEVIATION_KM | FLOAT | DeviationDashboard, RouteComparison |
| ACTUAL_DISTANCE_KM | FLOAT | RouteComparison, RouteInspector |
| ACTUAL_PATH | GEOGRAPHY | RouteComparison (LATERAL FLATTEN ST_ASGEOJSON) |
| EXPECTED_PATH | GEOGRAPHY | RouteComparison (LATERAL FLATTEN ST_ASGEOJSON) |
| ORIGIN_NAME | VARCHAR | RouteComparison |
| DEST_NAME | VARCHAR | RouteComparison |

### DAILY_DEVIATION_TRENDS
| Column | Type | Used By |
|--------|------|---------|
| TRIP_DATE | DATE | DeviationDashboard |
| TOTAL_TRIPS | NUMBER | DeviationDashboard |
| DEVIATION_RATE_PCT | FLOAT | DeviationDashboard |

### DRIVER_DEVIATION_SUMMARY
| Column | Type | Used By |
|--------|------|---------|
| DRIVER_ID | VARCHAR | DeviationDashboard |
| TOTAL_TRIPS | NUMBER | DeviationDashboard |
| AVG_DISTANCE_DEVIATION_PCT | FLOAT | DeviationDashboard |
| MAX_DISTANCE_DEVIATION_PCT | FLOAT | DeviationDashboard |
| TOTAL_EXCESS_KM | FLOAT | DeviationDashboard |

### Cross-Schema: SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.FACT_TRUCK_TELEMETRY
| Column | Type | Used By |
|--------|------|---------|
| TRIP_ID | VARCHAR | RouteInspector (filter) |
| LATITUDE | FLOAT | RouteInspector (GPS track) |
| LONGITUDE | FLOAT | RouteInspector (GPS track) |
| SPEED_KMH | FLOAT | RouteInspector (speed chart) |
| POSTED_SPEED_KMH | FLOAT | RouteInspector (speed limit line) |
| GPS_ACCURACY_M | FLOAT | RouteInspector (accuracy chart, filter) |
| IS_DETOUR | BOOLEAN | RouteInspector (detour highlight) |
| IS_SPEEDING | BOOLEAN | RouteInspector |
| TS | TIMESTAMP | RouteInspector (ordering, teleport detection) |
| STATUS | VARCHAR | RouteInspector |

---

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
- React dashboard pages in Demo Dashboard (Deviation Dashboard, Route Comparison, Route Inspector)

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: ETL tables, route cache, source tables, stages, schemas
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.DAILY_DEVIATION_TRENDS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.DRIVER_DEVIATION_SUMMARY;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_DEVIATION_ANALYSIS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.OD_EXPECTED_ROUTES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION.TRIP_ACTUAL_METRICS;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_DEVIATION;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_CACHE.ROUTE_CACHE;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_CACHE;
DROP TABLE IF EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.FACT_TRUCK_TELEMETRY;
DROP TABLE IF EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.TRIP_SCHEDULE;
DROP TABLE IF EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.TRUCK_FLEET;
DROP TABLE IF EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.GERMANY_REST_STOPS;
DROP TABLE IF EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.GERMANY_DESTINATIONS;
DROP FILE FORMAT IF EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.PARQUET_FF;
DROP STAGE IF EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE.FLEET_INTEL_STAGE;
DROP SCHEMA IF EXISTS SYNTHETIC_DATASETS.FLEET_INTELLIGENCE;
DROP DATABASE IF EXISTS SYNTHETIC_DATASETS;
DROP DATABASE IF EXISTS FLEET_INTELLIGENCE;
DROP WAREHOUSE IF EXISTS COMPUTE_WH;
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
