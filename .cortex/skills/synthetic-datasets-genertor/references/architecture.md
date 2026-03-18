# Architecture Reference

Detailed data model, table schemas, and system design for the Synthetic Fleet Telemetry Generator.

---

## Data Flow

```
1. POI Loading (Overture Maps or fallback)
   ├── GERMANY_WAREHOUSES  → origins/home bases
   ├── GERMANY_DESTINATIONS → trip destinations
   └── GERMANY_REST_STOPS  → mandatory break locations
            │
            ▼
2. Fleet & Driver Assignment
   ├── Assign driver profiles (COMPLIANT/MILD/OUTLIER)
   ├── Assign home warehouses
   └── Determine truck types and base speeds
            │
            ▼
3. Trip Generation (per day, per truck)
   ├── Distance-weighted destination selection
   ├── Route variation decision (OPTIMAL/ALTERNATIVE/DETOUR)
   └── ORS route computation with SQLite caching
            │
            ▼
4. Telemetry Emission (along route geometry)
   ├── GPS interpolation at 20-90s intervals
   ├── Speed calculation with profile-based variance
   ├── Dwell simulation at warehouses/rest stops
   ├── Rest stop insertion after 4.5h driving (EU HOS)
   ├── GPS jitter and telemetry gap injection
   └── Anomaly flags (speeding, HOS violation, detour)
            │
            ▼
5. Snowflake Loading
   ├── Parquet staging → COPY INTO (telemetry)
   ├── write_pandas (dimensions, trips, violations)
   └── Clustering key application
```

---

## Star Schema

### Dimension Tables

#### DIM_WAREHOUSE

```sql
CREATE TABLE IF NOT EXISTS {schema}.DIM_WAREHOUSE (
    WAREHOUSE_ID VARCHAR(100) PRIMARY KEY,
    NAME VARCHAR(500),
    CATEGORY VARCHAR(100),
    LOCATION_TYPE VARCHAR(50),
    LONGITUDE FLOAT,
    LATITUDE FLOAT,
    GEOG GEOGRAPHY,
    CITY VARCHAR(200),
    ADDRESS VARCHAR(500),
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

#### DIM_STOP

```sql
CREATE TABLE IF NOT EXISTS {schema}.DIM_STOP (
    REST_STOP_ID VARCHAR(100) PRIMARY KEY,
    NAME VARCHAR(500),
    REST_TYPE VARCHAR(50),
    LONGITUDE FLOAT,
    LATITUDE FLOAT,
    GEOG GEOGRAPHY,
    HAS_EV_CHARGING BOOLEAN,
    AREA_M2 FLOAT,
    CAPACITY_RATING VARCHAR(50),
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

#### DIM_TRUCK

```sql
CREATE TABLE IF NOT EXISTS {schema}.DIM_TRUCK (
    TRUCK_ID VARCHAR(50) PRIMARY KEY,
    DRIVER_ID VARCHAR(50),
    HOME_BASE_ID VARCHAR(100),
    HOME_LNG FLOAT,
    HOME_LAT FLOAT,
    TRUCK_TYPE VARCHAR(50),
    DRIVER_PROFILE VARCHAR(50),
    BASE_SPEED_KMH FLOAT,
    SHIFT_TYPE VARCHAR(50),
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

#### DIM_DRIVER

```sql
CREATE TABLE IF NOT EXISTS {schema}.DIM_DRIVER (
    DRIVER_ID VARCHAR(50) PRIMARY KEY,
    TRUCK_ID VARCHAR(50),
    PROFILE_TYPE VARCHAR(50),
    DETOUR_PROBABILITY FLOAT,
    SPEEDING_PROBABILITY FLOAT,
    HOS_VIOLATION_PROBABILITY FLOAT,
    SPEED_VARIANCE FLOAT,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

### Fact Tables

#### FACT_TRUCK_TELEMETRY

```sql
CREATE TABLE IF NOT EXISTS {schema}.FACT_TRUCK_TELEMETRY (
    TELEMETRY_ID VARCHAR(36) PRIMARY KEY,
    TRUCK_ID VARCHAR(50),
    DRIVER_ID VARCHAR(50),
    TRIP_ID VARCHAR(100),
    TS TIMESTAMP_NTZ,
    LATITUDE FLOAT,
    LONGITUDE FLOAT,
    GEOG GEOGRAPHY,
    SPEED_KMH FLOAT,
    HEADING_DEG FLOAT,
    POSTED_SPEED_KMH FLOAT,
    STATUS VARCHAR(50),
    IS_SPEEDING BOOLEAN,
    IS_HOS_VIOLATION BOOLEAN,
    IS_DETOUR BOOLEAN,
    GPS_ACCURACY_M FLOAT,
    LOCATION_ID VARCHAR(100),
    LOCATION_TYPE VARCHAR(50),
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

Clustering: `CLUSTER BY (TO_DATE(TS), TRUCK_ID)`

#### FACT_TRIP

```sql
CREATE TABLE IF NOT EXISTS {schema}.FACT_TRIP (
    TRIP_ID VARCHAR(100) PRIMARY KEY,
    TRUCK_ID VARCHAR(50),
    DRIVER_ID VARCHAR(50),
    ORIGIN_ID VARCHAR(100),
    DEST_ID VARCHAR(100),
    ORIGIN_LNG FLOAT,
    ORIGIN_LAT FLOAT,
    DEST_LNG FLOAT,
    DEST_LAT FLOAT,
    SCHEDULED_START TIMESTAMP_NTZ,
    TRIP_TYPE VARCHAR(50),
    ROUTE_VARIATION VARCHAR(50),
    DISTANCE_KM FLOAT,
    DURATION_MIN FLOAT,
    IS_DETOUR BOOLEAN,
    ROUTE_GEOG GEOGRAPHY,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

Clustering: `CLUSTER BY (TO_DATE(SCHEDULED_START), TRUCK_ID)`

#### FACT_VIOLATION

```sql
CREATE TABLE IF NOT EXISTS {schema}.FACT_VIOLATION (
    VIOLATION_ID VARCHAR(36) PRIMARY KEY,
    TRUCK_ID VARCHAR(50),
    TRIP_ID VARCHAR(100),
    VIOLATION_TYPE VARCHAR(50),
    START_TIME TIMESTAMP_NTZ,
    END_TIME TIMESTAMP_NTZ,
    DURATION_MINUTES FLOAT,
    MAX_SPEED_KMH FLOAT,
    POSTED_SPEED_KMH FLOAT,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);
```

Clustering: `CLUSTER BY (TO_DATE(START_TIME), VIOLATION_TYPE)`

---

## Driver Behavior Model

### Profile Distribution

| Profile | Proportion | Speeding Prob | HOS Violation Prob | Detour Prob | Speed Variance |
|---------|-----------|---------------|-------------------|-------------|----------------|
| COMPLIANT | 92% | 2% | 0.5% | 5% | +/- 5% |
| MILD | 6% | 12% | 3% | 15% | +/- 10% |
| OUTLIER | 2% | 25% | 8% | 30% | +/- 18% |

Anomalies are **event-level** decisions, not always-on flags. A COMPLIANT driver can occasionally speed; an OUTLIER driver does not always speed.

### EU HOS Compliance

- Max daily driving: 9 hours (10h extended)
- Mandatory break: 45 minutes after 4.5 hours of driving
- Break resets the driving counter
- Violations tracked per truck-day

---

## Telemetry Emission Model

### Ping Intervals

| State | Interval | Notes |
|-------|----------|-------|
| Moving | 20-90 sec (target 30s) | Variable for realism |
| Dwell (warehouse/stop) | 5-10 min | Lower frequency when stopped |
| Overnight | 10-20 min | Minimal pings during rest |

### GPS Jitter

| Type | Accuracy | Probability |
|------|----------|-------------|
| Typical | 3-15m | 98% |
| Multipath spike | 50-200m | 2% |

### Telemetry Gaps

- Probability: 1% of segments
- Duration: 5-30 minutes
- Simulates signal loss in tunnels, rural areas

### Dwell Time Distributions (Lognormal)

| Location | Median | Max | Distribution |
|----------|--------|-----|-------------|
| Warehouse loading | 45 min | 8h | Lognormal(sigma=0.8) |
| Long warehouse dwell | 8-24h | 24h | 5% probability |
| Short rest break | 15 min | 45 min | Lognormal(sigma=0.5) |
| Mandatory break | 45 min | 90 min | Lognormal(sigma=0.3) |
| Overnight rest | 10h | 12h | Lognormal(sigma=0.2) |

---

## Route Generation

### Distance-Weighted Destination Selection

| Bin | Distance | Probability |
|-----|----------|-------------|
| Short | < 100 km | 60% |
| Medium | 100-300 km | 30% |
| Long-haul | > 300 km | 10% |

### Route Variations

| Type | Probability | ORS Route Index |
|------|-------------|-----------------|
| OPTIMAL | 70% | 0 |
| ALTERNATIVE | 20% | 1 |
| DETOUR | 5-10% | 1-2 (profile-dependent) |

### ORS Integration

- Service: `OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS`
- Profile: `driving-hgv`
- Batch limit: 200 routes max per ORS call
- Results cached in local SQLite database (`cache/routes.db`)
- Route coordinates interpolated at configured time intervals
