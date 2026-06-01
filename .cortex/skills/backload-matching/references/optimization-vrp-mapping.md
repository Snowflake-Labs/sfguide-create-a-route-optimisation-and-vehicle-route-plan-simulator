# Backload Matching Engine — OPTIMIZATION VRP mapping

This document shows the exact JSON the page sends to `OPENROUTESERVICE_APP.CORE.OPTIMIZATION(...)` and how each visible UI lever maps 1:1 to a real VROOM or ORS field. The new design has **no JS pre-filters or post-filters** — every knob you turn lands inside the solver.

## Vehicles (one per idle-bound trailer)

```json
{
  "id": 1,
  "profile": "driving-hgv",
  "start": [6.9603, 50.9375],
  "end":   [12.5655, 55.6759],            // omit when "Open-ended"
  "capacity": [24000, 33, 90],            // [kg, pallets, m³] when multi-dim
  "skills": [1, 2],
  "max_tasks": 2,                         // Max stops per trailer
  "max_travel_time": 28800,               // ideal_empty_hrs + slack
  "max_distance": 600000,                 // ideal_empty_km × (1 + dev%)
  "costs": { "fixed": 12000, "per_km": 160 },
  "time_window": [1715874000, 1715906400],         // optional shift
  "breaks": [{ "id": 1, "service": 2700,
               "time_windows": [[1715890200, 1715895600]] }],
  "profile_options": { "avoid_polygons": { "type": "MultiPolygon", ... } }
}
```

| Field | UI lever | Why |
|---|---|---|
| `start` | `VW_TRAILERS.DROPOFF_LON / DROPOFF_LAT` | Where the trailer becomes idle |
| `end` | radio: Home / Shared / Open | When `Open`, omit the field — solver lets the trailer finish anywhere |
| `profile` | derived from region | ORS routing graph |
| `capacity` | toggle: multi-dim capacity | `[kg]` or `[kg, pallets, m³]` |
| `skills` | HAZMAT cert flag | `[1,2,3]` if certified, `[1,2]` otherwise |
| `max_tasks` | **Max stops per trailer** | 1 = single backload, 2-6 = consolidation |
| `max_travel_time` | **Detour budget** (+h on top of ideal empty trip) | Hard time cap on the whole tour |
| `max_distance` | **Allowed deviation** (+% from ideal empty trip) | Hard distance cap on the whole tour |
| `costs.fixed` | **Fixed dispatch cost** (€) × 100 | Pay-to-add-vehicle penalty |
| `costs.per_km` | (**€/km** + **€/h** ÷ 60 km/h) × 100 | Time + distance weighted into VROOM's per-km cost. Note: the deployed regional VROOM image is `vroom-docker:v1.0.4`, which does NOT yet support `costs.per_hour` (added upstream in VROOM v1.13). When the gateway upgrades to v1.13+, switch back to `per_hour` for cleaner semantics. |
| `time_window` | toggle: shift / hours-of-service | `[shiftStart, shiftEnd]` |
| `breaks` | toggle: enforce driver break | EU 45-min rest after 4.5 h |
| `profile_options.avoid_polygons` | multi-select: avoid zones | Forwarded to ORS routing for LEZ / construction / hazard avoidance |

## Shipments (internal volumes + external offers)

```json
{
  "pickup":   { "id": 41, "location": [...], "service": 1800,
                "time_windows": [[t1_from, t1_to], [t2_from, t2_to]] },
  "delivery": { "id": 41, "location": [...], "service": 600 },
  "amount":   [12500, 17, 50],
  "skills":   [1],
  "priority": 90
}
```

| Field | UI lever | Why |
|---|---|---|
| `pickup.location` / `delivery.location` | source data | Pickup / dropoff |
| `service` | hard-coded (1800 / 600 sec) | Loading / unloading time |
| `amount` | toggle: multi-dim | `[kg]` or `[kg, pallets, m³]` |
| `skills` | HAZMAT flag on shipment | `[1]` internal, `[2]` external, `+3` if ADR |
| `priority` | **Internal-first weight** (single slider) | Internal = `W`, External = `100 - W` |
| `time_windows` | **Window slack** (±h) and toggle: multi-window | Widened ±slack; second window synthesised at +8 h when toggled |

## Top-level options
- `options.g = true` — return GeoJSON geometry per route. Always on.

## Post-solve economics (computed in the React layer, not VROOM)

| Display column | Formula |
|---|---|
| Tour km | `r.DISTANCE / 1000` (or fallback from duration × speed) |
| Tour hrs | `r.DURATION / 3600` |
| Cost (€) | `dispatch + tourHrs × €/h + tourKm × €/km + nDeliveries × €/delivery` |
| Revenue (€) | external: `PRICE_EUR`. Internal: `loaded_km × €/loaded-km` |
| Net benefit (€) | `Revenue − Cost` (red badge when negative) |
| Wait time | per-step `waiting_time` from VROOM (chip when > 30 min) |

## What got removed from the old UI

| Old control | Why it's gone |
|---|---|
| `Max empty km/leg` | Was a JS post-filter that silently dropped solver decisions. Empty km is now minimised directly by `costs.per_hour` + `max_travel_time`. |
| `Max detour km` | Was a JS pre-filter that hid candidates from VROOM. Redundant with `max_distance` (deviation %). |
| Two priority sliders (internal + external) | Collapsed into one **Internal-first weight** slider. |
| Match mode radio (`single` / `consolidate`) | Replaced by **Max stops** number (1 = single, ≥2 = consolidation). |
| `Force shared destination` checkbox | Replaced by the 3-way **Trailer end** radio (Home / Shared / Open). |

## Productisation notes (out of scope for the demo)

- **Real-time refresh**: replace the polled `VW_TRAILERS` with Snowpipe Streaming on a `TELEMETRY_RAW` topic; rebuild the view as a Dynamic Table with a 5-minute target lag.
- **Live freight-exchange feeds**: the four EU portals (Timocom, WTransnet, Teleroute, B2P) all publish offers via REST APIs or webhook subscriptions. A small Snowpark Container Services worker can normalize them into `EXTERNAL_OFFERS` with the same schema.
- **Solver scale**: VROOM solves 200+ vehicles × 1000+ jobs in a few seconds. Beyond that, partition by region (NRW, Bavaria, Île-de-France) and solve in parallel.
- **Pre-computed matrices**: for repeated what-if solves on the same point set, call `OPENROUTESERVICE_APP.CORE._OPTIMIZATION_TABULAR_RAW(jobs, vehicles, matrices, region)` with a cached matrix. (Cache table not seeded in v1.1.35; follow-up work.)
- **Pinned stops** (`vehicle.steps[]`): dispatcher overrides where a specific stop is locked to a specific trailer. (UI hook not shipped in v1.1.35; follow-up work.)
- **Mixed jobs + shipments**: VROOM accepts both `jobs[]` (single-location) and `shipments[]` (paired). Useful for return / empty-container relocation tasks. (Follow-up.)

## Sanity probe: "OPTIMIZATION returned 0 rows"

If the UI surfaces "OPTIMIZATION returned 0 rows", first verify VROOM itself is
healthy for the region with this minimal probe (replace `$REGION` and the four
coordinates with values that lie inside the region's boundary). One returned
row means VROOM works — the issue is then in the payload your code is
generating (almost always `max_travel_time` or `max_distance` too tight, or an
unknown VROOM v1.0.4 field; see compatibility table above).

```sql
SET REGION = 'Germany';
SELECT VEHICLE FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
  PARSE_JSON('{
    "vehicles":[{"id":1,"profile":"driving-hgv",
      "start":[13.4050,52.5200],"end":[11.5820,48.1351],
      "capacity":[24000],"max_tasks":3}],
    "shipments":[{"pickup":{"id":1001,"location":[8.6821,50.1109],"service":1800},
      "delivery":{"id":1001,"location":[9.9937,53.5511],"service":600},
      "amount":[10000]}]
  }'), $REGION));
```

### Common silent-rejection causes (VROOM v1.0.4)

VROOM v1.0.4 silently drops the entire response (0 rows, no error) when:

- `max_travel_time` is smaller than the shortest feasible tour. The React UI
  computes this from the haversine envelope of the candidate pool times
  `(2 * maxStops + 1)` legs plus the user's `detourSlackHrs` slider — a fixed
  4 h baseline like the legacy formula collapses on continental graphs.
- `max_distance` is smaller than the shortest feasible tour distance.
- `costs.per_hour` is set (added in upstream VROOM v1.13). Fold into
  `costs.per_km` via assumed speed (HGV ≈ 60 km/h).
- Multi-dim `capacity` does not match `amount` length on a shipment.
- `vehicle.profile_options.avoid_polygons` is set but the routing gateway
  does not yet forward it to the ORS matrix call.
