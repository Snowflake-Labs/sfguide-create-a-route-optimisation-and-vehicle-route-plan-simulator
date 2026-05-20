# Backload Matching Engine — OPTIMIZATION VRP mapping

This document shows the exact JSON the page sends to `OPENROUTESERVICE_APP.CORE.OPTIMIZATION(...)` and how each field maps to the DHL Freight backload story.

## Vehicles (one per idle-bound trailer)

```json
{
  "id": 1,
  "profile": "driving-hgv",
  "start": [6.9603, 50.9375],
  "end":   [12.5655, 55.6759],
  "capacity": [24000],
  "skills": [1, 2],
  "time_window": [1715874000, 1715917200]
}
```

| Field | Source | Why |
|---|---|---|
| `start` | `VW_TRAILERS.DROPOFF_LON / DROPOFF_LAT` | Where the trailer becomes idle |
| `end` | `VW_TRAILERS.HOME_LON / HOME_LAT` | Forces the solver to bias jobs that point home |
| `profile` | `'driving-hgv'` | HGV graph — respects truck restrictions |
| `capacity` | `[VW_TRAILERS.MAX_PAYLOAD_KG]` | Single dimension (mass); add volume / pallets as needed |
| `skills` | `[1, 2]` if non-ADR; `[1, 2, 3]` if `HAZMAT_CERT = TRUE` | Skill `1` = internal, `2` = external, `3` = ADR-only |
| `time_window` | `[ETA_TS_unix, ETA_TS + 12h_unix]` | Trailer becomes available at ETA, expires after 12h shift |

## Jobs (internal volumes + external offers, unioned)

```json
{
  "id": 41,
  "location": [6.9512, 50.9301],
  "service": 1800,
  "amount": [12500],
  "skills": [1],
  "priority": 100,
  "time_windows": [[1715874000, 1715901000]]
}
```

| Field | Source | Why |
|---|---|---|
| `location` | `INTERNAL_VOLUMES.PICKUP_GEOM` or `EXTERNAL_OFFERS.PICKUP_GEOM` | Pickup point |
| `amount` | `WEIGHT_KG` | Must fit in vehicle capacity |
| `skills` | `[1]` for INTERNAL, `[2]` for EXTERNAL, plus `3` if ADR | Gates assignability |
| `priority` | `INTERNAL_PRIORITY=100` for INTERNAL, `EXTERNAL_PRIORITY=10` for EXTERNAL | VROOM unloads jobs in priority order under contention |
| `service` | 1800 sec (30 min) | Loading time at pickup |
| `time_windows` | `[PICKUP_FROM_TS, PICKUP_TO_TS]` (unix) | Hard window |

## The full `OPTIMIZATION(...)` call

The page builds:

```javascript
const challenge = {
  jobs:     [...internalJobs, ...externalJobs],
  vehicles: trailers.map(toVehicle),
  options:  { g: true } // return geometry for each route
};

const sql = `SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
  PARSE_JSON('${JSON.stringify(challenge)}'), '${regionName}'))`;
```

VROOM returns one row per vehicle with:

- `VEHICLE` — the vehicle id we sent.
- `STEPS` — ordered jobs assigned (start, job_1, job_2, ..., end).
- `COST` — total travel time in seconds for that vehicle.
- `GEOJSON` — the LineString for the whole route (when `options.g = true`).
- `UNASSIGNED` (top-level row) — jobs the solver could not place (capacity, time-window, skill, or `max_empty_km` exceeded).

## How DHL's "structural process" maps to VROOM parameters

| Customer parameter | VROOM lever |
|---|---|
| Internal-first | Job `priority`: 100 vs 10 |
| Direction-to-home | Vehicle `end` location set to home depot |
| ADR equipment gating | Skill id `3` on both ADR jobs and ADR-certified vehicles |
| Time-window tolerance | Widen `time_windows` on jobs by `tolerance_hrs` |
| Max empty km per leg | Pre-filter the `jobs[]` array in SQL: `WHERE empty_km <= MAX_EMPTY_KM` |
| Trailer capacity | Vehicle `capacity[0]` |
| Cargo weight | Job `amount[0]` |

## Productisation notes (out of scope for the demo)

- **Real-time refresh**: replace the polled `VW_TRAILERS` with Snowpipe Streaming on a `TELEMETRY_RAW` topic; rebuild the view as a Dynamic Table with a 5-minute target lag.
- **Live freight-exchange feeds**: the four portals (Timocom, WTransnet, Teleroute, B2P) all publish offers via either REST APIs (Timocom Smart Logistics System REST), webhook subscriptions, or paid CSV pulls. A small Snowpark Container Services worker can normalize them into `EXTERNAL_OFFERS` with the same schema.
- **Solver scale**: VROOM solves 200+ vehicles x 1000+ jobs in a few seconds. Beyond that, partition by region (NRW, Bavaria, Île-de-France) and solve in parallel — the customer's existing dispatcher mental model already partitions this way.
