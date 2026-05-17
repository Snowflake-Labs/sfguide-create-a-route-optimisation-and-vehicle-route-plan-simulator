# Productisation Notes - Backload Matching Engine

The deployed demo runs on a synthesized 80/120/300 dataset. To take this to production for a customer like DHL Freight, here is what changes.

## 1. Live freight-exchange offers (5-minute latency)

DHL's stated goal is real-time or 5-minute latency. The four exchanges (Timocom, WTransnet, Teleroute, B2P) all expose either REST APIs or paid CSV pulls. Pattern:

```
[Each exchange] -> Snowpipe Streaming -> EXTERNAL_OFFERS_RAW (raw json)
                -> Dynamic Table EXTERNAL_OFFERS_ENRICHED (5 min target lag)
                   - normalize source-specific fields to the contract
                   - AI_CLASSIFY for cargo category
                   - regex flags for ADR, reefer, FTL/LTL
```

Snowpipe Streaming SDK `insertRows` is the cheapest path. A small Snowpark Container Services "exchange-collector" worker per exchange (4 services) authenticates, polls, normalizes, and pushes rows.

## 2. Live trailer telemetry

Today `VW_TRAILERS` is a static view over `TRAILERS`. In production, replace the source with a Dynamic Table over a telemetry stream:

```sql
CREATE OR REPLACE DYNAMIC TABLE VW_TRAILERS
  TARGET_LAG = '2 minutes' WAREHOUSE = ROUTING_ANALYTICS
AS
SELECT VEHICLE_ID AS TRAILER_ID,
       LAST_VALUE(LON) IGNORE NULLS OVER (PARTITION BY VEHICLE_ID ORDER BY TS) AS DROPOFF_LON,
       LAST_VALUE(LAT) IGNORE NULLS OVER (PARTITION BY VEHICLE_ID ORDER BY TS) AS DROPOFF_LAT,
       ...
FROM TELEMETRY_RAW
WHERE TS > DATEADD(hour, -24, CURRENT_TIMESTAMP())
QUALIFY ROW_NUMBER() OVER (PARTITION BY VEHICLE_ID ORDER BY TS DESC) = 1;
```

## 3. Scheduled rescan task (~5-min cadence) - future enhancement

A natural next step is a Snowflake TASK that re-solves backloads on a schedule and snapshots the plan, letting dispatchers see refreshed proposals without clicking Solve. Sketch:

```sql
CREATE OR REPLACE TABLE BACKLOAD_PLAN_HISTORY (
  SCAN_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  REGION VARCHAR,
  VEHICLE NUMBER,
  STEPS VARIANT,
  DURATION NUMBER
);

CREATE OR REPLACE PROCEDURE SP_SOLVE_REGION_BACKLOAD(P_REGION VARCHAR, P_MAX_VEHICLES NUMBER)
  RETURNS TABLE(VEHICLE NUMBER, DURATION NUMBER, STEPS VARIANT, GEOJSON VARCHAR)
  LANGUAGE SQL
AS $$
  -- Build VROOM challenge from VW_TRAILERS + VW_INTERNAL_VOLUMES + VW_EXTERNAL_OFFERS
  -- Call OPENROUTESERVICE_APP.CORE.OPTIMIZATION
  -- Return the assignment rows
$$;

CREATE OR REPLACE TASK TASK_BACKLOAD_RESCAN
  WAREHOUSE = ROUTING_ANALYTICS
  SCHEDULE = '5 MINUTE'
AS
INSERT INTO BACKLOAD_PLAN_HISTORY (REGION, VEHICLE, STEPS, DURATION)
SELECT 'California', VEHICLE, STEPS, DURATION
FROM TABLE(SP_SOLVE_REGION_BACKLOAD('California', 30));

ALTER TASK TASK_BACKLOAD_RESCAN RESUME;
```

Not shipped because the React component already builds the VROOM challenge inline; a stored proc + task adds value only when the app needs background snapshots for an audit dashboard or alerting trigger. Wire it in once the customer requests scheduled refresh.

## 4. Cortex Agent natural-language wrapper

A Snowflake Intelligence agent that wraps `SP_SOLVE_REGION_BACKLOAD` plus `VW_BACKLOAD_CANDIDATES` plus the audit table. Dispatchers can ask:

- *"Show me trailers idle in NRW with no assignment yet."*
- *"What was the EUR reclaimed last week?"*
- *"Solve backloads for Germany now and explain the top assignment."*

See `assets/agents/backload-matching-agent.yaml` for the agent spec.

## 5. Solver scale beyond 30 vehicles

VROOM solves ~200 vehicles x 1000 jobs in seconds. For a 2,500-trailer fleet, partition by region or by home-depot cluster:

```sql
-- One challenge per home depot, solved in parallel
SELECT depot, ARRAY_AGG(...) FROM VW_TRAILERS GROUP BY HOME_DEPOT;
```

Each batch becomes one OPTIMIZATION call. Snowflake's task graph can fan them out and union the results.

## 6. Decision audit + chargeback

`PROPOSAL_DECISIONS` already records every assignment. Productisation adds:

- A view `VW_SAVINGS_BY_DAY` that aggregates EUR reclaimed per day x region x source.
- An alert (via SNOWFLAKE.NOTIFICATION) when daily savings fall below 50% of the rolling 7-day average - signals that the offer feeds may be stale or the priority weights need tuning.

## 7. RBAC + multi-tenancy

For DHL specifically:
- A `BACKLOAD_DISPATCHER` role with `USAGE` on the schema and `INSERT` on `PROPOSAL_DECISIONS` only.
- A `BACKLOAD_ANALYST` role with `SELECT` on the audit views, no write access.
- ORS function grants stay account-level (the existing `OPENROUTESERVICE_APP` install handles this).

## 8. Going beyond DHL Freight

The whole skill is **vendor-neutral by construction**. To onboard another carrier:
1. Replace `EXTERNAL_OFFERS.SOURCE` enum (e.g. for North America: `DAT`, `Truckstop.com`, `Convoy`, `Uber Freight`).
2. Re-run `python3 tools/gen_demo_data.py` with US/EU/APAC city tables.
3. Switch `useRegion()` to the customer's provisioned ORS region.
4. Adjust `CONFIG.HOME_LAT/LON` to the customer's home depot anchor.

The page, OPTIMIZATION call, AISQL notebook, audit view, and Cortex agent definition are unchanged.

## 9. Known issue: OPTIMIZATION + Germany region returns 0 rows

In testing (May 2026), `OPENROUTESERVICE_APP.CORE.OPTIMIZATION` returns 0 rows for any payload containing Germany-region coordinates, even though `DIRECTIONS` with the same coordinates and `'Germany'` region works perfectly. The issue is server-side in the VROOM -> ORS_SERVICE_GERMANY routing path.

USA coordinates (any profile, with or without explicit region) work correctly.

The skill ships with projection views over `SYNTHETIC_DATASETS.UNIFIED.*` filtered by the active Data Studio preset, so once the Germany OPTIMIZATION path is fixed in `build-routing-solution`, simply switch the preset to a Germany dataset - no skill code change required.

## 10. Per-preset data architecture (the v2 model)

The skill no longer ships its own seed file. Instead, Data Studio's per-preset generation pipeline writes a sixth UNIFIED table: `FACT_FREIGHT_OFFERS`. The skill's projection views (`VW_TRAILERS`, `VW_INTERNAL_VOLUMES`, `VW_EXTERNAL_OFFERS`) read from UNIFIED filtered by `CONFIG (VEHICLE_TYPE, REGION)` - same pattern as `dwell-analysis` and `fleet-intelligence-food-delivery`.

DatasetPicker preset switch -> server `CONFIG_SCHEMAS` array -> `UPDATE BACKLOAD_MATCHING.CONFIG` -> projection views auto-refresh.

Adding a new region (e.g. Berlin, Tokyo, Sydney) is purely a Data Studio operation: run a generation job for that preset and the page picks it up the next time the user selects it.
