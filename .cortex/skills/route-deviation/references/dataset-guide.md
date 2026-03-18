# Dataset Guide

## S3 Source

The synthetic fleet telemetry dataset is at `s3://fleet-intelligence/` and contains 500 trucks operating across Germany over a 2-week period (Dec 1-14, 2025).

## Tables

| S3 Path | Table Name | Rows | Description |
|---------|------------|------|-------------|
| `fact_truck_telemetry/` | FACT_TRUCK_TELEMETRY | ~15.1M | GPS telemetry with speed, heading, status, geometry |
| `trip_schedule/` | TRIP_SCHEDULE | 9,343 | 2-week trip schedule with OD pairs and deviation factors |
| `truck_fleet/` | TRUCK_FLEET | 500 | Fleet metadata: truck type, driver profile, home city |
| `germany_destinations/` | GERMANY_DESTINATIONS | 75,242 | Warehouses + retail stores with geometry |
| `GERMANY_REST_STOPS/` | GERMANY_REST_STOPS | 6,315 | HGV parking + official rest stops |

## GEOGRAPHY Column Handling

Each table has GEOGRAPHY columns exported differently to Parquet. The COPY INTO statements must use the correct conversion function:

| Table | Column | Export Format | Load Function |
|-------|--------|--------------|---------------|
| GERMANY_DESTINATIONS | GEOMETRY | Auto-serialized string | `TO_GEOGRAPHY($1:GEOMETRY::TEXT)` |
| TRUCK_FLEET | HOME_GEOMETRY | Auto-serialized string | `TO_GEOGRAPHY($1:HOME_GEOMETRY::TEXT)` |
| FACT_TRUCK_TELEMETRY | GEOMETRY_WKT | Explicit WKT via ST_ASWKT | `ST_GEOGRAPHYFROMWKT($1:GEOMETRY_WKT::TEXT)` |
| GERMANY_REST_STOPS | GEOMETRY, CENTER_POINT | Binary GEOGRAPHY | `TO_GEOGRAPHY($1:GEOMETRY)`, `TO_GEOGRAPHY($1:CENTER_POINT)` |
| TRIP_SCHEDULE | *(no geography)* | N/A | N/A |

## ETL Output Tables

| Table | Expected Rows | Description |
|-------|--------------|-------------|
| TRIP_ACTUAL_METRICS | ~4,600-4,700 | Per-trip aggregated telemetry: duration, path, point count |
| OD_EXPECTED_ROUTES | 9,343 | Schedule OD pairs joined with route cache distances |
| TRIP_DEVIATION_ANALYSIS | ~3,500-3,600 | Actual vs expected comparison with deviation flags |
| DRIVER_DEVIATION_SUMMARY | 500 | Per-driver deviation statistics |
| DAILY_DEVIATION_TRENDS | 14 | Daily aggregated deviation metrics |

## Expected Deviation Distribution

| Variation | Trips | Avg Dev % | Flagged % |
|-----------|-------|-----------|-----------|
| MAJOR_DEVIATION | ~146 | ~40% | 100% |
| MEDIUM_DEVIATION | ~304 | ~23% | ~76% |
| MINOR_DEVIATION | ~520 | ~10% | ~13% |
| OPTIMAL | ~2,581 | ~2.5% | ~2% |

## Daily Pattern

14 days (Dec 1-14, 2025):
- Weekdays: ~250-310 trips/day
- Weekends: ~130-150 trips/day

## Row Count Drop Explanation

TRIP_DEVIATION_ANALYSIS has ~25% fewer rows than TRIP_ACTUAL_METRICS. This is expected. Not all actual trips match a schedule entry due to HOS limits, time cutoffs, and random-destination trips.
