# journey_inspector - Journey Inspector

## Summary

**Purpose:** Reconstruct and inspect a single journey/trip: actual vs planned path, deviation segments, stops with SLA status, speed profile over time, and a GPS replay slider. Merges Trip Inspector, Trip Inspection, Route Inspector.

**Data entities:** Journeys (F_FACT_JOURNEY_SCOPED), Positions (F_FACT_POSITION_SCOPED), Stops (F_FACT_STOP_SCOPED), Events (F_FACT_EVENT_SCOPED), Sites (F_DIM_SITE_SCOPED).

**Map layers (app-views.json:891-1151):**
| Layer ID | Type | Shows |
|---|---|---|
| `planned` | path | Planned route geometry for the selected journey (line 894) |
| `actual_overview_on` | path | All on-plan routes when NO journey selected (overview mode) (line 916) |
| `actual_overview_dev` | path | All deviated routes when NO journey selected (overview mode, red) (line 939) |
| `actual_on_plan` | path | Segments of selected journey that are on-plan (within 40m) (line 964) |
| `actual_deviation` | path | Segments of selected journey that deviate from plan (red) (line 987) |
| `dwell` | scatterplot | Dwell/stop locations colored by SLA status (OK/WARNING/CRITICAL) (line 1009) |
| `od` | scatterplot | Origin (green) and Destination (dark) markers (line 1066) |
| `replay` | scatterplot | Single animated replay dot at slider percentage position (line 1117) |

**Key metrics - Vehicle summary (vsummary MetricCards, lines 639-687):** Trips, Deviated trips, % Trips deviated, Avg deviation %, Total distance, Total deviation (km). Only shown when vehicle selected but no specific journey.

**Key metrics - Journey KPIs (kpi MetricCards, lines 689-745):** Distance, Planned, Duration (min), Avg Speed (km/h), Stops, Dwell (min), Safety Events, Deviation %. Shown when a specific journey is selected.

**Tables:** Journey list (ClickableTable, lines 747-803) with columns: Trip, Entity, Operator, Dist (km), Dur (min), Deviated (yes/no).

**Filters/selections:**
- `selected_vehicle` from ComboBox (lines 618-636)
- `selected_journey` from ClickableTable (lines 801-803)
- `replay_pct` from Slider (lines 1187-1199)
- `deviation_threshold` from context

**agentKnowledge:** NO. No agentKnowledge block exists for this view.

**Charts:** Speed Profile vs Posted Limit (lines 1154-1185) - time-series line chart.

**DetailPanel (lines 1201-1365):** Triggered by selected_journey. Shows journey metadata (entity, operator, status, start/end time, distance, planned, duration, deviation), with related tables: Stops on this journey, Safety & Compliance Events.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|---|---|---|---|---|---|
| 1 | Which journey is selected? | Map-state | Yes | viewState.`selected_journey` (Channel A, emits line 802). | N/A | - |
| 2 | Which vehicle is selected? | Map-state | Yes | viewState.`selected_vehicle` (Channel A, emits line 635). | N/A | - |
| 3 | How far did this journey deviate from the plan? | Per-entity detail | Partial | viewState has `selected_journey` but NOT the deviation distance/percentage. The KPI area computes `deviation_frac` (line 692) but that value is not in viewState. No preferredTool is declared - agent has no tool hint. The data exists in `F_FACT_JOURNEY_SCOPED` which `query_fleet_ops` semantic view likely covers. | Add agentKnowledge with `preferredTool: query_fleet_ops` and `keyMetrics: [distance, deviation %, stops, dwell time, avg speed]`. Also add a `journey_kpi_memo` viewState field. | High |
| 4 | How many stops did the selected journey have? | Per-entity detail | Partial | KPI shows "Stops" count (line 724) but value not in viewState. mapState.layers[dwell].featureCount gives a count of dwell points rendered on map (roughly = stops with geometry). | featureCount of `dwell` layer is a reasonable proxy. For exact answer, agent needs a tool. Add agentKnowledge.preferredTool. | Med |
| 5 | Were there any safety events on this trip? | Per-entity detail | Partial | KPI shows "Safety Events" count (line 734). DetailPanel related table (lines 1322-1362) lists them. Neither is in viewState. No preferredTool declared. | agentKnowledge + preferredTool + `journey_kpi_memo` viewState field. | High |
| 6 | What is the average speed on this journey? | Per-entity detail | Partial | KPI computes `avg_kmh` (line 692). Not in viewState. No preferredTool. | agentKnowledge + journey_kpi_memo. | High |
| 7 | How many journeys are in the table? | Counting | Partial | mapState does not cover table row counts. The journeys table (lines 747-803) returns up to 100 rows. No channel carries table row count. | Could use mapState.layers[actual_overview_on].featureCount + [actual_overview_dev].featureCount as proxy for visible journey count (overview mode). Or add a `journey_count` viewState memo. | Med |
| 8 | How many journeys deviated? | Counting | Partial | The vsummary KPI shows "Deviated trips" (line 661) when vehicle selected but no journey. Not in viewState. mapState.layers[actual_overview_dev].featureCount gives the count of deviated routes shown on map (up to 50). | featureCount of `actual_overview_dev` is a bounded proxy. For exact number, add `vehicle_summary_memo` viewState field or agentKnowledge.preferredTool. | Med |
| 9 | Where did the deviation happen (geographically)? | Spatial/on-map | Partial | The `actual_deviation` layer (line 987) renders deviation segments. mapState confirms it is rendered (featureCount > 0). But the agent cannot read coordinates from path layers. mapState.bbox gives the viewport extent. | The agent can say "deviation segments are visible on the map in the current viewport" but cannot pinpoint the location. Adding selectedFeature on pickable path layers would help, but paths are linear - limited value. preferredTool + positional query is better. | Low |
| 10 | What is the replay position showing? | Map-state | Partial | viewState.`replay_pct` gives the slider percentage. mapState.layers[replay].featureCount tells if the dot is rendered. But the agent cannot see the replay dot's coordinates or speed. | Could add a `replay_memo` viewState field (e.g. "replay_pct=42, speed=55.2, time=14:23:07") from the replay layer query response. | Low |
| 11 | What was the maximum speed on this journey? | Per-entity detail | Partial | The speed chart (lines 1154-1185) shows speed over time but chart data is not in any channel. KPI has avg speed but not max. The underlying query includes SPEED_VALUE. No preferredTool. | agentKnowledge.preferredTool + keyMetrics including "max speed". Or add to journey_kpi_memo. | Med |
| 12 | Where did the journey start and end? | Per-entity detail | Partial | DetailPanel shows `origin` and `destination` site labels (lines 1221-1228). The `od` layer (line 1066) renders origin/destination dots. But DetailPanel content and map point coords are not in viewState. If user clicks an OD dot, selectedFeature.attrs could populate. | Add `clickEmits` on `od` layer to get selectedFeature.attrs={kind, site, lng, lat}. Also add origin/destination to a journey_detail_memo viewState field. | Med |
| 13 | What layers are showing on the map? | Map-state | Yes | mapState.layers array (Channel B, route.ts:68-74). | N/A | - |
| 14 | Why is the map blank? | Map-state | Yes | mapState.emptyLayers + agent instructions to diagnose (route.ts:90). Common cause: no journey selected (overview layers need vehicle filter; detail layers need selected_journey). | N/A | - |
| 15 | How long was the total dwell time on this journey? | Per-entity detail | Partial | KPI computes `dwell_min` (line 729). Not in viewState. No preferredTool. | journey_kpi_memo + agentKnowledge. | Med |
| 16 | Which stop had the longest dwell? | Ranking | No | Stop details are in DetailPanel related table (lines 1287-1320) and the `dwell` layer tooltip shows per-stop dwell. Neither is in any channel. No preferredTool to query stops. | agentKnowledge.preferredTool pointing to `query_fleet_ops` (which should cover F_FACT_STOP_SCOPED). The data exists in Snowflake. | Med |
| 17 | Were there any SLA breaches (critical/warning stops)? | Per-entity detail | Partial | mapState.layers[dwell].featureCount tells how many stops are on map, and the dwell layer uses colorBy SLA palette (lines 1013-1041). But the agent only sees featureCount, not the breakdown by SLA status. | Add a `sla_summary` viewState memo (e.g. "stops_ok=3, stops_warning=1, stops_critical=0") from the dwell layer data. | Med |
| 18 | Compare the planned distance to actual distance | Comparison | Partial | KPI shows both `dist_km` and `planned_km` (lines 700-711). Not in viewState. No preferredTool. | journey_kpi_memo carrying both values. | High |
| 19 | What is the deviation threshold being used? | Map-state | Yes | viewState carries `deviation_threshold` via context params (line 645, context.deviation_threshold). If set, it appears as a viewState active filter. | N/A | - |
| 20 | How does the speed compare to the posted limit? | Time/trend | No | The speed chart (lines 1154-1185) shows speed vs posted limit. Chart data is never in any channel. No preferredTool. The data exists in F_FACT_POSITION_SCOPED.POSTED_SPEED_VALUE. | agentKnowledge hint: "Speed chart shows actual vs posted limit. Use query_fleet_ops to compare." Or add a `speed_compliance_memo` (e.g. "speeding_pct=12, max_over_limit=18km/h"). | Low |

## Notes

- **Critical gap: no agentKnowledge block.** This is one of the richest views (8 map layers, 8 KPIs, speed chart, replay slider, detail panel with 2 related tables) yet the agent receives ZERO routing hints. Adding an agentKnowledge block with `preferredTool: query_fleet_ops` and relevant keyMetrics/exampleQuestions/gotchas would immediately upgrade all Partial answers to tool-accessible.
- **Journey KPIs are the #1 fix target.** The 8-metric KPI panel (distance, planned, duration, avg speed, stops, dwell, events, deviation) is the most-asked-about data for an inspector view. A single `journey_kpi_memo` viewState string would close questions 3, 5, 6, 11, 15, 18.
- **Replay slider is a niche gap.** `replay_pct` reaches the agent via viewState but the replay dot's resolved position/speed/time does not. Low priority since users rarely ask "what speed at replay position X" via chat.
- **Overview mode vs detail mode:** Many layers are mutually exclusive (overview shows `actual_overview_on/dev`, detail shows `actual_on_plan/deviation`). The agent can detect which mode via `selected_journey` being null or populated in viewState, and mapState.emptyLayers.
- **Cross-view linkage:** DetailPanel has an action linking to `responsible_party_performance` (line 1277-1283) carrying `selected_operator`. This is visible in the UI but not communicated to the agent - acceptable since the agent can suggest the link via availableViews.

## Post-fix update (Gap 1 + Gap 2 implemented)

- Gap 1 (kpi_memo): both MetricCards areas now publish bounded `__memo_vsummary` and `__memo_kpi` strings into viewState (Channel A). The 8 journey KPIs (distance, planned, duration, avg speed, stops, dwell, safety events, deviation %) and the vehicle-summary metrics (trips, deviated, % deviated, avg deviation %, total distance, total deviation km) now reach the agent.
- Gap 2 (agentKnowledge): `preferredTool: query_fleet_ops`, keyMetrics, exampleQuestions, and a gotcha added (deviation per trip routes to `query_route_deviation`; per-stop SLA and safety events are not in any SV, answer from the memo).
- Now Yes via Channel A memo: Q3 (deviation %), Q4 (stops), Q5 (safety events count), Q6 (avg speed), Q8 (deviated count), Q15 (dwell min), Q18 (planned vs actual distance).
- Still Partial/No (need Gap 3 clickEmits / Gap 4 table_memo / a telemetry SV): Q7, Q9, Q10, Q11 (max speed), Q12, Q16, Q17, Q20.
- Revised tally: Yes=12, Partial=6, No=2 (was 5/13/2).
