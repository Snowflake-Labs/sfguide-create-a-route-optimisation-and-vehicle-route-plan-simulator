# Matrix Cost Estimator

The `ESTIMATE_MATRIX_COST` procedure provides pre-flight predictions for matrix builds (Issue #39).

## Procedure signature

```sql
CALL OPENROUTESERVICE_APP.CORE.ESTIMATE_MATRIX_COST(
    P_REGION       VARCHAR,
    P_RESOLUTION   NUMBER,         -- 5..10
    P_PROFILE      VARCHAR,         -- driving-car | driving-hgv | cycling-regular | foot-walking
    P_MIN_LAT      FLOAT,
    P_MAX_LAT      FLOAT,
    P_MIN_LON      FLOAT,
    P_MAX_LON      FLOAT,
    P_ROAD_FILTER  BOOLEAN DEFAULT NULL  -- NULL => return both ON and OFF variants
);
```

Returns a `VARIANT` JSON document with:

```json
{
  "region": "...",
  "profile": "driving-car",
  "h3_resolution": 8,
  "bucket": "small|medium|large|xlarge",
  "area_km2": 136.85,
  "generated_at": "...",
  "selected_road_filter": null,
  "estimates": {
    "road_filter_off": {
      "cells": 186,
      "matrix_rows": 34410,
      "warehouse_credits": 0.50,
      "spcs_credits": 0.003,
      "total_credits": 0.503,
      "duration_seconds": 61,
      "confidence": "low",
      "sample_size": 0
    },
    "road_filter_on":  { ... }
  }
}
```

Both `road_filter_off` and `road_filter_on` are always returned so the UI can show
side-by-side comparisons (per the Issue #39 triage note that #35's road-aware
filter must be treated as a first-class estimator input).

## Backing calibration table

`OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION` stores coefficients
keyed on `(H3_RESOLUTION, PROFILE, ROAD_FILTER, REGION_SIZE_BUCKET)`:

| Column | Default seed | Refit from history? |
|---|---|---|
| `AVG_CELLS_PER_KM2` | inverse of H3 average cell area | no (geometric constant) |
| `ROAD_FILTER_RATIO` | 0.45 (driving) / 0.55 (cycling) / 0.65 (walking) | yes |
| `WH_BASE_CREDITS` | 0.5 | future (currently constant) |
| `WH_PER_CELL_CREDITS` | 0.0 | future |
| `WH_PER_PAIR_CREDITS` | 0.0 | future |
| `SPCS_PAIRS_PER_SEC` | 30000 (driving-car) | yes |
| `SPCS_CREDIT_RATE_PER_SEC` | 0.00278 (10 nodes * 1 cr/h) | static |
| `WALL_SEC_OVERHEAD` | 60s | yes |
| `SAMPLE_SIZE` | 0 | yes — fed by historical jobs |

Confidence label: `high` if `SAMPLE_SIZE >= 10`, `medium` 3-9, `low` otherwise.

## Refresh cadence

`REFRESH_MATRIX_COST_CALIBRATION_TASK` runs daily at 06:00 UTC. To trigger
manually:

```sql
CALL OPENROUTESERVICE_APP.CORE.REFRESH_MATRIX_COST_CALIBRATION();
```

The procedure scans `MATRIX_BUILD_JOBS` rows with `STATUS IN ('COMPLETE','SUCCESS')` from the
last 90 days, infers per-bucket pairs/sec and overhead, and `MERGE`s into the
calibration table. Each refresh appends a row to
`MATRIX_COST_CALIBRATION_HISTORY` for audit.

## Bucketing

Region size bucket is derived from bounding-box area (km^2):

- `small`  : `< 500`
- `medium` : `< 5000`
- `large`  : `< 50000`
- `xlarge` : otherwise

When no exact `(res, profile, road_filter, bucket)` calibration row exists,
the estimator falls back to the `medium` bucket (always seeded) and finally
to hardcoded defaults if even that is missing.

## UI gating thresholds (`MatrixBuilder.tsx`)

| Band | Total credits | Behaviour |
|---|---|---|
| green | `<= 5` | Build button enabled |
| yellow | `5 < x <= 25` | Build button enabled |
| red | `> 25` | Requires explicit acknowledgement |

Pair-count cap: `100M` (also forces acknowledgement when exceeded).

## Validation methodology

To confirm the +/- 10% rows / +/- 25% credits acceptance criteria:

1. Pick 3 prior `MATRIX_BUILD_JOBS` rows with `STATUS='SUCCESS'` covering at
   least 2 different bucket sizes.
2. Recover the bbox from `REGION_ORS_MAP` and the resolution from the job row.
3. Call `ESTIMATE_MATRIX_COST(...)` with the same inputs.
4. Compare predicted `cells` and `matrix_rows` against `HEXAGONS` and
   `MATRIX_ROWS` from the job.
5. Compare predicted `duration_seconds` against the job's
   `DATEDIFF(SECOND, STARTED_AT, COMPLETED_AT)`.
6. Compare predicted `total_credits` against `QUERY_HISTORY` credit attribution
   (filter `query_tag` containing `oss-build-routing-solution`/`build-routing-solution`).

Document residuals in `logs/` per `AGENTS.md`.

## Cleanup

```sql
ALTER TASK OPENROUTESERVICE_APP.CORE.REFRESH_MATRIX_COST_CALIBRATION_TASK SUSPEND;
DROP TASK IF EXISTS OPENROUTESERVICE_APP.CORE.REFRESH_MATRIX_COST_CALIBRATION_TASK;
DROP PROCEDURE IF EXISTS OPENROUTESERVICE_APP.CORE.REFRESH_MATRIX_COST_CALIBRATION();
DROP PROCEDURE IF EXISTS OPENROUTESERVICE_APP.CORE.ESTIMATE_MATRIX_COST(VARCHAR, NUMBER, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT, BOOLEAN);
DROP TABLE IF EXISTS OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION_HISTORY;
DROP TABLE IF EXISTS OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_COST_CALIBRATION;
```
