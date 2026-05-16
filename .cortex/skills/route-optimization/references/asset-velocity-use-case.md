# Asset Velocity - Non-Moving Trailer Detection & Action Engine

A reusable Snowflake-native pattern for asset-heavy logistics operators. Turns the "ghost trailer" problem (owned assets idle so long they get forgotten while the network rents external capacity) into a real-time action engine driven entirely by SQL views, Cortex AI, and the bundled VROOM optimizer.

## Business problem

A measurable share of every owned/leased trailer fleet is idle for extended periods (>7 days is the canonical industry threshold). Status quo:

- **Descriptive, not prescriptive.** Reports tell dispatchers *how many* trailers are standing - not *what to do* about each one.
- **Manual review fatigue.** Dispatchers dig through reports; by the time a ghost trailer is identified, it has often been idle 10+ days.
- **Siloed execution.** No automated link between "idle status" in telematics and "action trigger" in the dispatcher's workflow.

Locked capacity costs more than missing capacity, because the response is to rent external trailers or reposition reactively at empty-mile expense.

## Target state

An AI-driven engine that:

1. Continuously monitors trailer movement.
2. Filters valid exceptions (maintenance / damage / out-of-service).
3. Pushes Action Alerts to the responsible dispatcher the moment a trailer crosses the idle threshold.
4. Recommends the next best move using current network imbalance ("Reposition trailer T-0042 to terminal X for high-demand lane Y").
5. Tracks the cost of idleness per trailer, prioritising the most expensive delays first.

## Why this generalises beyond trucking

The same view-stack drops into other asset-heavy verticals with no schema changes - just swap the source telemetry:

| Operator archetype | Idle asset | High-demand signal |
|---|---|---|
| Long-haul road freight carriers | Dry-van trailers | Lane imbalance from FACT_TRIPS |
| Container shipping lines | Empty containers / chassis | Port turn-times |
| Truck leasing operators | Leased tractors | Customer demand POIs |
| Foodservice / cold-chain 3PLs | Reefer trailers | Spoilage-risk SLAs |
| Rail intermodal operators | Rail cars at sidings | Origin loadings |

## Architecture

```
SYNTHETIC_DATASETS.UNIFIED.FACT_VEHICLE_TELEMETRY   (or any GPS source)
            |
            v
FLEET_INTELLIGENCE.DWELL_ANALYSIS.DT_DWELL_ENRICHED  (existing dwell pipeline)
            |
            v
ROUTE_OPTIMIZATION.VW_IDLE_TRAILERS         <-- ghost trailer list (HGV, OPERATING_MODE='trucking', exception filter)
ROUTE_OPTIMIZATION.VW_LANE_DEMAND           <-- net outbound trips per terminal, last 30d
ROUTE_OPTIMIZATION.VW_TRAILER_COST_OF_IDLENESS  <-- adds $/day, severity bucket, projected savings
            |
            v
React page "Asset Velocity"
   |-- KPI cards (Ghost Trailers, Cost of Idleness, Avg Idle Days, Projected Savings)
   |-- deck.gl map (idle trailers + demand terminals + reposition routes)
   |-- Action Alerts table sorted by cost
   |-- "AI Rationale" -> SNOWFLAKE.CORTEX.COMPLETE generates a one-line dispatcher alert
   |-- "Optimize Repositioning" -> VROOM solve via OPENROUTESERVICE_APP.CORE.OPTIMIZATION
```

## Risk mitigations baked into the views

| Risk | Mitigation |
|------|-----------|
| Alert fatigue | Configurable `IDLE_HOURS` threshold. Severity bucketing (`OK` / `WATCH` / `WARNING` / `CRITICAL`) plus cost-based ranking ensure the top items are also the most expensive. |
| Action ownership | `ASSIGNED_DISPATCHER` is computed deterministically per trailer (hash bucket, 12 dispatchers). Real deployments swap in a true responsibility-map join. |
| Exception handling | `VW_IDLE_TRAILERS` excludes any session with `STATUS LIKE '%MAINTENANCE%'` and any trailer with `DRIVER_PROFILE = 'OUTLIER'` (synthetic proxy for damaged/out-of-service). |

## Customer-tunable parameters

All stored in `FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG`:

| Column | Default | Meaning |
|--------|---------|---------|
| `DAILY_RENTAL_RATE_AVOIDED_USD` | `80.00` | Daily $ saved per trailer hour returned to the network (industry-typical short-term dry-van rental). |
| `RENTAL_CAPTURE_RATE` | `0.600` | Fraction of theoretical idle-cost the operator believes they can actually capture (60%). Drives the "Projected Savings" KPI. |

## Demo note - synthetic data

The bundled `SYNTHETIC_DATASETS` only spans 7 days, so a literal "168h idle" filter returns zero rows. The page exposes a hours-based slider (default 1h) for visible results during demos. In production, set the threshold to 168h to match the operator's published policy.
