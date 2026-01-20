---
name: generate-driver-locations
description: "Generate realistic taxi driver location data for the Fleet Intelligence solution using Overture Maps data and OpenRouteService for actual road routes. Configurable number of drivers (default 80), days of simulation (default 1), and shift patterns. Use when: setting up driver location data, generating route-based simulation, deploying fleet dashboard. Triggers: generate driver locations, create driver data, setup fleet data, deploy streamlit, fleet intelligence dashboard."
---

# Generate Driver Locations & Deploy Fleet Intelligence Dashboard

Generates realistic taxi driver location data for the Fleet Intelligence solution using:
- **Overture Maps Places & Addresses** - Points of interest and street addresses for pickup/dropoff locations
- **OpenRouteService Native App** - Real road routing for actual driving paths
- **Route Interpolation** - Driver positions along actual roads
- **Configurable Fleet Size** - Set number of drivers and simulation days

## Configuration Parameters

Before running the scripts, determine these parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `NUM_DRIVERS` | 80 | Total number of taxi drivers |
| `NUM_DAYS` | 1 | Number of days to simulate |
| `START_DATE` | 2015-06-24 | First day of simulation |
| `WAREHOUSE_SIZE` | MEDIUM | Warehouse size for data generation |

### Recommended Warehouse Sizes

| Drivers | Days | Estimated Rows | Warehouse | Est. Time |
|---------|------|----------------|-----------|-----------|
| 20 | 1 | ~3,000 | SMALL | 2-3 min |
| 80 | 1 | ~13,000 | MEDIUM | 5-8 min |
| 80 | 7 | ~90,000 | LARGE | 20-30 min |
| 200 | 1 | ~35,000 | LARGE | 15-20 min |
| 200 | 7 | ~250,000 | XLARGE | 45-60 min |
| 500 | 7 | ~600,000 | XLARGE | 2-3 hours |

**Formula:** `Rows ≈ NUM_DRIVERS × AVG_TRIPS_PER_DRIVER × 11 points × NUM_DAYS`

## Prerequisites

1. **Snowflake Account** with appropriate privileges
2. **OpenRouteService Native App** installed from Snowflake Marketplace
3. **Overture Maps Data** shares:
   - `OVERTURE_MAPS__PLACES`
   - `OVERTURE_MAPS__ADDRESSES`

## Scripts Location

All scripts are in: `oss-deploy-a-fleet-intelligence-solution-for-taxis/scripts/`

---

## Workflow

### Step 1: Configure Warehouse Size

**Goal:** Create appropriately sized warehouse for data generation

**Action:** Execute `scripts/01_setup_database.sql` with modified warehouse size

**Modify the script** based on your parameters:

```sql
-- For small datasets (≤80 drivers, 1 day)
CREATE WAREHOUSE IF NOT EXISTS COMPUTE_WH
    WAREHOUSE_SIZE = 'MEDIUM'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE;

-- For medium datasets (≤200 drivers, ≤7 days)  
CREATE WAREHOUSE IF NOT EXISTS COMPUTE_WH
    WAREHOUSE_SIZE = 'LARGE'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE;

-- For large datasets (>200 drivers or >7 days)
CREATE WAREHOUSE IF NOT EXISTS COMPUTE_WH
    WAREHOUSE_SIZE = 'XLARGE'
    AUTO_SUSPEND = 60
    AUTO_RESUME = TRUE;
```

**Output:** Warehouse and database infrastructure ready

---

### Step 2: Create Base Locations

**Goal:** Load San Francisco locations from Overture Maps

**Action:** Execute `scripts/02_create_base_locations.sql`

No modifications needed - this creates the location pool for all configurations.

**Output:** ~250,000 SF locations for pickup/dropoff points

---

### Step 3: Create Drivers with Shift Patterns

**Goal:** Create drivers distributed across shifts

**Action:** Execute `scripts/03_create_drivers.sql` with modified driver counts

**Modify the `shift_patterns` CTE** to change total drivers:

```sql
-- Default: 80 drivers
SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, 8 AS driver_count UNION ALL
SELECT 2, 'Early', 4, 12, 18 UNION ALL
SELECT 3, 'Morning', 6, 14, 22 UNION ALL
SELECT 4, 'Day', 11, 19, 18 UNION ALL
SELECT 5, 'Evening', 15, 23, 14

-- Example: 200 drivers (proportionally scaled)
SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, 20 AS driver_count UNION ALL
SELECT 2, 'Early', 4, 12, 45 UNION ALL
SELECT 3, 'Morning', 6, 14, 55 UNION ALL
SELECT 4, 'Day', 11, 19, 45 UNION ALL
SELECT 5, 'Evening', 15, 23, 35

-- Example: 40 drivers (half scale)
SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, 4 AS driver_count UNION ALL
SELECT 2, 'Early', 4, 12, 9 UNION ALL
SELECT 3, 'Morning', 6, 14, 11 UNION ALL
SELECT 4, 'Day', 11, 19, 9 UNION ALL
SELECT 5, 'Evening', 15, 23, 7
```

**Shift Distribution Formula:**
| Shift | % of Fleet | Purpose |
|-------|------------|---------|
| Graveyard | 10% | Overnight |
| Early | 22.5% | Early morning |
| Morning | 27.5% | Peak AM rush |
| Day | 22.5% | Midday |
| Evening | 17.5% | PM rush |

**Output:** Configured number of drivers with shift schedules

---

### Step 4: Generate Trips with Varied Counts

**Goal:** Create trip assignments for each day

**Action:** Execute `scripts/04_create_trips.sql` with modified day range

**Modify for multiple days** - replace the single date with a date range:

```sql
-- Single day (default)
-- Uses: '2015-06-24'

-- Multiple days: Modify the trips_with_hours CTE to generate for each day
-- Add this CTE before trip generation:
days AS (
    SELECT 
        DATEADD('day', SEQ4(), '2015-06-24'::DATE) AS SIM_DATE,
        SEQ4() AS DAY_NUM
    FROM TABLE(GENERATOR(ROWCOUNT => <NUM_DAYS>))  -- Replace with number of days
),

-- Then cross join with days in the trip generation
```

**Full multi-day modification for `04_create_trips.sql`:**

```sql
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PUBLIC.DRIVER_TRIPS AS
WITH 
-- Generate simulation days
days AS (
    SELECT 
        DATEADD('day', SEQ4(), '2015-06-24'::DATE) AS SIM_DATE,
        SEQ4() AS DAY_NUM
    FROM TABLE(GENERATOR(ROWCOUNT => 7))  -- <<< SET NUMBER OF DAYS HERE
),
-- Determine number of trips per driver per day (varied)
driver_trip_counts AS (
    SELECT 
        d.DRIVER_ID,
        d.SHIFT_TYPE,
        d.SHIFT_START_HOUR,
        d.SHIFT_END_HOUR,
        d.SHIFT_CROSSES_MIDNIGHT,
        dy.SIM_DATE,
        dy.DAY_NUM,
        CASE d.SHIFT_TYPE
            WHEN 'Morning' THEN UNIFORM(14, 22, RANDOM())
            WHEN 'Day' THEN UNIFORM(12, 20, RANDOM())
            WHEN 'Early' THEN UNIFORM(10, 18, RANDOM())
            WHEN 'Evening' THEN UNIFORM(10, 16, RANDOM())
            WHEN 'Graveyard' THEN UNIFORM(6, 12, RANDOM())
        END AS NUM_TRIPS
    FROM TAXI_DRIVERS d
    CROSS JOIN days dy
),
-- Rest of the query remains the same but includes SIM_DATE in TRIP_ID generation
...
```

**Output:** Trips for all configured days

---

### Step 5: Generate ORS Routes

**Goal:** Generate actual road routes using OpenRouteService

**Action:** Execute `scripts/05_generate_routes.sql`

⚠️ **Time scales with trip count:**
- 1,000 trips: ~3-5 minutes
- 5,000 trips: ~15-20 minutes  
- 10,000 trips: ~30-45 minutes

**For large datasets**, consider batching:

```sql
-- Generate routes in batches of 1000
CREATE OR REPLACE TABLE FLEET_INTELLIGENCE.PUBLIC.DRIVER_ROUTES AS
SELECT * FROM (
    SELECT 
        *,
        OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(...) AS ROUTE_RESPONSE
    FROM DRIVER_TRIPS_WITH_COORDS
    WHERE MOD(ABS(HASH(TRIP_ID)), 10) = 0  -- First 10%
);

-- Then INSERT for remaining batches...
```

**Output:** Road-following route geometries for all trips

---

### Step 6: Create Driver Locations

**Goal:** Interpolate driver positions along routes

**Action:** Execute `scripts/06_create_driver_locations.sql`

**Modify for multiple days** - update the timestamp calculation:

```sql
-- Single day version uses:
DATEADD('hour', TRIP_HOUR, '2015-06-24'::TIMESTAMP_NTZ)

-- Multi-day version should use SIM_DATE from trips:
DATEADD('hour', TRIP_HOUR, SIM_DATE::TIMESTAMP_NTZ)
```

**Output:** Location points for all trips across all days

---

### Step 7: Create Analytics Views

**Goal:** Create views for Streamlit consumption

**Action:** Execute `scripts/07_create_analytics_views.sql`

No modifications needed - views work with any data volume.

**Output:** Analytics views ready for Streamlit

---

### Step 8: Deploy Streamlit Files

**Goal:** Upload Streamlit app files to Snowflake stage

**Action:** Run `scripts/deploy_streamlit.py`

```bash
python scripts/deploy_streamlit.py \
    --account <account> \
    --user <user> \
    --password <password>
```

**Output:** Streamlit files uploaded to stage

---

### Step 9: Create Streamlit App

**Goal:** Deploy the Streamlit application

**Action:** Execute `scripts/08_deploy_streamlit.sql`

**Output:** Streamlit app deployed and accessible in Snowsight

---

## Quick Start (Run All)

For automated execution with default settings (80 drivers, 1 day):

```bash
cd oss-deploy-a-fleet-intelligence-solution-for-taxis/scripts

# Install Python dependencies
pip install -r requirements.txt

# Run all SQL scripts (01-07)
python run_all.py \
    --account <account> \
    --user <user> \
    --password <password>

# Deploy Streamlit files
python deploy_streamlit.py \
    --account <account> \
    --user <user> \
    --password <password>

# Then run 08_deploy_streamlit.sql in Snowsight
```

---

## Configuration Examples

### Example 1: Small Demo (20 drivers, 1 day)

```sql
-- 03_create_drivers.sql - shift_patterns CTE:
SELECT 1, 'Graveyard', 22, 6, 2 UNION ALL
SELECT 2, 'Early', 4, 12, 4 UNION ALL
SELECT 3, 'Morning', 6, 14, 6 UNION ALL
SELECT 4, 'Day', 11, 19, 4 UNION ALL
SELECT 5, 'Evening', 15, 23, 4

-- Warehouse: SMALL
-- Estimated rows: ~3,000
-- Est. time: 2-3 minutes
```

### Example 2: Production (200 drivers, 7 days)

```sql
-- 01_setup_database.sql:
WAREHOUSE_SIZE = 'XLARGE'

-- 03_create_drivers.sql - shift_patterns CTE:
SELECT 1, 'Graveyard', 22, 6, 20 UNION ALL
SELECT 2, 'Early', 4, 12, 45 UNION ALL
SELECT 3, 'Morning', 6, 14, 55 UNION ALL
SELECT 4, 'Day', 11, 19, 45 UNION ALL
SELECT 5, 'Evening', 15, 23, 35

-- 04_create_trips.sql - days CTE:
FROM TABLE(GENERATOR(ROWCOUNT => 7))

-- Estimated rows: ~250,000
-- Est. time: 45-60 minutes
```

### Example 3: Load Test (500 drivers, 30 days)

```sql
-- 01_setup_database.sql:
WAREHOUSE_SIZE = '2XLARGE'

-- 03_create_drivers.sql - shift_patterns CTE:
SELECT 1, 'Graveyard', 22, 6, 50 UNION ALL
SELECT 2, 'Early', 4, 12, 112 UNION ALL
SELECT 3, 'Morning', 6, 14, 138 UNION ALL
SELECT 4, 'Day', 11, 19, 112 UNION ALL
SELECT 5, 'Evening', 15, 23, 88

-- 04_create_trips.sql - days CTE:
FROM TABLE(GENERATOR(ROWCOUNT => 30))

-- Estimated rows: ~2.5 million
-- Est. time: 3-5 hours
-- Consider: Batch route generation
```

---

## Data Model

```
FLEET_INTELLIGENCE
├── PUBLIC (schema)
│   ├── SF_TAXI_LOCATIONS      # ~250K SF locations
│   ├── TAXI_DRIVERS           # Configured driver count
│   ├── DRIVERS                # Driver display data
│   ├── DRIVER_TRIPS           # Trip assignments
│   ├── DRIVER_TRIPS_WITH_COORDS # Trips with coordinates
│   ├── DRIVER_ROUTES          # Raw ORS responses
│   ├── DRIVER_ROUTES_PARSED   # Parsed route data
│   ├── DRIVER_ROUTE_GEOMETRIES # Routes with timing
│   └── DRIVER_LOCATIONS       # Interpolated positions
│
└── ANALYTICS (schema)
    ├── DRIVERS                # View
    ├── DRIVER_LOCATIONS       # View with LON/LAT
    ├── TRIPS_ASSIGNED_TO_DRIVERS # View
    ├── ROUTE_NAMES            # View
    └── TRIP_SUMMARY           # View
```

---

## Shift Pattern Design

Default distribution (scales proportionally):

| Shift | Hours | % of Fleet | Purpose |
|-------|-------|------------|---------|
| **Graveyard** | 22:00-06:00 | 10% | Overnight coverage |
| **Early** | 04:00-12:00 | 22.5% | Early morning + AM rush |
| **Morning** | 06:00-14:00 | 27.5% | Peak AM rush |
| **Day** | 11:00-19:00 | 22.5% | Midday + PM rush |
| **Evening** | 15:00-23:00 | 17.5% | Afternoon + PM rush |

---

## Output Statistics (Default: 80 drivers, 1 day)

| Metric | Value |
|--------|-------|
| Total drivers | 80 |
| Total trips | ~1,200 |
| Min trips/driver | 8 |
| Max trips/driver | 22 |
| Location points | ~13,000 |
| Avg route distance | ~6.5 km |
| Avg route duration | ~12 min |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes failing | Verify OpenRouteService Native App is installed |
| Query timeout | Increase warehouse size |
| Out of memory | Use larger warehouse or batch processing |
| Missing Overture data | Install shares from Snowflake Marketplace |
| Streamlit not loading | Check all files uploaded to stage |

See `scripts/README.md` for detailed troubleshooting.
