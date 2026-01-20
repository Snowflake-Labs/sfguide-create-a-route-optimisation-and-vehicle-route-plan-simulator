# SF Taxi Fleet Intelligence - Data Generation Scripts

This directory contains all the scripts needed to generate the Fleet Intelligence demo data from scratch.

## Overview

The scripts create a simulated taxi fleet with configurable parameters:
- **Drivers**: 20 to 500+ drivers with shift patterns
- **Days**: 1 to 30+ days of simulation
- **Routes**: Real road routes via OpenRouteService
- **Locations**: GPS tracking points along routes

## Configuration

### Key Parameters

| Parameter | Default | Where to Change |
|-----------|---------|-----------------|
| Number of drivers | 80 | `03_create_drivers.sql` |
| Number of days | 1 | `04_create_trips.sql` |
| Start date | 2015-06-24 | `04_create_trips.sql`, `05_generate_routes.sql` |
| Warehouse size | MEDIUM | `01_setup_database.sql` |

### Recommended Warehouse Sizes

| Drivers | Days | Est. Rows | Warehouse | Est. Time |
|---------|------|-----------|-----------|-----------|
| 20 | 1 | ~4K | SMALL | 2-3 min |
| 80 | 1 | ~18K | MEDIUM | 5-8 min |
| 80 | 7 | ~125K | LARGE | 20-30 min |
| 200 | 1 | ~45K | LARGE | 15-20 min |
| 200 | 7 | ~315K | XLARGE | 45-60 min |
| 500 | 7 | ~800K | XLARGE | 2-3 hours |

*Note: Rows estimated at 15 location points per trip (includes waiting, pickup, driving, dropoff, idle states)*

## Prerequisites

1. **Snowflake Account** with appropriate privileges
2. **OpenRouteService Native App** installed from Snowflake Marketplace
3. **Overture Maps Data** shares:
   - `OVERTURE_MAPS__PLACES`
   - `OVERTURE_MAPS__ADDRESSES`
4. **Python 3.8+** (for deployment scripts)

## Quick Start (Default: 80 drivers, 1 day)

```bash
# Install dependencies
pip install -r requirements.txt

# Run all SQL scripts
python run_all.py \
    --account your_account \
    --user your_user \
    --password your_password

# Deploy Streamlit app
python deploy_streamlit.py \
    --account your_account \
    --user your_user \
    --password your_password
```

Then run `08_deploy_streamlit.sql` in Snowsight.

## Manual Execution

Execute each SQL script in order in Snowsight or SnowSQL:

1. `01_setup_database.sql` - Create database, schemas, warehouse
2. `02_create_base_locations.sql` - Load SF locations from Overture Maps
3. `03_create_drivers.sql` - Create drivers with shift patterns
4. `04_create_trips.sql` - Generate trips with varied counts
5. `05_generate_routes.sql` - Generate ORS routes (takes a few minutes)
6. `06_create_driver_locations.sql` - Create interpolated location points
7. `07_create_analytics_views.sql` - Create views for Streamlit
8. `08_deploy_streamlit.sql` - Deploy the Streamlit app

## Customization Guide

### Changing Number of Drivers

Edit `03_create_drivers.sql`, modify the `driver_count` values in `shift_patterns`:

```sql
-- Default: 80 drivers total
SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, 8 AS driver_count UNION ALL
SELECT 2, 'Early', 4, 12, 18 UNION ALL
SELECT 3, 'Morning', 6, 14, 22 UNION ALL
SELECT 4, 'Day', 11, 19, 18 UNION ALL
SELECT 5, 'Evening', 15, 23, 14

-- For 200 drivers (scale proportionally):
SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, 20 AS driver_count UNION ALL
SELECT 2, 'Early', 4, 12, 45 UNION ALL
SELECT 3, 'Morning', 6, 14, 55 UNION ALL
SELECT 4, 'Day', 11, 19, 45 UNION ALL
SELECT 5, 'Evening', 15, 23, 35

-- For 40 drivers (half scale):
SELECT 1 AS shift_id, 'Graveyard' AS shift_name, 22 AS shift_start, 6 AS shift_end, 4 AS driver_count UNION ALL
SELECT 2, 'Early', 4, 12, 9 UNION ALL
SELECT 3, 'Morning', 6, 14, 11 UNION ALL
SELECT 4, 'Day', 11, 19, 9 UNION ALL
SELECT 5, 'Evening', 15, 23, 7
```

**Shift distribution formula:**
| Shift | % of Fleet |
|-------|------------|
| Graveyard | 10% |
| Early | 22.5% |
| Morning | 27.5% |
| Day | 22.5% |
| Evening | 17.5% |

### Changing Number of Days

Edit `04_create_trips.sql` to add a days generator and cross join:

```sql
-- Add this CTE at the beginning:
days AS (
    SELECT 
        DATEADD('day', SEQ4(), '2015-06-24'::DATE) AS SIM_DATE,
        SEQ4() AS DAY_NUM
    FROM TABLE(GENERATOR(ROWCOUNT => 7))  -- Change 7 to desired number of days
),

-- Modify driver_trip_counts to cross join with days:
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
            -- ... rest of cases
        END AS NUM_TRIPS
    FROM TAXI_DRIVERS d
    CROSS JOIN days dy  -- Add this cross join
),

-- Update TRIP_ID to include day:
MD5(t.DRIVER_ID || '-' || t.DAY_NUM || '-' || t.TRIP_NUMBER || '-' || RANDOM()) AS TRIP_ID,
```

Then update `05_generate_routes.sql` and `06_create_driver_locations.sql` to use `SIM_DATE` instead of hardcoded date.

### Changing Warehouse Size

Edit `01_setup_database.sql`:

```sql
-- Small datasets (≤80 drivers, 1 day)
WAREHOUSE_SIZE = 'MEDIUM'

-- Medium datasets (≤200 drivers, ≤7 days)
WAREHOUSE_SIZE = 'LARGE'

-- Large datasets (>200 drivers or >7 days)
WAREHOUSE_SIZE = 'XLARGE'

-- Very large datasets (>500 drivers or >30 days)
WAREHOUSE_SIZE = '2XLARGE'
```

### Changing Trip Counts per Driver

Edit `04_create_trips.sql`, modify the UNIFORM ranges:

```sql
CASE d.SHIFT_TYPE
    WHEN 'Morning' THEN UNIFORM(14, 22, RANDOM())  -- Busiest: 14-22 trips
    WHEN 'Day' THEN UNIFORM(12, 20, RANDOM())      -- 12-20 trips
    WHEN 'Early' THEN UNIFORM(10, 18, RANDOM())    -- 10-18 trips
    WHEN 'Evening' THEN UNIFORM(10, 16, RANDOM())  -- 10-16 trips
    WHEN 'Graveyard' THEN UNIFORM(6, 12, RANDOM()) -- Quietest: 6-12 trips
END AS NUM_TRIPS
```

### Using a Different City

Edit `02_create_base_locations.sql`, change the bounding box:

```sql
-- San Francisco (default)
ST_X(GEOMETRY) BETWEEN -122.52 AND -122.35
AND ST_Y(GEOMETRY) BETWEEN 37.70 AND 37.82

-- New York City
ST_X(GEOMETRY) BETWEEN -74.05 AND -73.90
AND ST_Y(GEOMETRY) BETWEEN 40.65 AND 40.85

-- London
ST_X(GEOMETRY) BETWEEN -0.20 AND 0.05
AND ST_Y(GEOMETRY) BETWEEN 51.45 AND 51.55

-- Paris
ST_X(GEOMETRY) BETWEEN 2.25 AND 2.42
AND ST_Y(GEOMETRY) BETWEEN 48.82 AND 48.90
```

## Script Details

### 01_setup_database.sql
Creates the `FLEET_INTELLIGENCE` database with `PUBLIC` and `ANALYTICS` schemas, plus a stage for Streamlit files.

### 02_create_base_locations.sql
Loads ~250,000 San Francisco locations from Overture Maps:
- POIs (restaurants, shops, landmarks)
- Street addresses

### 03_create_drivers.sql
Creates taxi drivers distributed across 5 shifts for 24-hour coverage with peak staffing.

### 04_create_trips.sql
Generates trips with varied counts based on shift busyness.

### 05_generate_routes.sql
Calls `OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS()` for each trip to generate actual road-following routes. This is the longest-running script.

### 06_create_driver_locations.sql
Interpolates 15 points along each route (index 0-14) with realistic driver states and speed patterns:

**Driver States:**
| Point Index | State | Speed | Description |
|-------------|-------|-------|-------------|
| 0 | waiting | 0 km/h | Waiting for fare (2-8 min before trip) |
| 1 | pickup | 0 km/h | Passenger boarding |
| 2-12 | driving | Variable | En route with traffic simulation |
| 13 | dropoff | 0-3 km/h | Slowing for passenger exit |
| 14 | idle | 0 km/h | Brief idle after dropoff |

**Speed Distribution (realistic traffic simulation):**
| Speed Band | Percentage | Description |
|------------|------------|-------------|
| 0 km/h (Stationary) | ~23% | Waiting, pickup, dropoff, idle |
| 1-5 km/h (Crawling) | ~11% | Traffic jams, red lights |
| 6-15 km/h (Slow) | ~14% | Heavy traffic |
| 16-30 km/h (Moderate) | ~26% | Normal city driving |
| 31-45 km/h (Normal) | ~20% | Clear roads |
| 46+ km/h (Fast) | ~6% | Late night, highways |

**Time-of-day variation:**
- **Peak hours (7-9 AM, 5-7 PM)**: 15-20% stopped/crawling due to traffic
- **Late night (12-5 AM)**: Mostly fast with minimal slow traffic
- **Normal hours**: Mixed distribution

### 07_create_analytics_views.sql
Creates views in the `ANALYTICS` schema for Streamlit consumption.

### 08_deploy_streamlit.sql
Creates the Streamlit app from files in the stage.

## Data Model

```
FLEET_INTELLIGENCE
├── PUBLIC (schema)
│   ├── SF_TAXI_LOCATIONS      # Base location data
│   ├── TAXI_DRIVERS           # Driver master data
│   ├── DRIVERS                # Driver display data
│   ├── DRIVER_TRIPS           # Trip assignments
│   ├── DRIVER_TRIPS_WITH_COORDS # Trips with coordinates
│   ├── DRIVER_ROUTES          # Raw ORS responses
│   ├── DRIVER_ROUTES_PARSED   # Parsed route data
│   ├── DRIVER_ROUTE_GEOMETRIES # Routes with timing
│   └── DRIVER_LOCATIONS       # Interpolated positions with driver states
│
└── ANALYTICS (schema)
    ├── DRIVERS                # View
    ├── DRIVER_LOCATIONS       # View with LON/LAT and DRIVER_STATE
    ├── TRIPS_ASSIGNED_TO_DRIVERS # View
    ├── ROUTE_NAMES            # View
    └── TRIP_SUMMARY           # View
```

## Troubleshooting

### ORS Routes Failing
- Ensure OpenRouteService Native App is installed and accessible
- Check that pickup/dropoff coordinates are within city bounds
- Verify the app has not hit rate limits
- For large datasets, consider batching route generation

### Query Timeouts
- Increase warehouse size
- For very large datasets, split route generation into batches
- Consider running during off-peak hours

### Missing Overture Maps Data
- Install the Overture Maps shares from Snowflake Marketplace
- Search for "Carto Overture Maps"
- Grant appropriate privileges to your role

### Streamlit Not Loading
- Verify all files are uploaded to the stage
- Check that `environment.yml` includes all required packages
- Ensure the warehouse is running

### Out of Memory
- Use a larger warehouse size
- Reduce number of drivers or days for testing
- Process in batches

## Re-running Scripts

To regenerate all data from scratch:

```bash
python run_all.py --account ... --user ... --password ...
```

To regenerate specific tables, run the individual SQL scripts in Snowsight.

To skip to a specific step:

```bash
python run_all.py --skip-to 5 --account ... --user ... --password ...
```
