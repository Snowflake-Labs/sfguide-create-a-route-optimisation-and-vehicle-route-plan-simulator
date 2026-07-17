# vrp_simulator - Route Optimization Simulator

## Summary

**Purpose:** Collects a depot address, a list of delivery stops (free-text), a vehicle count, and a routing profile, calls the User `optimize_routes` synapse verb via `/api/tool`, and renders the resulting multi-vehicle routes on a deck.gl map (`RouteMapInline`).

**Inputs:** depot (text), stops (newline/comma-separated text), vehicles (number, 1-20), profile (driving-car | driving-hgv | cycling-regular | foot-walking). Region is read from the app store for placeholder text only.

**What the solve produces:** The `optimize_routes` verb returns an ORS/VROOM optimization result containing routes (geometry, per-vehicle stop sequences, durations, distances), unassigned jobs, and summary statistics. The raw result object is stored in component-local `result` state.

**Map layers rendered:** `RouteMapInline` (file: `fleet_sa_app/ui/src/components/inline/route-map-inline.tsx`) deep-scans the result for any GeoJSON and renders a single `GeoJsonLayer` (`id: 'inline-geojson'`). It does NOT call `setMapState`.

**What it currently publishes to viewState (Channel A):** NOTHING.
- The component signature is `export function VrpSimulatorView()` with no props (file: `vrp-simulator.tsx:23`). It does not accept `onStateChange` / `ViewProps`, never calls `updateViewState`, and never calls `onStateChange`.

**What it currently publishes to mapState (Channel B):** NOTHING.
- The component never imports or calls `setMapState` from the app store (file: `vrp-simulator.tsx:9` imports `useAppStore` but only reads `context['region']` at line 24).
- `RouteMapInline` (file: `route-map-inline.tsx:53`) is a pure rendering component - it does not touch the store's mapState.

**agentKnowledge (Channel C):** NONE.
- Registration at `fleet/index.ts:17-27` has no `agentKnowledge` block (contrast with `emergency_response` at lines 34-55 which has a full block).

**Net result:** The agent receives only the static view description from the registration (`"Plan multi-stop vehicle routes from a depot and view them on the map."`) plus the global activeContext (region/vehicle/dataset). It has zero visibility into the user's inputs, the solved plan, routes, stops, distances, durations, or map state.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | What depot did I set? | Setup/inputs | No | Not published. `depot` is local state (`vrp-simulator.tsx:30`), never serialized to panel context. | Publish `depot` as a viewState field via `onStateChange`. | High |
| 2 | How many stops did I enter? | Setup/inputs | No | Not published. `stops` is local state (`vrp-simulator.tsx:31`), count derivable but never emitted. | Publish `stop_count` (and optionally `stops_text` bounded) to viewState. | High |
| 3 | What vehicle count and profile am I using? | Setup/inputs | No | `vehicles` (`vrp-simulator.tsx:32`) and `profile` (`vrp-simulator.tsx:33`) are local state only. | Publish `vehicles` and `profile` to viewState. | High |
| 4 | How many routes did the solver return? | Solve results | No | `result` (`vrp-simulator.tsx:36`) is local state; route count is not extracted or published anywhere. | Extract route count from `result.result.routes` and publish `route_count` to viewState. | High |
| 5 | What is the total distance across all routes? | Solve results | No | Distance per route is inside `result.result.routes[].distance` but never aggregated or published. | Compute `total_distance_km` from result and publish to viewState. | High |
| 6 | What is the total duration of all routes? | Solve results | No | Duration per route is inside `result.result.routes[].duration` but never aggregated or published. | Compute `total_duration_min` from result and publish to viewState. | High |
| 7 | Which route is the longest (most stops / longest distance)? | Ranking | No | Per-route stats exist in the raw result but are never extracted or compared. | Publish `longest_route_km`, `longest_route_min`, `longest_route_stops` to viewState. | Med |
| 8 | Which vehicle has the most stops assigned? | Ranking | No | Same gap - per-vehicle stop counts are in raw result only. | Publish `max_stops_vehicle` to viewState. | Med |
| 9 | What are the stops on route/vehicle N? | Per-entity detail | No | The stop sequence per route is in `result.result.routes[].steps` but never serialized to context. | Publish `routes_detail` as a pre-joined bounded string (like emergency-response `trips_detail`). | High |
| 10 | Were any stops unassigned (could not be routed)? | Solve results | No | `result.result.unassigned` array exists in the raw result but is never surfaced. | Publish `unassigned_count` and `unassigned_stops` (bounded list) to viewState. | High |
| 11 | What is on the map right now? | Map-state | No | `RouteMapInline` does not call `setMapState` (`route-map-inline.tsx:53-132`). Agent sees no map layers. | Call `setMapState` with a MapStateDescriptor from `RouteMapInline` or the parent, reporting the GeoJsonLayer feature count + bbox. | High |
| 12 | Is the map blank / why is nothing showing? | Map-state | No | No mapState published - agent cannot diagnose blank layers. | Same as #11: publish mapState so agent can report `featureCount=0` when no result yet. | High |
| 13 | What region is the solve using? | Setup/inputs | Partial | The agent receives `region` from the global activeContext (`route.ts:124`), but the VRP simulator does not enforce or confirm the region it passed to the verb. | Publish `region` explicitly in viewState (mirrors emergency-response pattern at `emergency-response.tsx:368`). | Low |
| 14 | Compare route A vs route B (distance, duration, stops). | Comparison | No | Per-route stats are in raw result only; no structured breakdown published. | Publish `routes_detail` with per-route distance/duration/stop-count (bounded string). | Med |
| 15 | How many stops does each vehicle serve? | Aggregation | No | Not extracted from result. | Include per-vehicle stop count in `routes_detail`. | Med |
| 16 | What is the average distance per route? | Aggregation | No | Derivable from total + count but neither is published. | Publish `avg_route_km` or let agent derive from `total_distance_km` / `route_count`. | Low |
| 17 | Is the solver still running? | Status | No | `loading` state (`vrp-simulator.tsx:34`) is not published. | Publish `status` field (idle/loading/error/solved) to viewState. | Med |
| 18 | What error occurred? | Status | No | `error` state (`vrp-simulator.tsx:35`) is local only. | Publish `error` to viewState (null when none). | Med |
| 19 | What is the selected feature on the map? | Map-state | No | `RouteMapInline` has no selection state or `selectedFeature` in mapState. | If click-to-select is added, publish via mapState `selection`/`selectedFeature`. | Low |
| 20 | Can you list all the stop addresses I entered? | Setup/inputs | No | The raw `stops` textarea text is not published. | Publish `stops_list` (bounded, first N stops) to viewState. | Med |

## Notes

- **Zero grounding channels active.** The vrp-simulator is the only Tier-3 custom view in the fleet pack that publishes nothing to any of the three grounding channels. The emergency-response view (gold standard) publishes ~30+ viewState fields, a full 7-layer mapState descriptor, and a rich agentKnowledge block.

- **All data is already client-side.** The `result` state at `vrp-simulator.tsx:36` holds the complete VROOM response (routes, steps, distances, durations, unassigned). Extracting and publishing it is cheap - no new API calls or SQL needed.

- **Fix pattern (from emergency-response gold standard):**
  1. Accept `ViewProps` (`onStateChange`) in the component signature (currently takes no props).
  2. Compute a `summary` memo from `result` + inputs (depot, stops, vehicles, profile, status, error) with bounded pre-joined strings for per-route detail.
  3. Publish via `onStateChange(summary)` on change (same ref + JSON-diff guard as `emergency-response.tsx:407-415`).
  4. Import `setMapState` from `useAppStore` and publish a `MapStateDescriptor` with the inline-geojson layer's feature count + bbox (or lift mapState publishing into `RouteMapInline` itself).
  5. Add an `agentKnowledge` block to the registration at `fleet/index.ts:17-27` with `keyMetrics`, `exampleQuestions`, and `gotchas`.

- **Priority summary:** High = 10, Med = 7, Low = 3. The entire view is an agent blind spot today.
