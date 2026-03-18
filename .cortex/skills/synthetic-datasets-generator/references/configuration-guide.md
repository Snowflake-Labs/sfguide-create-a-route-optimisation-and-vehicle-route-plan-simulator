# Configuration Guide

Complete reference for all YAML configuration parameters. Two presets are provided:
- **`config.yml`** -- General-purpose, 10 trucks, 1 month
- **`calibrated_config.yml`** -- Industry-calibrated, heterogeneous truck types, tuned statistical targets

---

## Config Presets Comparison

| Aspect | `config.yml` | `calibrated_config.yml` |
|--------|-------------|------------------------|
| Trucks | 10 | 10 (scale to 500+) |
| Duration | 1 month | 2 days (test) |
| Truck types | Uniform | Regional 65% / Long-haul 25% / Low-util 10% |
| Driver profiles | 92/6/2 split | 70/25/5 split |
| Speed targets | Not specified | Fleet avg 58-72 km/h |
| Composition targets | Not specified | Moving 78-86%, warehouse dwell 5-9% |

Use `config.yml` for quick tests. Use `calibrated_config.yml` when statistical accuracy matters.

---

## Parameter Reference

### seed

```yaml
seed: 42
```

Deterministic RNG seed. Same seed + same config = identical output.

### snowflake

```yaml
snowflake:
  connection_name: null    # Uses SNOWFLAKE_CONNECTION_NAME env var if null
  database: FLEET_DEMOS
  schema: ROUTING
  warehouse: INSTALLER
```

| Parameter | Description |
|-----------|-------------|
| `connection_name` | Snowflake connection name. Set to `null` to use env var. |
| `database` | Target Snowflake database |
| `schema` | Target schema within database |
| `warehouse` | Compute warehouse for SQL operations |

### region

```yaml
region:
  name: germany
  bbox:
    min_lat: 47.27
    max_lat: 55.06
    min_lng: 5.87
    max_lng: 15.04
```

Bounding box for the simulation region. All POI queries and spatial validation use this bbox. To simulate a different region:
1. Update the bbox coordinates
2. Ensure ORS is configured for that region (via `routing-customization` skill)
3. Load POI data for the new region or accept fallback generators

### time

```yaml
time:
  start_date: "2025-12-01"
  end_date: "2025-12-31"       # Used by calibrated config
  duration_months: 1            # Used by standard config
  chunk_size_days: 7
```

| Parameter | Description |
|-----------|-------------|
| `start_date` | First day of simulation (YYYY-MM-DD) |
| `duration_months` | Number of months to generate (standard config) |
| `end_date` | Explicit end date (calibrated config) |
| `chunk_size_days` | Days per processing chunk. Lower = less memory, more I/O. |

### fleet

```yaml
fleet:
  num_trucks: 10
  weekday_operating_rate: 0.85
  weekend_operating_rate: 0.40
  trips_per_day:
    min: 1
    max: 3
```

| Parameter | Description |
|-----------|-------------|
| `num_trucks` | Total fleet size. 10 for testing, 500 for production. |
| `weekday_operating_rate` | Fraction of trucks active on weekdays |
| `weekend_operating_rate` | Fraction active on weekends (significant drop is realistic) |
| `trips_per_day.min/max` | Trips assigned per truck per operating day |

#### Calibrated truck types (calibrated_config.yml only)

```yaml
fleet:
  truck_types:
    regional:
      proportion: 0.65
      trips_per_day: {min: 2, max: 3}
      avg_trip_distance_km: 120
      speed_profile: "mixed"
      dwell_ratio: 0.12
    long_haul:
      proportion: 0.25
      trips_per_day: {min: 1, max: 1}
      avg_trip_distance_km: 450
      speed_profile: "highway"
      dwell_ratio: 0.06
    low_utilization:
      proportion: 0.10
      trips_per_day: {min: 0, max: 2}
      avg_trip_distance_km: 80
      speed_profile: "urban"
      dwell_ratio: 0.18
```

### distance_distribution

```yaml
distance_distribution:
  short_pct: 0.60
  short_max_km: 100
  medium_pct: 0.30
  medium_max_km: 300
  long_pct: 0.10
```

Controls the right-skewed distance distribution for destination selection. Destinations are binned by Haversine distance from the truck's home base.

### driver_profiles

```yaml
driver_profiles:
  COMPLIANT:
    proportion: 0.92
    detour_probability: 0.05
    speeding_probability: 0.02
    hos_violation_probability: 0.005
    speed_variance: 0.05
  MILD:
    proportion: 0.06
    detour_probability: 0.15
    speeding_probability: 0.12
    hos_violation_probability: 0.03
    speed_variance: 0.10
  OUTLIER:
    proportion: 0.02
    detour_probability: 0.30
    speeding_probability: 0.25
    hos_violation_probability: 0.08
    speed_variance: 0.18
```

| Parameter | Description |
|-----------|-------------|
| `proportion` | Fraction of fleet with this profile (must sum to 1.0) |
| `detour_probability` | Per-trip probability of taking alternative route |
| `speeding_probability` | Per-segment probability of exceeding posted speed |
| `hos_violation_probability` | Per-day probability of exceeding 9h driving |
| `speed_variance` | Speed multiplier range (+/- this fraction) |

### routing

```yaml
routing:
  optimal_route_probability: 0.70
  alternative_route_probability: 0.20
  mid_trip_deviation_probability: 0.05
  major_deviation_probability: 0.05
  ors:
    service: "OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS"
    profile: "driving-hgv"
    batch_size: 200
    cache_enabled: true
  posted_speeds:
    motorway: 80
    trunk: 80
    primary: 70
    secondary: 60
    tertiary: 50
    residential: 30
    default: 60
```

| Parameter | Description |
|-----------|-------------|
| `optimal_route_probability` | Probability of taking the shortest route |
| `ors.service` | Fully qualified ORS function name |
| `ors.profile` | ORS routing profile (driving-hgv for trucks) |
| `ors.batch_size` | Max routes per ORS batch (API limit ~20MB response) |
| `ors.cache_enabled` | Enable SQLite route caching |
| `posted_speeds.*` | Speed limits by road class (km/h) for speeding detection |

### telemetry

```yaml
telemetry:
  ping_interval:
    moving:
      target_sec: 30
      variance_sec: 10
    dwell:
      min_sec: 300
      max_sec: 600
    overnight:
      min_sec: 600
      max_sec: 1200
  gps_jitter:
    typical_m: 10
    typical_std_m: 5
    multipath_probability: 0.02
    multipath_max_m: 150
  gaps:
    probability: 0.01
    min_duration_min: 5
    max_duration_min: 30
  out_of_order_probability: 0.001
```

### dwell

```yaml
dwell:
  warehouse:
    loading:
      median_min: 45
      sigma: 0.8
      max_min: 480
    long_dwell_probability: 0.05
    long_dwell_min: 480
    long_dwell_max: 1440
  rest_stop:
    short_break:
      median_min: 15
      sigma: 0.5
      max_min: 45
    mandatory_break:
      median_min: 45
      sigma: 0.3
      max_min: 90
    overnight:
      median_min: 600
      sigma: 0.2
      max_min: 720
```

All dwell times use lognormal distributions (right-skewed, realistic).

### overnight

```yaml
overnight:
  return_home_threshold_km: 50
  return_home_time_threshold_min: 90
  workday_end_hour: 20
  next_day_start_hour: 6
```

### breaks

```yaml
breaks:
  driving_hours_between_breaks: 4.5
  mandatory_break_duration_min: 45
  max_daily_driving_hours: 9.0
  corridor_buffer_km: 30
```

| Parameter | Description |
|-----------|-------------|
| `driving_hours_between_breaks` | EU regulation: 4.5h max driving before mandatory break |
| `corridor_buffer_km` | Search radius for rest stops along route corridor |

### speeding

```yaml
speeding:
  threshold_factor: 1.08
  severe_threshold: 1.20
```

| Parameter | Description |
|-----------|-------------|
| `threshold_factor` | Speed > posted * 1.08 = speeding flag |
| `severe_threshold` | Speed > posted * 1.20 = severe speeding |

### output

```yaml
output:
  parquet_dir: "output/"
  stage_name: "@FLEET_DEMOS.ROUTING.TELEMETRY_STAGE"
  tables:
    warehouses: "DIM_WAREHOUSE"
    stops: "DIM_STOP"
    trucks: "DIM_TRUCK"
    drivers: "DIM_DRIVER"
    trips: "FACT_TRIP"
    telemetry: "FACT_TRUCK_TELEMETRY"
    violations: "FACT_VIOLATION"
```

Table names are configurable. Parquet files are written to `output/` and staged to Snowflake's internal stage for COPY INTO loading.
