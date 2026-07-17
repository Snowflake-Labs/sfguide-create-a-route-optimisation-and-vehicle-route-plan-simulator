# safety_risk_scorecard - Safety / Risk Scorecard

## Summary

Purpose: Operational risk events by severity - click a KPI tile to filter, review an event queue table, and map hot spots. Defined in `app-views.json:2038-2258`.

**Entities**: Safety/risk events (speeding, harsh braking, etc.) with severity (high/medium/low), entity (vehicle/driver ID), event type, timestamp, location.

**Data source**: `FLEET_APP.CORE.F_FACT_EVENT_SCOPED(region, dataset_id)` table function (`app-views.json:2053,2097,2123,2243`).

**Areas** (4):
- `kpi` (MetricCards) - total events, high/medium/low counts. Emits `selected_severity` (`app-views.json:2090-2092`).
- `factor` (Chart) - bar chart of events by type, filtered by selected severity (`app-views.json:2094-2118`).
- `queue` (ClickableTable) - event detail rows (event_id, type, severity, entity, ts). Emits `selected_entity` (`app-views.json:2148-2150`).
- `map` (Map) - scatterplot layer `events`, colored by severity, highlights selected entity in blue (`app-views.json:2152-2256`).

**Map layers**: 1 layer (`events`) - scatterplot, colorBy severity via basePalette, highlight via `whenViewStateEquals: selected_entity` (`app-views.json:2200-2235`). No `clickEmits` - selectedFeature.attrs is never populated.

**Emits to viewState**: `selected_severity` (from KPI tile click), `selected_entity` (from table row click).

**agentKnowledge**: None (`app-views.json:2038-2041` has no agentKnowledge block).

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|----------------|------------------------|---------------|----------|
| 1 | How many safety events are on the map? | Counting | Partial | mapState.layers[0].featureCount gives total rendered points (up to 5000 limit), but not the unfiltered total. On-screen metric `total_events` is NOT in any channel. | Add agentKnowledge.keyMetrics or publish kpi result as viewState memo field. | Med |
| 2 | How many high-severity events are there? | Counting | Partial | Agent sees `selected_severity=high` if user clicked the tile (Channel A viewState), but the numeric count (from kpi query) is never sent. featureCount is total layer points not severity-split. | Publish kpi metric values (total_events, high, medium, low) as viewState memo or agentKnowledge hint. | High |
| 3 | What severity filter is active? | Spatial/filter | Yes | Channel A viewState: `selected_severity=<value>` when a KPI tile is clicked (app-views.json:2090-2092). | None needed. | - |
| 4 | Which entity is selected in the table? | Per-entity detail | Yes | Channel A viewState: `selected_entity=<value>` (app-views.json:2148-2150). | None needed. | - |
| 5 | What are the details of the selected event on the map? | Per-entity detail | No | No `clickEmits` on the map layer (app-views.json:2194-2255) so selectedFeature.attrs is never populated. Tooltip data (type, severity, entity_id) exists client-side but is not in any channel. | Add `clickEmits` to the `events` layer with `objectColumn: entity_id` and relevant attrs (type, severity, entity_id, lat, lng). | High |
| 6 | Where are the high-severity hotspots concentrated? | Spatial/on-map | Partial | mapState.bbox gives viewport extent; legend gives severity labels; featureCount gives total point count. But no spatial clustering/location identity is sent. | Could add agentKnowledge.gotchas noting the tool can query the underlying function, or add clickEmits for individual inspection. | Med |
| 7 | What event types are most common? | Ranking/superlatives | No | The `factor` chart query result (event_type breakdown) is never sent to the agent - chart data is not in any channel. | Add agentKnowledge with preferredTool pointing to a semantic view or MCP verb that can query F_FACT_EVENT_SCOPED; or publish top-N event types as viewState memo. | High |
| 8 | Which driver has the most events? | Ranking/superlatives | No | Not in any channel. The queue table shows per-event rows but entity-level aggregation is not exposed. Data exists in F_FACT_EVENT_SCOPED. | Add agentKnowledge with preferredTool (e.g., query_fleet or a dedicated verb) that can GROUP BY ENTITY_ID. | Med |
| 9 | What is the trend of events over time? | Time/trend | No | No time-series data in any channel. Data exists (EVENT_TS in the function) but no trend chart or time aggregation is exposed. | Could add agentKnowledge exampleQuestion or preferredTool pointing to a temporal query. | Low |
| 10 | What are the map legend colors? | Map-state/rendering | Yes | Channel B mapState.legend: ["High severity", "Medium severity", "Low severity", "Selected entity"] (app-views.json:2156-2193). | None needed. | - |
| 11 | Is the events layer rendering or blank? | Map-state/rendering | Yes | Channel B mapState.layers[0].rendered and featureCount fields. If blank, agent can diagnose via gated/rendered flags. | None needed. | - |
| 12 | What region and date range is this scoped to? | Context | Yes | Always-injected activeContext (route.ts:108-140): region, vehicle_type, dataset_id, date_range_start, date_range_end. | None needed. | - |
| 13 | How many events are in the current viewport? | Counting | Partial | featureCount gives total layer features (may exceed viewport if map is zoomed in). No viewport-clipped count. | Low value - featureCount is close enough for most uses. | Low |
| 14 | Compare high vs medium vs low event counts | Comparison/breakdown | No | Numeric values from kpi query not in any channel. Agent knows key names (high, medium, low) from KPI label config but not the numbers. | Same fix as #2 - publish kpi metric values to viewState. | High |
| 15 | What does severity "medium" mean operationally? | Per-entity detail | No | No definition of severity thresholds in any channel. Not in agentKnowledge. | Add agentKnowledge.gotchas explaining severity classification logic. | Low |

## Notes

- This view has NO agentKnowledge block and NO clickEmits - the two most impactful additions.
- The primary gap pattern: metric values (KPI numbers) and chart aggregation results are never sent to the agent. The agent knows the filter state and map rendering metadata, but not the actual data values.
- The map layer uses `whenViewStateEquals: selected_entity` for highlight (app-views.json:2213-2214), meaning table selection drives map highlight - this linkage works well for visual UX but produces no additional agent grounding beyond `selected_entity=X` in viewState.
- Fix priority: (1) Add agentKnowledge block with preferredTool + keyMetrics + gotchas. (2) Add clickEmits to map layer. (3) Consider publishing top-line KPI values as viewState memo fields (requires view-map.tsx extension).
- Grounding tally: Yes=4, Partial=4, No=7.

## Post-fix update (Gap 1 + Gap 2 implemented)

- Gap 1 (kpi_memo): the MetricCards area publishes `__memo_kpi` carrying total_events plus the high, medium, and low severity counts.
- Gap 2 (agentKnowledge): keyMetrics + exampleQuestions + gotcha added, but `preferredTool` is deliberately OMITTED (recommended): safety events (severity, type, per-driver counts) are not modeled in any semantic view, so no Cortex Analyst tool can recompute them. The gotcha instructs the agent to answer counts/severity from the on-screen memo and never invent event types, per-driver counts, or trends.
- Now Yes via memo: Q1 (events count), Q2 (high-severity count), Q14 (compare high/medium/low).
- Still No (need a dedicated safety-event SV, or Gap 3 clickEmits): Q7 (event types), Q8 (driver with most events), Q9 (trend), Q15; Q5 stays Yes, Q6/Q13 stay Partial.
- Revised tally: Yes=7, Partial=2, No=6 (was 4/4/7). Follow-up recommendation: build a safety-event semantic view to unlock event-type rankings and trends via a tool.
