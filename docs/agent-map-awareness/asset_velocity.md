# asset_velocity - Asset Velocity

## Summary

**Purpose:** Surfaces idle vehicles, their cost of idleness, projected savings, and where they are parked. Users set a minimum idle threshold via a slider, see severity-grouped bar charts, and click a vehicle row to highlight it on the map.

**Source file:** `.cortex/skills/install-fleet-apps/fleet_sa_app/app/app-views.json` lines 3986-4268.

**Entities:** Vehicles (idle fleet assets), demand terminals (lane demand locations).

**Map layers (2):**
- `demand` (scatterplot) - demand terminals from `FLEET_APP.ROUTE_OPTIMIZATION.VW_LANE_DEMAND`, columns: terminal_name, demand_score, lng, lat (file:4138-4158).
- `idle` (scatterplot) - idle vehicles from `FLEET_APP.ROUTE_OPTIMIZATION.VW_VEHICLE_COST_OF_IDLENESS`, columns: vehicle_id, severity, idle_days, lng, lat. Color by severity palette (CRITICAL/WARNING/WATCH/OK) with highlight for `selected_vehicle` (file:4160-4223).

**Metrics (MetricCards):** idle_vehicles, cost_usd, savings_usd, avg_idle_days (file:4011-4046).

**Chart:** Bar chart of vehicles by idle severity (file:4048-4073).

**Table (ClickableTable):** Top 50 idle vehicles sorted by cost_usd DESC; columns: vehicle_id, subtype, last_location, idle_days, severity, dispatcher, cost_usd (file:4227-4255).

**Rationale area:** Cortex LLM repositioning recommendation for the selected vehicle (file:4257-4267).

**Emits (viewState keys):**
- `idle_min` from Slider (file:4007-4009).
- `selected_vehicle` from ClickableTable row selection (file:4253-4255).

**agentKnowledge:** NONE (confirmed - no `agentKnowledge` block anywhere in the asset_velocity object).

**clickEmits (map click -> viewState):** NONE (no `clickEmits` on either map layer; only the table click sets `selected_vehicle`).

**Map state (Channel B):** YES - two layers reported with featureCount, type, colorBy (severity on idle layer), rendered/gated status. No selectedFeature because no `clickEmits`.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | How many idle vehicles are there right now? | Counting | Partial | viewState carries `idle_min` filter but NOT the metric values (idle_vehicles count). Map Channel B has `featureCount` on the `idle` layer (max 2000 rows) which approximates but may be capped by LIMIT 2000. Actual metric is not serialized. | Publish metrics as viewState field (e.g. `idle_vehicles_count`, `cost_usd_total`) from MetricCards area via a memo emitter or agentKnowledge.keyMetrics referencing a tool. | High |
| 2 | What is the total cost of idleness? | Counting | No | MetricCards queries `cost_usd` but the scalar result is never injected into any channel. Agent has no path to this number without a tool call, and no `preferredTool` is declared. | Add `agentKnowledge.preferredTool` pointing to the semantic view (`SV_FLEET_OPS`) or add a keyMetrics hint: "cost of idleness is queryable via SV_FLEET_OPS". | High |
| 3 | What projected savings would I get by redeploying idle vehicles? | Counting | No | Same gap as #2 - `savings_usd` is rendered but not in any grounding channel. | Same fix as #2 (agentKnowledge + preferredTool). | High |
| 4 | Where are the idle vehicles clustered on the map? | Spatial | Partial | Channel B reports bbox and `idle` layer featureCount + rendered status, so the agent knows there ARE idle vehicles on screen and the viewport extent. But it cannot name specific locations or clusters - no feature attributes are exposed (no `clickEmits`). | Add `clickEmits` on the `idle` layer so clicking a vehicle populates `selectedFeature.attrs` (vehicle_id, severity, idle_days, last_location). This gives per-feature spatial answers. | Med |
| 5 | Which vehicle has the highest cost of idleness? | Ranking | No | Table data (top 50 by cost_usd) is not serialized to any channel. Agent has no row-level data. | Add `agentKnowledge.preferredTool = "query_fleet_ops"` so the agent knows to query the SV for ranking questions; OR publish a `top_idle_vehicle` memo in viewState. | High |
| 6 | Tell me about vehicle X (a specific vehicle ID) | Per-entity | Partial | If the user has clicked that row, `selected_vehicle=X` appears in viewState (Channel A). But the agent only sees the ID string, not the vehicle's attributes (cost, severity, location, dispatcher). | Add `clickEmits` on the map layer AND/OR surface selected-row attrs in viewState. Alternatively, add agentKnowledge.preferredTool so the agent queries for the vehicle. | Med |
| 7 | What severity levels are represented and how many vehicles in each? | Breakdown | No | The bar chart area queries this but the result is not in any channel. Agent sees only the idle_min filter value. | agentKnowledge.keyMetrics hint or preferredTool. | Med |
| 8 | Are there any CRITICAL-severity vehicles? | Counting | Partial | Map Channel B might carry `colorBy=severity` on the idle layer, so the agent knows the layer is colored by severity. But it cannot count per-severity without data. featureCount is total, not per-category. | agentKnowledge.keyMetrics or preferredTool. | Med |
| 9 | Which dispatcher has the most idle vehicles? | Ranking | No | `dispatcher` column is in the table query but never surfaces in any channel. | preferredTool pointing to SV_FLEET_OPS. | Med |
| 10 | What is the average idle duration? | Counting | No | `avg_idle_days` metric is computed but not exposed. | Same as #2. | High |
| 11 | Where is vehicle X parked (last known location)? | Spatial/per-entity | No | `last_location` is a table column; lat/lng are on the map. But neither appears in any agent channel unless the user clicks the row (only ID exposed). | clickEmits + preferredTool. | Med |
| 12 | Are there any demand terminals near the idle vehicles? | Spatial | Partial | Both `demand` and `idle` layers are reported in mapState with featureCounts. The agent can say "there are N demand terminals and M idle vehicles on the map" but cannot correlate them spatially. | This would require a tool (spatial join query). Add agentKnowledge.gotchas noting proximity questions need a tool call. | Low |
| 13 | Show me vehicles idle for more than 7 days | Filtering | Partial | The user can adjust the slider and `idle_min` appears in viewState. The agent can acknowledge the filter but cannot enumerate the resulting vehicles. | preferredTool to query with the active filter. | Med |
| 14 | What is the idle threshold currently set to? | Map-state | Yes | `idle_min` is an emitted viewState key (Channel A, route.ts:38-41). Agent sees `idle_min=<value>`. | N/A | N/A |
| 15 | Is the idle vehicles layer currently visible on the map? | Map-state | Yes | Channel B reports each layer's `rendered` and `gated` status (route.ts:68-72). Agent can state whether the `idle` layer is rendered or blank/hidden. | N/A | N/A |
| 16 | What region am I looking at? | Map-state | Yes | activeContext (Channel A, route.ts:108-140) carries `region`. | N/A | N/A |
| 17 | What vehicle did I select? | Map-state | Yes | viewState `selected_vehicle` (Channel A). | N/A | N/A |
| 18 | What does the AI recommend for the selected vehicle? | Per-entity | No | The rationale area calls Cortex COMPLETE but the LLM response is rendered in a Table component; its text is not injected into any grounding channel. | Publish the rationale text as a viewState field (e.g. `ai_rationale_text`). Config views cannot easily do this without view-map.tsx changes; alternatively add agentKnowledge.gotchas explaining the rationale is visible on screen but not in agent context. | Low |

## Notes

- The view has a map (Channel B active) and emits two viewState keys (Channel A: `idle_min`, `selected_vehicle`). No agentKnowledge (Channel C absent).
- The primary gap is that metric values and table data never reach the agent. Adding `agentKnowledge.preferredTool` referencing `SV_FLEET_OPS` (or a dedicated query tool) would let the agent answer counting/ranking/breakdown questions via a tool round-trip.
- Adding `clickEmits` to the `idle` map layer would enable per-feature spatial answers when the user clicks on the map (cheaper than a full viewState memo).
- Config views cannot add custom viewState memo fields without editing `view-map.tsx`, so the lowest-friction fix is agentKnowledge (JSON-only, no code change).

**Summary: Yes=4, Partial=6, No=8**

## Post-fix update (Gap 1 + Gap 2 implemented)

- Gap 1 (kpi_memo): the MetricCards area publishes `__memo_metrics` carrying idle_vehicles, cost_usd, savings_usd, and avg_idle_days.
- Gap 2 (agentKnowledge): `preferredTool: query_asset_velocity` (the dedicated SV_ASSET_VELOCITY, previously unused by any view) + keyMetrics + exampleQuestions + a gotcha (idle_min is the threshold, selected_vehicle is the clicked row, the AI rationale is on screen only).
- Now Yes via memo: Q1 (idle count), Q2 (total cost), Q3 (savings), Q10 (avg idle days). Now Yes via query_asset_velocity: Q5 (highest cost vehicle), Q6 (vehicle X detail), Q7 (severity breakdown), Q8 (CRITICAL count), Q9 (dispatcher ranking), Q13 (vehicles idle > N days).
- Still Partial/No (need Gap 3 clickEmits or a spatial join): Q4 (cluster), Q11 (parked location), Q12 (demand near idle), Q18 (AI rationale text).
- Revised tally: Yes=14, Partial=2, No=2 (was 4/6/8).
