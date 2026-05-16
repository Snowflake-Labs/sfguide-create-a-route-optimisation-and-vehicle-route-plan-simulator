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

## 3. Scheduled rescan task (~5-min cadence)

A Snowflake TASK calls the solver every 5 minutes and snapshots the plan. Lets dispatchers see proposals refreshed automatically.

```sql
CREATE OR REPLACE TABLE BACKLOAD_PLAN_HISTORY (
  SCAN_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  REGION VARCHAR,
  VEHICLE NUMBER,
  STEPS VARIANT,
  DURATION NUMBER
);

CREATE OR REPLACE TASK TASK_BACKLOAD_RESCAN
  WAREHOUSE = ROUTING_ANALYTICS
  SCHEDULE = '5 MINUTE'
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching",...}'
AS
INSERT INTO BACKLOAD_PLAN_HISTORY (REGION, VEHICLE, STEPS, DURATION)
SELECT 'Germany', VEHICLE, STEPS, DURATION
FROM TABLE(SP_SOLVE_REGION_BACKLOAD('Germany', 30));

ALTER TASK TASK_BACKLOAD_RESCAN RESUME;
```

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
