# Travel Time Matrix Calculation Guide

## Overview

This guide explains how to calculate a travel time and distance matrix between geographic locations using the **OpenRouteService (ORS) Native App** in Snowflake. The approach uses H3 hexagons to represent geographic areas and the **MATRIX function** for efficient bulk calculations.

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│  Source Data        │     │  H3 Hexagon Grid     │     │  Travel Time Matrix │
│  (Addresses/Points) │ ──► │  (Resolution 9)      │ ──► │  (All Pairs)        │
└─────────────────────┘     └──────────────────────┘     └─────────────────────┘
        │                           │                            │
        │                           │                            │
        ▼                           ▼                            ▼
   Overture Maps              Cartesian Join              ORS MATRIX Function
   Address Data               (N×N pairs)                 (Bulk Processing)
```

## Prerequisites

1. **OpenRouteService Native App** installed and configured
2. **MATRIX function available** (v0.6.0+ gateway image required)
3. **Map data downloaded** for your region (e.g., San Francisco)
4. **Overture Maps** data access (for address-based hexagon generation)

## ⚠️ IMPORTANT: Check MATRIX Function Availability

Before proceeding, verify the MATRIX function is available in your ORS installation:

```sql
-- Check if MATRIX function exists
SHOW FUNCTIONS LIKE 'MATRIX' IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;
```

**If no results returned**, you need to upgrade your ORS Native App:

### Upgrading ORS to Support MATRIX

The MATRIX function requires gateway image version **v0.6.0 or later**. To upgrade:

1. **Check current gateway version:**
   ```sql
   SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_NATIVE_APP.CORE.ROUTING_GATEWAY_SERVICE');
   -- Look for image version in output
   ```

2. **If version is < v0.6.0**, contact your administrator to:
   - Update `routing-gateway-service.yaml` to use image `routing_reverse_proxy:v0.6.0`
   - Update `setup_script.sql` to include MATRIX function definitions
   - Register a new application version and upgrade

3. **After upgrade, create the MATRIX functions:**
   ```sql
   CALL OPENROUTESERVICE_NATIVE_APP.CORE.CREATE_FUNCTIONS();
   ```

---

## MATRIX Function Reference

### Function Signatures

```sql
-- Full matrix between all locations
OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
  profile VARCHAR,           -- 'driving-car', 'driving-hgv', 'cycling-road', etc.
  locations ARRAY,           -- Array of [longitude, latitude] pairs
  metrics ARRAY              -- ['duration', 'distance'] or just ['duration']
) RETURNS VARIANT

-- Simplified (duration and distance by default)
OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
  profile VARCHAR,
  locations ARRAY
) RETURNS VARIANT

-- One-to-many (origin to multiple destinations)
OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX_TABULAR(
  profile VARCHAR,
  origin ARRAY,              -- Single [longitude, latitude]
  destinations ARRAY         -- Array of [longitude, latitude] pairs
) RETURNS VARIANT
```

### Example Usage

```sql
-- Calculate 3x3 travel time matrix
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
    'driving-car',
    ARRAY_CONSTRUCT(
        ARRAY_CONSTRUCT(-122.4194, 37.7749),  -- SF City Hall
        ARRAY_CONSTRUCT(-122.3894, 37.7649),  -- Mission District
        ARRAY_CONSTRUCT(-122.4094, 37.7849)   -- Financial District
    ),
    ARRAY_CONSTRUCT('duration', 'distance')
) AS matrix_result;
```

### Response Structure

```json
{
  "durations": [
    [0, 523.35, 249.67],      // From point 0 to all others (seconds)
    [590.25, 0, 514.4],       // From point 1 to all others
    [344.91, 522.17, 0]       // From point 2 to all others
  ],
  "distances": [
    [0, 3783.93, 2097.48],    // From point 0 to all others (meters)
    [4841.75, 0, 3831.48],
    [2450.51, 3482.64, 0]
  ],
  "sources": [...],           // Snapped source locations
  "destinations": [...]       // Snapped destination locations
}
```

---

## Step-by-Step Process

### Step 1: Generate Hexagons from Source Data

Create H3 hexagons at resolution 9 (~174m edge length) from address/building data.

```sql
-- Step 1a: Extract H3 cells from addresses
CREATE OR REPLACE TEMPORARY TABLE SF_ADDRESSES_RAW AS
SELECT h3_point_to_cell_string(a.geometry, 9) AS h3
FROM OVERTURE_MAPS__DIVISIONS.CARTO.DIVISION_AREA d
INNER JOIN OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS a
  ON st_intersects(d.geometry, a.geometry)
WHERE d.COUNTRY = 'US'
  AND d.names:primary::STRING = 'San Francisco'
  AND d.class = 'land'
  AND d.subtype = 'county';

-- Step 1b: Create hexagons table with distinct cells and metadata
CREATE OR REPLACE TABLE FLEET_DEMOS.ROUTING.SF_HEXAGONS AS
WITH hexagon_summary AS (
  SELECT 
    h3,
    COUNT(*) AS address_count
  FROM SF_ADDRESSES_RAW
  GROUP BY h3
)
SELECT 
  h3 AS hex_id,
  address_count,
  H3_CELL_TO_POINT(h3) AS center_point,
  H3_CELL_TO_BOUNDARY(h3) AS boundary,
  ST_X(H3_CELL_TO_POINT(h3)) AS longitude,
  ST_Y(H3_CELL_TO_POINT(h3)) AS latitude
FROM hexagon_summary
ORDER BY address_count DESC;
```

**Key Points:**
- H3 resolution 9 provides ~174m hexagons (good for urban routing)
- Using addresses filters out water/uninhabited areas
- `address_count` can be used for weighting/prioritization

### Step 2: Create Travel Time Matrix Using MATRIX Function

The MATRIX function can process up to **2,500 locations** in a single call (62,500 pairs). For larger datasets, batch processing is required.

```sql
-- Results table
CREATE OR REPLACE TABLE FLEET_DEMOS.ROUTING.SF_TRAVEL_TIME_MATRIX (
  origin_hex VARCHAR NOT NULL,
  dest_hex VARCHAR NOT NULL,
  distance_meters FLOAT,
  duration_seconds FLOAT,
  calculated_at TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  PRIMARY KEY (origin_hex, dest_hex)
);

-- Create batch processing procedure using MATRIX function
CREATE OR REPLACE PROCEDURE FLEET_DEMOS.ROUTING.CALCULATE_MATRIX_BATCH(
  BATCH_SIZE NUMBER DEFAULT 50
)
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
  total_hexagons NUMBER;
  num_batches NUMBER;
  batch_num NUMBER := 0;
  processed_pairs NUMBER := 0;
BEGIN
  -- Get total hexagon count
  SELECT COUNT(*) INTO total_hexagons FROM FLEET_DEMOS.ROUTING.SF_HEXAGONS;
  num_batches := CEIL(total_hexagons / BATCH_SIZE);
  
  -- Process each batch
  FOR batch_num IN 0 TO num_batches - 1 DO
    -- Build locations array for this batch
    INSERT INTO FLEET_DEMOS.ROUTING.SF_TRAVEL_TIME_MATRIX 
      (origin_hex, dest_hex, duration_seconds, distance_meters)
    WITH batch_hexagons AS (
      SELECT hex_id, longitude, latitude,
             ROW_NUMBER() OVER (ORDER BY hex_id) - 1 AS idx
      FROM FLEET_DEMOS.ROUTING.SF_HEXAGONS
      ORDER BY hex_id
      LIMIT :BATCH_SIZE OFFSET (:batch_num * :BATCH_SIZE)
    ),
    locations_array AS (
      SELECT ARRAY_AGG(ARRAY_CONSTRUCT(longitude, latitude)) 
             WITHIN GROUP (ORDER BY idx) AS locs,
             ARRAY_AGG(hex_id) WITHIN GROUP (ORDER BY idx) AS hex_ids
      FROM batch_hexagons
    ),
    matrix_result AS (
      SELECT 
        hex_ids,
        OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
          'driving-car',
          locs,
          ARRAY_CONSTRUCT('duration', 'distance')
        ) AS result
      FROM locations_array
    ),
    flattened AS (
      SELECT
        hex_ids[f_origin.INDEX]::VARCHAR AS origin_hex,
        hex_ids[f_dest.INDEX]::VARCHAR AS dest_hex,
        result:durations[f_origin.INDEX][f_dest.INDEX]::FLOAT AS duration_seconds,
        result:distances[f_origin.INDEX][f_dest.INDEX]::FLOAT AS distance_meters
      FROM matrix_result,
        LATERAL FLATTEN(result:durations) f_origin,
        LATERAL FLATTEN(result:durations[0]) f_dest
      WHERE f_origin.INDEX != f_dest.INDEX  -- Exclude self-pairs
    )
    SELECT * FROM flattened;
    
    processed_pairs := processed_pairs + (BATCH_SIZE * (BATCH_SIZE - 1));
  END FOR;
  
  RETURN 'SUCCESS: Processed approximately ' || processed_pairs || ' pairs';
END;
$$;

-- Execute batch processing
CALL FLEET_DEMOS.ROUTING.CALCULATE_MATRIX_BATCH(50);
```

### Step 3: Full Matrix Calculation (Recommended Approach)

For calculating the complete N×N matrix efficiently, process in chunks where each chunk calculates routes between a subset of origins and ALL destinations:

```sql
CREATE OR REPLACE PROCEDURE FLEET_DEMOS.ROUTING.BUILD_FULL_MATRIX(
  ORIGINS_PER_BATCH NUMBER DEFAULT 10
)
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
  total_hexagons NUMBER;
  all_locations ARRAY;
  all_hex_ids ARRAY;
  batch_origins ARRAY;
  batch_origin_ids ARRAY;
  batch_num NUMBER := 0;
  num_batches NUMBER;
  matrix_response VARIANT;
BEGIN
  -- Get all hexagon data
  SELECT COUNT(*) INTO total_hexagons FROM FLEET_DEMOS.ROUTING.SF_HEXAGONS;
  
  -- Build complete locations and IDs arrays
  SELECT 
    ARRAY_AGG(ARRAY_CONSTRUCT(longitude, latitude) ORDER BY hex_id),
    ARRAY_AGG(hex_id ORDER BY hex_id)
  INTO all_locations, all_hex_ids
  FROM FLEET_DEMOS.ROUTING.SF_HEXAGONS;
  
  num_batches := CEIL(total_hexagons / ORIGINS_PER_BATCH);
  
  -- Process origins in batches, each batch calculates to ALL destinations
  FOR batch_num IN 0 TO num_batches - 1 DO
    -- Get origin subset
    SELECT 
      ARRAY_AGG(ARRAY_CONSTRUCT(longitude, latitude) ORDER BY hex_id),
      ARRAY_AGG(hex_id ORDER BY hex_id)
    INTO batch_origins, batch_origin_ids
    FROM (
      SELECT hex_id, longitude, latitude
      FROM FLEET_DEMOS.ROUTING.SF_HEXAGONS
      ORDER BY hex_id
      LIMIT :ORIGINS_PER_BATCH OFFSET (:batch_num * :ORIGINS_PER_BATCH)
    );
    
    -- Calculate matrix from batch origins to all destinations
    SELECT OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
      'driving-car',
      ARRAY_CAT(:batch_origins, :all_locations),
      ARRAY_CONSTRUCT('duration', 'distance')
    ) INTO matrix_response;
    
    -- Extract and insert results (origins are first N, destinations are rest)
    INSERT INTO FLEET_DEMOS.ROUTING.SF_TRAVEL_TIME_MATRIX
      (origin_hex, dest_hex, duration_seconds, distance_meters)
    SELECT
      :batch_origin_ids[o_idx]::VARCHAR AS origin_hex,
      :all_hex_ids[d_idx - ARRAY_SIZE(:batch_origins)]::VARCHAR AS dest_hex,
      :matrix_response:durations[o_idx][d_idx]::FLOAT AS duration_seconds,
      :matrix_response:distances[o_idx][d_idx]::FLOAT AS distance_meters
    FROM (
      SELECT seq4() AS o_idx FROM TABLE(GENERATOR(ROWCOUNT => ARRAY_SIZE(:batch_origins)))
    ),
    (
      SELECT seq4() + ARRAY_SIZE(:batch_origins) AS d_idx 
      FROM TABLE(GENERATOR(ROWCOUNT => ARRAY_SIZE(:all_locations)))
    )
    WHERE origin_hex != dest_hex;  -- Exclude self-pairs
    
  END FOR;
  
  RETURN 'SUCCESS: Built matrix for ' || total_hexagons || ' hexagons';
END;
$$;
```

### Step 4: Simple Approach for Smaller Datasets (< 50 hexagons)

For smaller datasets, calculate the entire matrix in one call:

```sql
-- One-shot matrix calculation for small datasets
WITH hex_data AS (
  SELECT 
    ARRAY_AGG(ARRAY_CONSTRUCT(longitude, latitude) ORDER BY hex_id) AS locations,
    ARRAY_AGG(hex_id ORDER BY hex_id) AS hex_ids
  FROM FLEET_DEMOS.ROUTING.SF_HEXAGONS
  LIMIT 50  -- Adjust based on your dataset
),
matrix_result AS (
  SELECT 
    hex_ids,
    OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX(
      'driving-car',
      locations,
      ARRAY_CONSTRUCT('duration', 'distance')
    ) AS matrix
  FROM hex_data
)
SELECT
  hex_ids[o.INDEX]::VARCHAR AS origin_hex,
  hex_ids[d.INDEX]::VARCHAR AS dest_hex,
  matrix:durations[o.INDEX][d.INDEX]::FLOAT / 60 AS duration_minutes,
  matrix:distances[o.INDEX][d.INDEX]::FLOAT / 1000 AS distance_km
FROM matrix_result,
  LATERAL FLATTEN(matrix:durations) o,
  LATERAL FLATTEN(matrix:durations[0]) d
WHERE o.INDEX != d.INDEX;
```

---

## Performance Comparison: MATRIX vs DIRECTIONS

| Hexagons | Pairs | DIRECTIONS (1 call/pair) | MATRIX (bulk) | Speedup |
|----------|-------|--------------------------|---------------|---------|
| 10 | 90 | ~2 minutes | ~2 seconds | 60x |
| 50 | 2,450 | ~1 hour | ~30 seconds | 120x |
| 100 | 9,900 | ~4 hours | ~2 minutes | 120x |
| 500 | 249,500 | ~4 days | ~1 hour | 96x |
| 1,000 | 999,000 | ~16 days | ~4 hours | 96x |

**Key Advantages of MATRIX:**
- Single API call for N×N calculations
- Optimized routing engine utilization
- No per-request overhead
- Supports up to 2,500 locations per call

---

## Fallback: Using DIRECTIONS (If MATRIX Unavailable)

If the MATRIX function is not available, use the original DIRECTIONS-based approach:

```sql
-- Process pairs using LATERAL join with ORS DIRECTIONS
INSERT INTO FLEET_DEMOS.ROUTING.SF_TRAVEL_TIME_MATRIX (
  origin_hex, dest_hex, distance_meters, duration_seconds
)
SELECT 
  p.origin_hex,
  p.dest_hex,
  r.distance_meters,
  r.duration_seconds
FROM FLEET_DEMOS.ROUTING.SF_HEX_PAIRS p,
LATERAL (
  SELECT 
    response:features[0]:properties:summary:distance::FLOAT AS distance_meters,
    response:features[0]:properties:summary:duration::FLOAT AS duration_seconds
  FROM (
    SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
      'driving-car',
      ARRAY_CONSTRUCT(p.origin_lon, p.origin_lat),
      ARRAY_CONSTRUCT(p.dest_lon, p.dest_lat)
    ) AS response
  )
) r
WHERE p.batch_id = :BATCH_ID_PARAM;
```

---

## Querying the Matrix

### Get travel time from one hexagon to all others

```sql
SELECT 
  dest_hex,
  ROUND(duration_seconds / 60, 1) AS duration_minutes,
  ROUND(distance_meters / 1000, 2) AS distance_km
FROM FLEET_DEMOS.ROUTING.SF_TRAVEL_TIME_MATRIX
WHERE origin_hex = '89283082d6bffff'
ORDER BY duration_seconds;
```

### Find nearest hexagons by travel time

```sql
SELECT 
  dest_hex,
  ROUND(duration_seconds / 60, 1) AS duration_minutes
FROM FLEET_DEMOS.ROUTING.SF_TRAVEL_TIME_MATRIX
WHERE origin_hex = '89283082d6bffff'
  AND duration_seconds <= 600  -- Within 10 minutes
ORDER BY duration_seconds;
```

### Get travel times within k-ring neighbors

```sql
WITH neighbors AS (
  SELECT VALUE::STRING AS neighbor_hex
  FROM TABLE(FLATTEN(H3_GRID_DISK('89283082d6bffff', 10)))
)
SELECT 
  m.dest_hex,
  ROUND(m.duration_seconds / 60, 1) AS duration_minutes,
  ROUND(m.distance_meters / 1000, 2) AS distance_km,
  H3_GRID_DISTANCE('89283082d6bffff', m.dest_hex) AS ring_number
FROM FLEET_DEMOS.ROUTING.SF_TRAVEL_TIME_MATRIX m
JOIN neighbors n ON m.dest_hex = n.neighbor_hex
WHERE m.origin_hex = '89283082d6bffff'
ORDER BY ring_number, duration_seconds;
```

---

## Troubleshooting

### MATRIX Function Not Found

```sql
SHOW FUNCTIONS LIKE 'MATRIX' IN SCHEMA OPENROUTESERVICE_NATIVE_APP.CORE;
-- If empty, upgrade your ORS Native App to v0.6.0+
```

### Route Calculation Returns "Out of Bounds"

The routing graph may not cover your region. Check:
```sql
-- List available graph data
LIST @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_GRAPHS_SPCS_STAGE/;

-- Verify OSM data is for correct region
LIST @OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SPCS_STAGE/;
```

### ORS Service Not Ready

```sql
SELECT SYSTEM$GET_SERVICE_STATUS('OPENROUTESERVICE_NATIVE_APP.CORE.ORS_SERVICE');
-- Should show "READY" status
```

### Large Matrix Timeout

For very large matrices, increase batch sizes or use a larger warehouse:
```sql
ALTER WAREHOUSE MY_WH SET WAREHOUSE_SIZE = 'LARGE';
```

---

## Schema Summary

```
FLEET_DEMOS.ROUTING
├── SF_HEXAGONS              -- Source hexagons with coordinates
├── SF_TRAVEL_TIME_MATRIX    -- Final results (distance, duration)
└── (Optional) SF_BATCH_STATUS -- Processing progress tracking
```

## Available Routing Profiles

| Profile | Description | Use Case |
|---------|-------------|----------|
| `driving-car` | Standard car routing | General vehicle routing |
| `driving-hgv` | Heavy goods vehicle | Truck routing with restrictions |
| `cycling-electric` | E-bike routing | Delivery bikes, couriers |
| `cycling-road` | Road cycling | Bike-share, cycling analysis |
| `foot-walking` | Pedestrian | Walking directions |

---

## California Statewide Tiered Matrix (DoorDash Approach)

For large-scale statewide coverage, use a **tiered sparse matrix** approach with distance cutoffs at each H3 resolution. This dramatically reduces computation while maintaining accuracy.

### Tiered Architecture

| Resolution | Hexagons | Hex Size | Cutoff | k-ring | Sparse Pairs | Use Case |
|------------|----------|----------|--------|--------|--------------|----------|
| **7** | ~177K | ~5.16 km² | 50 mi | 33 | ~130M | Long range routing |
| **8** | ~575K | ~0.74 km² | 10 mi | 17 | ~235M | Delivery zone |
| **9** | ~4M | ~0.11 km² | 2 mi | 9 | ~437M | Last mile |
| **10** | ~28M | ~0.015 km² | 500m | 4 | ~521M | Ultra-last-mile |

**Total: ~1.3B sparse pairs** (vs 8+ trillion for full matrix!)

### Step 1: Create Stored Procedures for Hexagon Generation

```sql
-- Resolution 7 & 8 hexagons (runs quickly)
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_HEXAGONS_ALL()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    -- Resolution 7
    CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES7 AS
    WITH lat_series AS (
        SELECT 32.50 + (SEQ4() * 0.02) AS lat FROM TABLE(GENERATOR(ROWCOUNT => 500)) 
        WHERE 32.50 + (SEQ4() * 0.02) <= 42.19
    ),
    lon_series AS (
        SELECT -124.40 + (SEQ4() * 0.02) AS lon FROM TABLE(GENERATOR(ROWCOUNT => 600)) 
        WHERE -124.40 + (SEQ4() * 0.02) <= -114.13
    ),
    h3_cells AS (
        SELECT DISTINCT H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), 7) AS h3_index 
        FROM lat_series CROSS JOIN lon_series
    )
    SELECT h3_index, H3_CELL_TO_POINT(h3_index) AS centroid, 
           ST_X(H3_CELL_TO_POINT(h3_index)) AS lon, 
           ST_Y(H3_CELL_TO_POINT(h3_index)) AS lat 
    FROM h3_cells;

    -- Resolution 8
    CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES8 AS
    WITH lat_series AS (
        SELECT 32.50 + (SEQ4() * 0.008) AS lat FROM TABLE(GENERATOR(ROWCOUNT => 1250)) 
        WHERE 32.50 + (SEQ4() * 0.008) <= 42.19
    ),
    lon_series AS (
        SELECT -124.40 + (SEQ4() * 0.008) AS lon FROM TABLE(GENERATOR(ROWCOUNT => 1300)) 
        WHERE -124.40 + (SEQ4() * 0.008) <= -114.13
    ),
    h3_cells AS (
        SELECT DISTINCT H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), 8) AS h3_index 
        FROM lat_series CROSS JOIN lon_series
    )
    SELECT h3_index, H3_CELL_TO_POINT(h3_index) AS centroid, 
           ST_X(H3_CELL_TO_POINT(h3_index)) AS lon, 
           ST_Y(H3_CELL_TO_POINT(h3_index)) AS lat 
    FROM h3_cells;

    RETURN 'Hexagon tables created for Res7 and Res8';
END;
$$;

-- Resolution 9 hexagons (larger, separate procedure)
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_HEXAGONS_RES9()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES9 AS
    WITH lat_series AS (
        SELECT 32.50 + (SEQ4() * 0.003) AS lat FROM TABLE(GENERATOR(ROWCOUNT => 3300)) 
        WHERE 32.50 + (SEQ4() * 0.003) <= 42.19
    ),
    lon_series AS (
        SELECT -124.40 + (SEQ4() * 0.003) AS lon FROM TABLE(GENERATOR(ROWCOUNT => 3500)) 
        WHERE -124.40 + (SEQ4() * 0.003) <= -114.13
    ),
    h3_cells AS (
        SELECT DISTINCT H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), 9) AS h3_index 
        FROM lat_series CROSS JOIN lon_series
    )
    SELECT h3_index, H3_CELL_TO_POINT(h3_index) AS centroid, 
           ST_X(H3_CELL_TO_POINT(h3_index)) AS lon, 
           ST_Y(H3_CELL_TO_POINT(h3_index)) AS lat 
    FROM h3_cells;
    RETURN 'CA_H3_RES9 created';
END;
$$;

-- Resolution 10 hexagons (largest, separate procedure)
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_HEXAGONS_RES10()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES10 AS
    WITH lat_series AS (
        SELECT 32.50 + (SEQ4() * 0.001) AS lat FROM TABLE(GENERATOR(ROWCOUNT => 10000)) 
        WHERE 32.50 + (SEQ4() * 0.001) <= 42.19
    ),
    lon_series AS (
        SELECT -124.40 + (SEQ4() * 0.001) AS lon FROM TABLE(GENERATOR(ROWCOUNT => 10500)) 
        WHERE -124.40 + (SEQ4() * 0.001) <= -114.13
    ),
    h3_cells AS (
        SELECT DISTINCT H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lon, lat), 10) AS h3_index 
        FROM lat_series CROSS JOIN lon_series
    )
    SELECT h3_index, H3_CELL_TO_POINT(h3_index) AS centroid, 
           ST_X(H3_CELL_TO_POINT(h3_index)) AS lon, 
           ST_Y(H3_CELL_TO_POINT(h3_index)) AS lat 
    FROM h3_cells;
    RETURN 'CA_H3_RES10 created';
END;
$$;
```

### Step 2: Create Stored Procedures for Sparse Pair Generation

Uses `H3_GRID_DISK` to efficiently find neighbors within distance cutoff:

```sql
-- Resolution 7 pairs (50mi cutoff, k=33)
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_PAIRS_RES7()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES7_PAIRS AS
    SELECT 
        a.h3_index AS origin_h3, a.lon AS origin_lon, a.lat AS origin_lat,
        n.value::STRING AS dest_h3
    FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES7 a,
    LATERAL FLATTEN(input => H3_GRID_DISK(a.h3_index, 33)) n
    WHERE n.value::STRING IN (SELECT h3_index FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES7)
      AND a.h3_index < n.value::STRING;
    RETURN 'RES7 pairs: ' || (SELECT COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES7_PAIRS);
END;
$$;

-- Resolution 8 pairs (10mi cutoff, k=17)
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_PAIRS_RES8()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES8_PAIRS AS
    SELECT 
        a.h3_index AS origin_h3, a.lon AS origin_lon, a.lat AS origin_lat,
        n.value::STRING AS dest_h3
    FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES8 a,
    LATERAL FLATTEN(input => H3_GRID_DISK(a.h3_index, 17)) n
    WHERE n.value::STRING IN (SELECT h3_index FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES8)
      AND a.h3_index < n.value::STRING;
    RETURN 'RES8 pairs: ' || (SELECT COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES8_PAIRS);
END;
$$;

-- Resolution 9 pairs (2mi cutoff, k=9)
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_PAIRS_RES9()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES9_PAIRS AS
    SELECT 
        a.h3_index AS origin_h3, a.lon AS origin_lon, a.lat AS origin_lat,
        n.value::STRING AS dest_h3
    FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES9 a,
    LATERAL FLATTEN(input => H3_GRID_DISK(a.h3_index, 9)) n
    WHERE n.value::STRING IN (SELECT h3_index FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES9)
      AND a.h3_index < n.value::STRING;
    RETURN 'RES9 pairs: ' || (SELECT COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES9_PAIRS);
END;
$$;

-- Resolution 10 pairs (500m cutoff, k=4)
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_PAIRS_RES10()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
    CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES10_PAIRS AS
    SELECT 
        a.h3_index AS origin_h3, a.lon AS origin_lon, a.lat AS origin_lat,
        n.value::STRING AS dest_h3
    FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES10 a,
    LATERAL FLATTEN(input => H3_GRID_DISK(a.h3_index, 4)) n
    WHERE n.value::STRING IN (SELECT h3_index FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES10)
      AND a.h3_index < n.value::STRING;
    RETURN 'RES10 pairs: ' || (SELECT COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES10_PAIRS);
END;
$$;
```

### Step 3: Create Task DAG for Background Execution

Tasks run asynchronously and chain together:

```sql
-- Task 1: Build Res7/8 hexagons (root task)
CREATE OR REPLACE TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_01_BUILD_HEXAGONS_7_8
    WAREHOUSE = COMPUTE_WH
    SCHEDULE = '1440 MINUTE'
AS
    CALL OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_HEXAGONS_ALL();

-- Task 2: Build Res7 pairs (after hexagons)
CREATE OR REPLACE TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_02_BUILD_PAIRS_RES7
    WAREHOUSE = COMPUTE_WH
    AFTER OPENROUTESERVICE_SETUP.PUBLIC.TASK_01_BUILD_HEXAGONS_7_8
AS
    CALL OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_PAIRS_RES7();

-- Task 3: Build Res8 pairs (parallel with Res7 pairs)
CREATE OR REPLACE TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_03_BUILD_PAIRS_RES8
    WAREHOUSE = COMPUTE_WH
    AFTER OPENROUTESERVICE_SETUP.PUBLIC.TASK_01_BUILD_HEXAGONS_7_8
AS
    CALL OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_PAIRS_RES8();

-- Task 4: Build Res9 hexagons
CREATE OR REPLACE TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_04_BUILD_HEXAGONS_RES9
    WAREHOUSE = COMPUTE_WH
    AFTER OPENROUTESERVICE_SETUP.PUBLIC.TASK_01_BUILD_HEXAGONS_7_8
AS
    CALL OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_HEXAGONS_RES9();

-- Task 5: Build Res9 pairs
CREATE OR REPLACE TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_05_BUILD_PAIRS_RES9
    WAREHOUSE = COMPUTE_WH
    AFTER OPENROUTESERVICE_SETUP.PUBLIC.TASK_04_BUILD_HEXAGONS_RES9
AS
    CALL OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_PAIRS_RES9();

-- Task 6: Build Res10 hexagons
CREATE OR REPLACE TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_06_BUILD_HEXAGONS_RES10
    WAREHOUSE = COMPUTE_WH
    AFTER OPENROUTESERVICE_SETUP.PUBLIC.TASK_04_BUILD_HEXAGONS_RES9
AS
    CALL OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_HEXAGONS_RES10();

-- Task 7: Build Res10 pairs
CREATE OR REPLACE TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_07_BUILD_PAIRS_RES10
    WAREHOUSE = COMPUTE_WH
    AFTER OPENROUTESERVICE_SETUP.PUBLIC.TASK_06_BUILD_HEXAGONS_RES10
AS
    CALL OPENROUTESERVICE_SETUP.PUBLIC.BUILD_CA_PAIRS_RES10();
```

### Step 4: Start the Pipeline

```sql
-- Resume all child tasks first (required for DAG)
ALTER TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_07_BUILD_PAIRS_RES10 RESUME;
ALTER TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_06_BUILD_HEXAGONS_RES10 RESUME;
ALTER TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_05_BUILD_PAIRS_RES9 RESUME;
ALTER TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_04_BUILD_HEXAGONS_RES9 RESUME;
ALTER TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_03_BUILD_PAIRS_RES8 RESUME;
ALTER TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_02_BUILD_PAIRS_RES7 RESUME;
ALTER TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_01_BUILD_HEXAGONS_7_8 RESUME;

-- Execute the root task to start the pipeline
EXECUTE TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_01_BUILD_HEXAGONS_7_8;
```

### Task DAG Structure

```
TASK_01_BUILD_HEXAGONS_7_8 (root)
    ├── TASK_02_BUILD_PAIRS_RES7
    ├── TASK_03_BUILD_PAIRS_RES8
    └── TASK_04_BUILD_HEXAGONS_RES9
            ├── TASK_05_BUILD_PAIRS_RES9
            └── TASK_06_BUILD_HEXAGONS_RES10
                    └── TASK_07_BUILD_PAIRS_RES10
```

### Monitor Pipeline Progress

```sql
-- Check task execution status
SELECT 
    NAME,
    STATE,
    SCHEDULED_TIME,
    COMPLETED_TIME,
    RETURN_VALUE,
    ERROR_MESSAGE
FROM TABLE(INFORMATION_SCHEMA.TASK_HISTORY(
    SCHEDULED_TIME_RANGE_START => DATEADD('hour', -24, CURRENT_TIMESTAMP())
))
WHERE NAME LIKE 'TASK_%'
ORDER BY SCHEDULED_TIME DESC;

-- Check table row counts
SELECT 'CA_H3_RES7' AS table_name, COUNT(*) AS rows FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES7
UNION ALL SELECT 'CA_H3_RES8', COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES8
UNION ALL SELECT 'CA_H3_RES9', COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES9
UNION ALL SELECT 'CA_H3_RES10', COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES10
UNION ALL SELECT 'CA_H3_RES7_PAIRS', COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES7_PAIRS
UNION ALL SELECT 'CA_H3_RES8_PAIRS', COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES8_PAIRS
UNION ALL SELECT 'CA_H3_RES9_PAIRS', COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES9_PAIRS
UNION ALL SELECT 'CA_H3_RES10_PAIRS', COUNT(*) FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES10_PAIRS;
```

### Suspend Pipeline (Stop Auto-Runs)

```sql
-- Suspend root task to stop scheduled runs
ALTER TASK OPENROUTESERVICE_SETUP.PUBLIC.TASK_01_BUILD_HEXAGONS_7_8 SUSPEND;
```

### Estimated Build Times

| Task | Description | Est. Time |
|------|-------------|-----------|
| TASK_01 | Build Res7/8 hexagons | ~2-5 min |
| TASK_02 | Build Res7 pairs (130M) | ~10-30 min |
| TASK_03 | Build Res8 pairs (235M) | ~20-45 min |
| TASK_04 | Build Res9 hexagons | ~5-10 min |
| TASK_05 | Build Res9 pairs (437M) | ~45-90 min |
| TASK_06 | Build Res10 hexagons | ~15-30 min |
| TASK_07 | Build Res10 pairs (521M) | ~60-120 min |

**Total pipeline: ~3-6 hours** (runs in background)

---

## Streamlit Visualization: Travel Time Analysis with Isochrone Filtering

The Streamlit page `pages/3_Travel_Time_Analysis.py` provides an interactive travel time visualization using ORS isochrones to filter reachable H3 hexagons.

### How It Works

1. **ORS Isochrone** - Calls `OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(mode, lon, lat, minutes)` to compute a reachable polygon from the origin
2. **H3 Spatial Filter** - Uses `ST_CONTAINS(isochrone_polygon, hexagon_centroid)` to show only hexagons within the reachable area
3. **Travel Time Overlay** - Colors hexagons green-to-red based on pre-computed matrix travel times (with ring-distance fallback)
4. **Isochrone Boundary** - Draws the ORS polygon boundary on the map as a semi-transparent blue overlay

### ORS ISOCHRONES Function Reference

```sql
-- Returns GeoJSON polygon of area reachable within N minutes
OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(
    profile VARCHAR,    -- 'driving-car', 'cycling-regular', 'foot-walking'
    longitude FLOAT,
    latitude FLOAT,
    range_minutes NUMBER  -- Max 60 minutes
) RETURNS VARIANT (GeoJSON)
```

### Key SQL Pattern: Isochrone-Filtered Hexagons

**CRITICAL: Call ISOCHRONES once, reuse the result.** NEVER put ISOCHRONES inside a CTE that cross-joins with a large table — Snowflake may evaluate the external function per-row (1000+ calls), causing 500 errors and excessive latency.

**Correct pattern** — call ISOCHRONES as a standalone scalar query, cache the GeoJSON, then pass the geometry as a literal string:

```python
# Step 1: Call ISOCHRONES ONCE
@st.cache_data(ttl=120)
def get_isochrone_geojson(lon, lat, minutes, mode):
    result = session.sql(f"""
        SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(
            '{mode}', {lon}, {lat}, {minutes}
        )::VARCHAR AS geojson
    """).to_pandas()
    return result.iloc[0]["GEOJSON"] if not result.empty else None

# Step 2: Use cached GeoJSON geometry as literal in hex filter query
geojson_str = get_isochrone_geojson(lon, lat, minutes, mode)
geom = json.loads(geojson_str)["features"][0]["geometry"]
escaped_geom = json.dumps(geom).replace("'", "''")

df = session.sql(f"""
    SELECT h.h3_index, h.lon, h.lat
    FROM CA_H3_RES9 h
    WHERE ST_CONTAINS(TO_GEOGRAPHY('{escaped_geom}'), h.centroid)
""").to_pandas()
```

**Wrong pattern** (causes N external function calls):
```sql
-- DO NOT DO THIS — ISOCHRONES evaluated per-row in cross join
WITH isochrone_geom AS (
    SELECT TO_GEOGRAPHY(
        OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(
            'driving-car', :lon, :lat, :minutes
        ):features[0]:geometry
    ) AS iso_polygon
),
hexagons AS (
    SELECT h.* FROM CA_H3_RES9 h, isochrone_geom ig
    WHERE ST_CONTAINS(ig.iso_polygon, h.centroid)
)
SELECT * FROM hexagons;
```

### Sidebar Controls

| Control | Options | Description |
|---------|---------|-------------|
| H3 Resolution | 7, 8, 9 | Hexagon granularity |
| Travel Mode | driving-car, cycling-regular, foot-walking | ORS routing profile |
| Isochrone Range | 1-60 min | Reachable area boundary |
| Origin Hexagon | Nearest 100 to city center | Starting point |
| Show Boundary | Toggle | Isochrone polygon overlay |

### Deployment

```sql
PUT 'file://oss-deploy-a-fleet-intelligence-solution-for-food-delivery/streamlit/pages/3_Travel_Time_Analysis.py'
    @OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.STREAMLIT_STAGE/swiftbite/pages/
    AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
```

### Best Practices: Graceful Fallback for Missing Travel Time Tables

The Travel Time Analysis page gracefully handles the case where travel time tables (e.g. `CA_TRAVEL_TIME_RES9`) don't exist yet. It first checks the table exists:
```python
has_travel_table = False
try:
    session.sql(f"SELECT 1 FROM {travel_table} LIMIT 0").collect()
    has_travel_table = True
except:
    pass
```
If the table doesn't exist, it falls back to **H3 ring-distance estimation** (no LEFT JOIN), using per-resolution multipliers:
- Res 9: `ring_distance * 60 * 0.35` seconds
- Res 8: `ring_distance * 60 * 0.9` seconds
- Res 7: `ring_distance * 60 * 2.4` seconds

### Best Practices: Fully Qualified Table Names

Always use fully qualified table names in Streamlit queries (Streamlit in Snowflake runs with owner's rights and USE statements are not allowed):
```sql
-- Correct
SELECT * FROM OPENROUTESERVICE_SETUP.PUBLIC.CA_H3_RES9;

-- Wrong (will fail in SiS)
SELECT * FROM CA_H3_RES9;
```

### Best Practices: Snowpark Imports

NEVER use `from snowflake.snowpark.functions import *` in Streamlit files. This overrides Python builtins (`round`, `max`, `min`, `sum`) causing `TypeError: bad argument type for built-in operation`.

Always use:
```python
import snowflake.snowpark.functions as F
```
Then prefix calls: `F.sum(...)`, `F.avg(...)`, `F.max(...)`, etc.

### Best Practices: Snowpark to_pandas() Column Names

Snowpark `to_pandas()` uppercases ALL column names (e.g. SQL alias `total_pairs` becomes `TOTAL_PAIRS` in the DataFrame). Always normalize after conversion:
```python
df.columns = [c.lower() for c in df.columns]
```

### Best Practices: Streamlit Deployment (Modern Syntax)

Use `CREATE STREAMLIT ... FROM '@stage'` syntax (NOT legacy `ROOT_LOCATION`). Set `QUERY_WAREHOUSE` via separate `ALTER` statement:

```sql
CREATE STREAMLIT <db>.<schema>.<app_name>
  FROM '@<db>.<schema>.<stage>/<path>'
  MAIN_FILE = '<main_file>.py';

ALTER STREAMLIT <db>.<schema>.<app_name>
  SET QUERY_WAREHOUSE = '<warehouse>';
```

---

## Connecting Pre-Computed Matrix to Route Optimization (VROOM)

The pre-computed H3 travel time matrix can be fed directly into the OPTIMIZATION (VROOM) function as a custom cost matrix, eliminating real-time routing calls during optimization.

### Architecture

```
┌───────────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│  Pre-computed Matrix  │     │  Custom Matrix Input  │     │  VROOM Optimization │
│  (CA_TRAVEL_TIME_*)   │ ──► │  (durations/distances)│ ──► │  (Optimized Routes)  │
└───────────────────────┘     └──────────────────────┘     └─────────────────────┘
```

### How It Works

1. **VROOM accepts custom matrices** via the `matrices` parameter, keyed by vehicle profile
2. When custom matrices are provided, jobs/vehicles use `location_index` (integer) instead of `location` (coordinates)
3. The OPTIMIZATION function skips ORS routing calls entirely — uses your pre-computed travel times instead
4. This is **much faster** for repeated optimizations within the same area

### SQL Function Signature

```sql
-- With custom matrix (no live routing calls needed)
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(
    :jobs_array,
    :vehicles_array,
    OBJECT_CONSTRUCT(
        'driving-car', OBJECT_CONSTRUCT(
            'durations', :duration_matrix,
            'distances', :distance_matrix
        )
    )
);

-- Without matrix (VROOM calls ORS for routing - slower)
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.OPTIMIZATION(
    :jobs_array,
    :vehicles_array
);
```

### Building the Custom Matrix from H3 Travel Time Tables

```sql
-- Step 1: Identify the locations (depot + delivery addresses)
-- Each location gets an integer index (0-based) for the matrix

-- Step 2: Build NxN duration matrix from pre-computed H3 pairs
-- Map each location to its nearest H3 hexagon, then look up travel times

WITH locations AS (
    SELECT 
        ROW_NUMBER() OVER (ORDER BY location_id) - 1 AS idx,
        location_id, lon, lat,
        H3_POINT_TO_CELL_STRING(TO_GEOGRAPHY(ST_MAKEPOINT(lon, lat)), 9) AS h3_index
    FROM my_locations
),
pairs AS (
    SELECT 
        a.idx AS origin_idx, b.idx AS dest_idx,
        COALESCE(tt.travel_time_seconds, 0) AS duration,
        COALESCE(tt.travel_distance_meters, 0) AS distance
    FROM locations a
    CROSS JOIN locations b
    LEFT JOIN OPENROUTESERVICE_SETUP.PUBLIC.CA_TRAVEL_TIME_RES9 tt
        ON tt.origin_h3 = a.h3_index AND tt.dest_h3 = b.h3_index
)
-- Step 3: Pivot into NxN arrays
SELECT ARRAY_AGG(duration_row) AS duration_matrix
FROM (
    SELECT origin_idx, ARRAY_AGG(duration) WITHIN GROUP (ORDER BY dest_idx) AS duration_row
    FROM pairs
    GROUP BY origin_idx
    ORDER BY origin_idx
);
```

### Key Differences: With vs Without Custom Matrix

| Aspect | Without Matrix | With Custom Matrix |
|--------|---------------|-------------------|
| Job format | `location: [lon, lat]` | `location_index: 0` (integer) |
| Vehicle format | `start: [lon, lat]` | `start_index: 0` (integer) |
| Routing | Live ORS calls per pair | Pre-computed lookup |
| Speed | Slower (network calls) | Much faster |
| Coverage | Any coordinates | Only pre-computed pairs |

### VROOM matrices Format (from VROOM API docs)

```json
{
    "matrices": {
        "driving-car": {
            "durations": [[0, 541, 123], [541, 0, 345], [123, 345, 0]],
            "distances": [[0, 12000, 5400], [12000, 0, 8900], [5400, 8900, 0]]
        }
    }
}
```

### Gateway Changes

The `routing_service.py` gateway now forwards the `matrices` parameter to VROOM:
- `row[3]` from the SQL function is passed through as `payload['matrices']`
- Accepts both OBJECT (dict) and ARRAY (list with single dict) formats
- When matrices is empty/null, VROOM falls back to live ORS routing

### Files Modified

| File | Change |
|------|--------|
| `services/gateway/routing_service.py` | `post_optimization_tabular()` now reads `row[3]` (matrices) and passes to VROOM |
| `app/setup_script.sql` | `optimization()` function: `matrices ARRAY DEFAULT []` → `matrices OBJECT DEFAULT NULL` |
