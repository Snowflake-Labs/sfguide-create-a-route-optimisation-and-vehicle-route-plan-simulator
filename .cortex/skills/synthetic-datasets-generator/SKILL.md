---
name: synthetic-datasets-generator
description: "Generate realistic synthetic GPS telemetry datasets for HGV truck fleets operating in configurable regions. Creates road-following routes via ORS, realistic driver behavior profiles (COMPLIANT/MILD/OUTLIER), EU HOS compliance, variable telemetry intervals, and loads data into Snowflake star schema (7 tables). Supports 10-500+ trucks over 1-3 months. Use when: generating synthetic fleet data, creating test telemetry datasets, populating fleet demo tables, benchmarking fleet analytics. Do NOT use for: deploying route deviation demo (use route-deviation), real-time fleet tracking, food delivery data (use fleet-intelligence-food-delivery). Triggers: generate synthetic telemetry, create fleet data, synthetic truck data, generate GPS data, populate telemetry tables, synthetic dataset."
depends_on:
  - build-routing-solution
  - routing-customization
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: fleet-intelligence
---

# Synthetic Fleet Telemetry Generator

Generates realistic GPS telemetry data for HGV truck fleets using real POI locations from Overture Maps, road-following routes from OpenRouteService (ORS), and configurable driver behavior profiles. Outputs a Snowflake star schema with 4 dimension tables and 3 fact tables.

---

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates SYNTHETIC_DATASETS database |
| USAGE ON WAREHOUSE | Warehouse | Data generation and COPY INTO operations |
| CREATE SCHEMA | Database (SYNTHETIC_DATASETS) | Creates FLEET_INTELLIGENCE schema |
| CREATE TABLE | Schema | Creates dimension and fact tables |
| CREATE STAGE | Schema | Creates TELEMETRY_STAGE for Parquet uploads |
| USAGE ON APPLICATION OPENROUTESERVICE_NATIVE_APP | Application | Calls DIRECTIONS function for route generation |

> **Note:** ACCOUNTADMIN is NOT required. Create a custom role with the above privileges.

## Important

Before running the generator, verify these prerequisites:

1. **ORS Native App** must be deployed and running. Verify with:
   ```sql
   SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
   ```
   All 4 services must be RUNNING. If suspended, resume the compute pool first (see `routing-customization` skill).

2. **ORS region** must cover the target area. Default is Germany. To change region, use the `routing-customization` skill.

3. **Overture Maps POI tables** should exist in the target schema. If missing, the generator automatically falls back to synthetic POI generation within the configured bounding box.

4. **Python dependencies**: `snowflake-connector-python pandas numpy pyarrow pyyaml python-dateutil`

5. **Snowflake connection**: Set `SNOWFLAKE_CONNECTION_NAME` environment variable or configure `snowflake.connection_name` in the config YAML.

---

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `fleet.num_trucks` | 10 | Number of trucks (10 for testing, 500 for production) |
| `time.start_date` | 2025-12-01 | First day of simulation |
| `time.duration_months` | 1 | Simulation duration in months |
| `time.chunk_size_days` | 7 | Processing chunk size (memory efficiency) |
| `fleet.weekday_operating_rate` | 0.85 | Fraction of fleet operating on weekdays |
| `fleet.weekend_operating_rate` | 0.40 | Fraction of fleet operating on weekends |
| `region.name` | germany | Target region |
| `seed` | 42 | RNG seed for reproducibility |

For the complete parameter reference, consult `references/configuration-guide.md`.

Three config presets are available in `scripts/config/`:
- **`de_trucks_retail.yml`** -- Germany truck fleet, standard config (10 trucks, 1 month)
- **`de_trucks_retail_calibrated.yml`** -- Germany truck fleet, industry-calibrated (heterogeneous truck types, tuned statistical targets)
- **`sf_ebikes_food_delivery.yml`** -- San Francisco e-bike food delivery (500 vehicles, 1 month)

---

## Error Logging

When any step fails or produces unexpected results (SQL errors, missing objects, wrong row counts, service failures, deployment issues), log the issue to `logs/` following the format in `logs/README.md`. Create one log file per execution: `synthetic-datasets-generator_{YYYY-MM-DD}_{HH-MM}.md`. Continue execution where possible, logging all issues encountered. If execution completes with no issues, do not create a log file.

## Execution Rules

1. Run one SQL statement per `snowflake_sql_execute` call. Never batch multiple statements.
2. Use fully qualified object names: `{DATABASE}.{SCHEMA}.{TABLE}`.
3. After every CTAS or COPY INTO, verify row counts with `SELECT COUNT(*)`.
4. Set the query tag at the start of every session:
   ```sql
   ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"synthetic-datasets-generator","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
   ```
5. Never use `SET` variables. Substitute values directly into SQL.
6. All Python scripts live in `scripts/` within this skill folder. Run them from that directory.

---

## Quick Load from S3 (Alternative)

If you do not need to generate fresh data and just want the pre-built dataset, use `references/s3-load-fleet-intelligence.sql`. This loads all 5 source tables (GERMANY_DESTINATIONS, GERMANY_REST_STOPS, TRUCK_FLEET, TRIP_SCHEDULE, FACT_TRUCK_TELEMETRY) from the public `s3://fleet-intelligence/` bucket into `SYNTHETIC_DATASETS.FLEET_INTELLIGENCE`. Takes 2-5 minutes vs 30-60 minutes for fresh generation.

Both the `route-deviation` and `dwell-analysis` skills auto-detect and use this script when source data is missing.

---

## Workflow

### Step 1: Verify Prerequisites

Confirm ORS is running:

```sql
SHOW SERVICES IN APPLICATION OPENROUTESERVICE_NATIVE_APP;
```

Test routing returns a valid result (DISTANCE > 0):

```sql
SELECT * FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
    'driving-hgv',
    OBJECT_CONSTRUCT('coordinates', ARRAY_CONSTRUCT(
        ARRAY_CONSTRUCT(13.388860, 52.517037),
        ARRAY_CONSTRUCT(13.397634, 52.529407)
    ))::VARIANT
));
```

Check POI tables exist:

```sql
SELECT COUNT(*) FROM {DATABASE}.{SCHEMA}.GERMANY_WAREHOUSES;
SELECT COUNT(*) FROM {DATABASE}.{SCHEMA}.GERMANY_DESTINATIONS;
SELECT COUNT(*) FROM {DATABASE}.{SCHEMA}.GERMANY_REST_STOPS;
```

If POI tables are missing, the generator creates fallback synthetic locations automatically.

### Step 2: Configure Parameters

Ask the user for:
- **Fleet size** (10 for quick test, 100-500 for production)
- **Duration** (1-3 months)
- **Target database/schema** (default: FLEET_INTELLIGENCE.ROUTE_CACHE)
- **Region** (default: Germany)

Edit `scripts/config/de_trucks_retail.yml` (or another preset) with the chosen parameters. Key sections to update:
- `snowflake.database`, `snowflake.schema`, `snowflake.warehouse`
- `fleet.num_trucks`
- `time.start_date`, `time.duration_months`
- `region.bbox` (if not Germany)

### Step 3: Setup Snowflake Schema

Run from the `scripts/` directory:

```bash
cd {SKILL_DIR}/scripts && SNOWFLAKE_CONNECTION_NAME={conn} python main.py setup --config config/de_trucks_retail.yml
```

This creates:
- 4 dimension tables: `DIM_WAREHOUSE`, `DIM_STOP`, `DIM_TRUCK`, `DIM_DRIVER`
- 3 fact tables: `FACT_TRUCK_TELEMETRY`, `FACT_TRIP`, `FACT_VIOLATION`
- Internal stage: `TELEMETRY_STAGE`
- Clustering keys on fact tables

### Step 4: Generate and Load Telemetry

```bash
cd {SKILL_DIR}/scripts && SNOWFLAKE_CONNECTION_NAME={conn} python main.py generate --config config/de_trucks_retail.yml --load
```

The `--load` flag uploads Parquet files to the internal stage and runs COPY INTO after generation.

**Expected output per chunk:**
```
Chunk 0: 125,000 points, 450 trips, 35 violations
```

**Expected totals by fleet size (1 month):**

| Trucks | Telemetry Rows | Trips | Time Estimate |
|--------|---------------|-------|---------------|
| 10 | ~150K | ~500 | 2-5 min |
| 100 | ~1.5M | ~5K | 15-30 min |
| 500 | ~10M | ~25K | 1-3 hours |

### Step 5: Run QA Validation

```bash
cd {SKILL_DIR}/scripts && SNOWFLAKE_CONNECTION_NAME={conn} python main.py qa --config config/de_trucks_retail.yml --output qa_results.csv
```

QA checks:
- Row counts within expected ranges
- Temporal coverage (>95% of days)
- Spatial bounds (>99% within region bbox)
- Speeding rate (2-15% of moving points)
- HOS violation rate (0.5-5% of truck-days)
- Detour rate (5-35% of trips)
- Route quality (avg consecutive point gap <2km)
- Null rates (<1% for critical columns)

All checks must pass. If any fail, consult `references/troubleshooting.md`.

### Step 6: Verify Data in Snowflake

Run these verification queries:

```sql
SELECT COUNT(*) as total_rows,
       COUNT(DISTINCT TRUCK_ID) as trucks,
       COUNT(DISTINCT TRIP_ID) as trips,
       MIN(TS) as first_ts,
       MAX(TS) as last_ts
FROM {DATABASE}.{SCHEMA}.FACT_TRUCK_TELEMETRY;
```

```sql
SELECT STATUS, COUNT(*) as cnt, ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) as pct
FROM {DATABASE}.{SCHEMA}.FACT_TRUCK_TELEMETRY
GROUP BY STATUS
ORDER BY cnt DESC;
```

```sql
SELECT DRIVER_PROFILE, COUNT(*) as trucks
FROM {DATABASE}.{SCHEMA}.DIM_TRUCK
GROUP BY DRIVER_PROFILE
ORDER BY trucks DESC;
```

---

## Output Schema

| Table | Type | Description | Key Columns |
|-------|------|-------------|-------------|
| `DIM_WAREHOUSE` | Dimension | Warehouse/depot locations | WAREHOUSE_ID, LONGITUDE, LATITUDE |
| `DIM_STOP` | Dimension | Rest stops and truck parkings | REST_STOP_ID, REST_TYPE, LONGITUDE, LATITUDE |
| `DIM_TRUCK` | Dimension | Fleet with driver profiles | TRUCK_ID, DRIVER_PROFILE, HOME_BASE_ID |
| `DIM_DRIVER` | Dimension | Driver behavior parameters | DRIVER_ID, PROFILE_TYPE, SPEEDING_PROBABILITY |
| `FACT_TRUCK_TELEMETRY` | Fact | GPS telemetry pings | TRUCK_ID, TS, LATITUDE, LONGITUDE, SPEED_KMH, IS_SPEEDING |
| `FACT_TRIP` | Fact | Trip metadata with route geometry | TRIP_ID, ROUTE_GEOG, DISTANCE_KM, IS_DETOUR |
| `FACT_VIOLATION` | Fact | Speeding and HOS violations | VIOLATION_ID, VIOLATION_TYPE, DURATION_MINUTES |

Full DDL and column details in `references/architecture.md`.

---

## Troubleshooting

### ORS returns no routes
**Cause**: ORS compute pool is suspended or region mismatch.
**Solution**: Resume compute pool and verify ORS is configured for the target region. See `routing-customization` skill.

### Fallback POI generators activated
**Cause**: Overture Maps POI tables not found in target schema.
**Solution**: Load POI data first (see `fleet-intelligence-taxis` skill for Overture Maps loading), or accept synthetic fallback locations.

### Memory errors during generation
**Cause**: Fleet size too large for chunk size.
**Solution**: Reduce `time.chunk_size_days` from 7 to 3, or reduce `fleet.num_trucks`.

For more issues, consult `references/troubleshooting.md`.

## Cleanup

To remove all objects created by this skill:

```sql
-- Reverse dependency order: fact tables first, then dimensions, stage, schema, database
DROP TABLE IF EXISTS {DATABASE}.{SCHEMA}.FACT_VIOLATION;
DROP TABLE IF EXISTS {DATABASE}.{SCHEMA}.FACT_TRIP;
DROP TABLE IF EXISTS {DATABASE}.{SCHEMA}.FACT_TRUCK_TELEMETRY;
DROP TABLE IF EXISTS {DATABASE}.{SCHEMA}.DIM_DRIVER;
DROP TABLE IF EXISTS {DATABASE}.{SCHEMA}.DIM_TRUCK;
DROP TABLE IF EXISTS {DATABASE}.{SCHEMA}.DIM_STOP;
DROP TABLE IF EXISTS {DATABASE}.{SCHEMA}.DIM_WAREHOUSE;
DROP STAGE IF EXISTS {DATABASE}.{SCHEMA}.TELEMETRY_STAGE;
DROP SCHEMA IF EXISTS {DATABASE}.{SCHEMA};
```

> **Tip:** Use the `cleanup` skill to auto-discover all tagged objects via COMMENT tracking.
