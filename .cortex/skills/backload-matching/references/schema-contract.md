# Backload Matching - Schema Contract

This document is the **single source of truth** for column names, types, and the OPTIMIZATION I/O shape the React page expects. The page is built against this contract; the seed file (whether the legacy `seed-data.sql` or a future replacement) must conform to it.

If the seed and this contract disagree, the contract wins.

## Database / schema

```
DATABASE  = FLEET_INTELLIGENCE
SCHEMA    = BACKLOAD_MATCHING
WAREHOUSE = ROUTING_ANALYTICS
```

## Tables and views

### `VW_TRAILERS` (view, read by the page)

| Column | Type | Notes |
|---|---|---|
| `TRAILER_ID` | VARCHAR | Primary key, e.g. `TR-0001` |
| `OPERATING_COUNTRY` | VARCHAR | ISO-2, e.g. `DE` |
| `HOME_DEPOT` | VARCHAR | City name |
| `HOME_LON` | FLOAT | Longitude of home depot (the VROOM `vehicle.end`) |
| `HOME_LAT` | FLOAT | Latitude of home depot |
| `CURRENT_LOAD` | VARCHAR | Free-text product description |
| `DROPOFF_CITY` | VARCHAR | City where the trailer is becoming idle |
| `DROPOFF_LON` | FLOAT | Longitude of drop-off (the VROOM `vehicle.start`) |
| `DROPOFF_LAT` | FLOAT | Latitude of drop-off |
| `ETA_TS` | TIMESTAMP_NTZ | When the trailer becomes available |
| `ETA_MIN` | NUMBER | Minutes until ETA (computed) |
| `STATUS` | VARCHAR | `IN_TRANSIT` or `STAGED` |
| `HAZMAT_CERT` | BOOLEAN | True if the trailer can carry ADR cargo |
| `MAX_PAYLOAD_KG` | NUMBER | Capacity (mass) |

### `INTERNAL_VOLUMES` (table)

| Column | Type | Notes |
|---|---|---|
| `ID` | VARCHAR | Primary key, e.g. `INT-00041` |
| `PICKUP_CITY` | VARCHAR | |
| `PICKUP_LON`, `PICKUP_LAT` | FLOAT | VROOM `job.location` |
| `DROPOFF_CITY` | VARCHAR | |
| `DROPOFF_LON`, `DROPOFF_LAT` | FLOAT | |
| `PICKUP_FROM_TS` | TIMESTAMP_NTZ | Earliest pickup |
| `PICKUP_TO_TS` | TIMESTAMP_NTZ | Latest pickup |
| `WEIGHT_KG` | NUMBER | VROOM `job.amount[0]` |
| `PRODUCT` | VARCHAR | Free text |
| `HAZMAT` | BOOLEAN | If true, only trailers with `HAZMAT_CERT=TRUE` may serve |
| `POSTED_AT` | TIMESTAMP_NTZ | |

### `EXTERNAL_OFFERS` (table)

| Column | Type | Notes |
|---|---|---|
| `OFFER_ID` | VARCHAR | Primary key, e.g. `OFF-000041` |
| `SOURCE` | VARCHAR | `TIMOCOM` / `WTRANSNET` / `TELEROUTE` / `B2P` |
| `PICKUP_LON`, `PICKUP_LAT` | FLOAT | |
| `DROPOFF_LON`, `DROPOFF_LAT` | FLOAT | |
| `PICKUP_COUNTRY`, `DROPOFF_COUNTRY` | VARCHAR | ISO-2 |
| `PICKUP_CITY`, `DROPOFF_CITY` | VARCHAR | |
| `PICKUP_FROM_TS`, `PICKUP_TO_TS` | TIMESTAMP_NTZ | |
| `WEIGHT_KG` | NUMBER | |
| `PRODUCT` | VARCHAR | |
| `PRICE_EUR` | NUMBER | Posted offer price |
| `HAZMAT` | BOOLEAN | |
| `POSTED_AT` | TIMESTAMP_NTZ | |
| `LISTING_TEXT` | VARCHAR | Free-text, used by AISQL extract demos |

### `PROPOSAL_DECISIONS` (table - written by the page)

| Column | Type | Notes |
|---|---|---|
| `DECISION_ID` | VARCHAR | UUID default |
| `TRAILER_ID` | VARCHAR | FK to VW_TRAILERS |
| `OFFER_ID` | VARCHAR | FK to INTERNAL_VOLUMES.ID or EXTERNAL_OFFERS.OFFER_ID |
| `SOURCE` | VARCHAR | `INTERNAL` or one of the four exchange brand names |
| `SCORE` | FLOAT | Solver cost of this assignment |
| `EMPTY_KM` | FLOAT | Drop-off -> pickup empty distance (km) |
| `DECIDED_BY` | VARCHAR | Username (page sends `'demo-user'`) |
| `DECIDED_AT` | TIMESTAMP_NTZ | Default `CURRENT_TIMESTAMP()` |
| `RATIONALE` | VARCHAR | Cortex-generated 2-sentence text |

The page lazily creates this table on first `Confirm Plan` click using `CREATE TABLE IF NOT EXISTS`, so no upfront DDL is required.

## OPTIMIZATION JSON shape (request)

The page builds a single JSON object and sends it to `OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(...))`.

```json
{
  "vehicles": [
    {
      "id": 1,
      "profile": "driving-hgv",
      "start": [6.9603, 50.9375],
      "end":   [12.5655, 55.6759],
      "capacity": [24000],
      "skills": [1, 2],
      "time_window": [1715874000, 1715917200]
    }
  ],
  "jobs": [
    {
      "id": 41,
      "location": [6.9512, 50.9301],
      "service": 1800,
      "amount": [12500],
      "skills": [1],
      "priority": 100,
      "time_windows": [[1715874000, 1715901000]]
    }
  ],
  "options": { "g": true }
}
```

| Field | Source column | Mapping rule |
|---|---|---|
| `vehicles[].start` | `[VW_TRAILERS.DROPOFF_LON, VW_TRAILERS.DROPOFF_LAT]` | Where the trailer becomes idle |
| `vehicles[].end` | `[VW_TRAILERS.HOME_LON, VW_TRAILERS.HOME_LAT]` | Forces direction-to-home bias |
| `vehicles[].capacity` | `[VW_TRAILERS.MAX_PAYLOAD_KG]` | Single dimension (mass) |
| `vehicles[].skills` | `[1,2]` if `HAZMAT_CERT=FALSE`; `[1,2,3]` if TRUE | `1`=internal, `2`=external, `3`=ADR |
| `vehicles[].time_window` | `[unix(ETA_TS), unix(ETA_TS) + 12h]` | 12-hour shift slack |
| `jobs[].location` | `[PICKUP_LON, PICKUP_LAT]` | |
| `jobs[].amount` | `[WEIGHT_KG]` | |
| `jobs[].skills` | `[1]` for internal, `[2]` for external; +`[3]` if `HAZMAT=TRUE` | |
| `jobs[].priority` | `INTERNAL_PRIORITY=100` for internal, `EXTERNAL_PRIORITY=10` for external | |
| `jobs[].service` | constant `1800` (30 min loading) | |
| `jobs[].time_windows` | `[[unix(PICKUP_FROM_TS), unix(PICKUP_TO_TS)]]` | |

## OPTIMIZATION row shape (response)

| Column | Type | Notes |
|---|---|---|
| `VEHICLE` | NUMBER | The id we sent |
| `STEPS` | VARIANT | Array of step objects: `{type, job, location, arrival, ...}` |
| `COST` | NUMBER | Total travel time (seconds) for this vehicle |
| `GEOJSON` | VARCHAR | LineString of the whole route (when `options.g=true`) |
| `UNASSIGNED` | VARIANT | Top-level row(s) of jobs the solver could not place |

## Region constants (Germany)

The deployed ORS app has a Germany region provisioned. All trailer drop-offs and offer pickup/dropoff coordinates must lie inside the bbox `[5.86E..15.05E] x [47.27N..55.15N]`. Outside this bbox, `driving-hgv` directions/optimization will fail.

## Mock data shapes (used by the React component when `USE_MOCK = true`)

The component ships with three inline arrays that match the column names above:

```ts
const MOCK_TRAILERS: Trailer[] = [
  { TRAILER_ID:'TR-0001', OPERATING_COUNTRY:'DE', HOME_DEPOT:'Copenhagen',
    HOME_LON:12.5655, HOME_LAT:55.6759, CURRENT_LOAD:'Furniture parts',
    DROPOFF_CITY:'Cologne', DROPOFF_LON:6.9603, DROPOFF_LAT:50.9375,
    ETA_TS:'2026-05-16 18:00:00', ETA_MIN:120, STATUS:'IN_TRANSIT',
    HAZMAT_CERT:false, MAX_PAYLOAD_KG:24000 },
  ...
];
```
