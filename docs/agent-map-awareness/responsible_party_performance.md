# responsible_party_performance - Operator Performance

## Summary

**Purpose:** Compare operators (drivers/responsible parties) on trip counts, total distance, route deviations, and safety events. Merges Driver Performance and Operator Performance views.

**Data entities:** Journeys (F_FACT_JOURNEY_SCOPED), Events (F_FACT_EVENT_SCOPED).

**Map layers (app-views.json:1480-1503):**
| Layer ID | Type | Shows |
|---|---|---|
| `operator-journeys` | path | Actual route paths for the selected operator (or all operators if none selected), limited to 200 routes (line 1482) |

**Key metrics (MetricCards, lines 1380-1416):** Operators (distinct count), Journeys (total count), Avg Distance, Deviated Journeys.

**Chart (lines 1418-1441):** "Top Operators by Safety Events" - bar chart, top 12 operators by event count.

**Table (ClickableTable, lines 1443-1462):** Columns: operator, journeys, total_km, deviations, safety_events. Sorted by safety_events DESC. Max 50 rows.

**Filters/selections:**
- `selected_operator` emitted by ClickableTable (line 1461).
- Date range from context (applied to KPI query, lines 1388-1389).

**agentKnowledge:** NO. No agentKnowledge block exists for this view.

**Legend (lines 1468-1479):** Single entry: "Actual route" (blue line).

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|---|---|---|---|---|---|
| 1 | Which operator is selected? | Map-state | Yes | viewState.`selected_operator` (Channel A, emits line 1461). | N/A | - |
| 2 | How many operators are there? | Counting | Partial | KPI computes `operators` count (line 1394). Not in viewState. No preferredTool declared. The data exists in F_FACT_JOURNEY_SCOPED via `query_fleet_ops`. | Add agentKnowledge with `preferredTool: query_fleet_ops` and `keyMetrics: [operator count, total journeys, avg distance, deviations, safety events]`. Also add a `kpi_memo` viewState field. | High |
| 3 | How many total journeys are there? | Counting | Partial | KPI computes `journeys` count (line 1399). Same gap as #2. | kpi_memo + agentKnowledge. | High |
| 4 | What is the average trip distance? | Counting | Partial | KPI computes `avg_dist` (line 1404). Not in viewState. No preferredTool. | kpi_memo + agentKnowledge. | High |
| 5 | How many journeys had deviations? | Counting | Partial | KPI computes `deviations` (line 1410). Not in viewState. No preferredTool. | kpi_memo + agentKnowledge. | High |
| 6 | Who has the most safety events? | Ranking | Partial | The chart (lines 1418-1441) shows top 12 operators by event count. The table (lines 1443-1462) is sorted by safety_events DESC. Neither chart data nor table data reaches any channel. No preferredTool. Data exists in Snowflake. | agentKnowledge.preferredTool for the query path. Optionally a `top_operator_memo` viewState field (e.g. "top_by_events=OP-042(28), OP-017(22), OP-091(19)"). | High |
| 7 | Who has the most deviations? | Ranking | Partial | Table column `deviations` exists but table data not in channels. No preferredTool. | Same fix as #6. agentKnowledge.preferredTool. | Med |
| 8 | How does operator X compare to operator Y? | Comparison | No | No operator metrics reach any channel. No preferredTool. The data is queryable via `query_fleet_ops` if the agent knew to use it. | agentKnowledge.preferredTool is the minimal fix. For direct answers, a `table_memo` with top-N rows serialized. | Med |
| 9 | What routes is the selected operator driving? | Spatial/on-map | Partial | mapState.layers[operator-journeys].featureCount tells how many routes are rendered for the selection. mapState.bbox gives viewport. But the agent cannot see the actual route geometries or specific locations. | featureCount + bbox is a reasonable partial answer ("X routes visible in [region]"). For specifics, preferredTool query. | Low |
| 10 | How many routes are shown on the map? | Counting | Yes | mapState.layers[operator-journeys].featureCount (Channel B, route.ts:69). | N/A | - |
| 11 | Why is the map empty? | Map-state | Yes | mapState.emptyLayers (Channel B). Common cause: no journeys with ACTUAL_PATH_GEOG in the date range, or the 200-row limit returning 0 for a filter. Agent instructions handle diagnosis (route.ts:90). | N/A | - |
| 12 | What is the selected operator's total distance? | Per-entity detail | Partial | Table has `total_km` column for each operator. Not in viewState. No preferredTool. | If `selected_operator` is set, a `selected_operator_memo` viewState field (e.g. "journeys=42, total_km=1820, deviations=5, safety_events=12") from the table data. Or agentKnowledge.preferredTool. | High |
| 13 | What date range is this showing? | Map-state | Yes | viewState carries context.date_range_start / date_range_end (Channel A, via context params lines 1388-1389). Plus activeContext injection (route.ts:131-133). | N/A | - |
| 14 | What does the chart show? | Map-state | Partial | No chart metadata is in any channel. The agent knows the view description ("Compare operators on trips, distance, deviations, and safety events") from the view label/description injected in Channel A (route.ts:35). But it cannot describe the chart specifics. | agentKnowledge.gotchas or keyMetrics could mention "bar chart shows top 12 operators ranked by safety event count". | Low |
| 15 | Which operator covers the most distance? | Ranking | No | Table has `total_km` but data not in channels. No preferredTool. Data exists in Snowflake. | agentKnowledge.preferredTool. | Med |
| 16 | Is there a correlation between distance and safety events? | Comparison | No | Requires cross-column analysis of the table data. Not in any channel. Data exists in F_FACT_JOURNEY_SCOPED + F_FACT_EVENT_SCOPED. | agentKnowledge.preferredTool for the tool-query path. This is an analytical question best handled by a Cortex Analyst query. | Low |
| 17 | What's the safety event rate per journey for the selected operator? | Per-entity detail | No | Requires dividing safety_events by journeys for the selected operator. Neither value is in viewState. No preferredTool. Data queryable. | agentKnowledge.preferredTool + potentially a `selected_operator_memo` with pre-computed rate. | Med |
| 18 | What legend is shown? | Map-state | Yes | mapState.legend (Channel B, route.ts:89) carries "Actual route" from config (lines 1468-1479). | N/A | - |

## Notes

- **Critical gap: no agentKnowledge block.** This is a straightforward leaderboard/comparison view but the agent has zero tool routing hints. Since `query_fleet_ops` (the fleet semantic view tool) covers F_FACT_JOURNEY_SCOPED and F_FACT_EVENT_SCOPED, adding a minimal agentKnowledge block would immediately unlock all ranking and comparison questions via tool calls.
- **Simplest view of the three** - one map layer, one chart, one table, 4 KPIs. The fix surface is small: (1) add agentKnowledge block, (2) optionally add a `kpi_memo` viewState field for the 4 KPI values.
- **Table data is the biggest blind spot.** The operator leaderboard (50 rows, 5 columns) is the core interaction surface. The agent sees only `selected_operator` (which row is clicked). A bounded `top_operators_memo` (top 5 by events, serialized as a string) would answer most ranking questions without a tool round-trip.
- **Map layer is filter-reactive.** The `operator-journeys` layer query (line 1494) uses `:selected_operator` - when null it shows all routes (up to 200), when set it filters to that operator. mapState.featureCount will reflect this, giving the agent awareness of "how many routes for this operator."
- **Cross-view pattern:** This view is linked FROM `journey_inspector` (DetailPanel action, journey_inspector line 1277-1283) carrying `selected_operator`. The carried value will appear in viewState upon navigation.

## Post-fix update (Gap 1 + Gap 2 implemented)

- Gap 1 (kpi_memo): the MetricCards area publishes `__memo_kpi` into viewState carrying Operators, Journeys, Avg Distance, and Deviated Journeys.
- Gap 2 (agentKnowledge): `preferredTool: query_fleet_ops` + keyMetrics + exampleQuestions + a gotcha (per-operator safety-event counts are event-derived, not in SV_FLEET_OPS).
- Now Yes via memo: Q2 (operators), Q3 (journeys), Q4 (avg distance), Q5 (deviations). Now Yes via query_fleet_ops: Q7 (most deviations), Q8 (compare operators), Q12 (selected operator distance), Q15 (most distance).
- Still Partial/No (safety events not in SV, or need Gap 4 table_memo): Q6, Q9, Q14, Q16, Q17.
- Revised tally: Yes=12, Partial=5, No=1 (was 4/11/3).
