# plan_vs_actual_performance - Plan-vs-Actual Performance

## Summary

**Purpose:** Shows which journeys diverge from plan, where, and by how much. Compares planned routes against actual routes and quantifies excess distance.

**Data entities:** Journeys (`F_FACT_JOURNEY_SCOPED`), positions (`F_FACT_POSITION_SCOPED`).

**Map layers:**
- `planned` (type: path, line 1746) - Blue planned route paths for deviated journeys (top 20 by deviation fraction). GeoJSON from PLANNED_PATH_GEOG.
- `actual` (type: path, line 1769) - Red actual route paths for the same deviated journeys. GeoJSON from ACTUAL_PATH_GEOG.

**Key metrics (KPI MetricCards, line 1678-1715):**
- total_journeys (count)
- deviated (count of journeys exceeding threshold)
- deviation_frac (deviation rate as percent)
- excess_km (total excess distance)

**Tables:**
- `table` (ClickableTable, line 1793-1813): Top 20 deviated journeys with journey_id, operator, entity, actual_km, planned_km, excess_km, deviation_pct.

**Filters/selection emits:**
- `selected_journey` (from ClickableTable row click, line 1811): filters map to show only that journey's planned+actual paths.
- `deviation_threshold` (from context, line 1688): configurable threshold for what counts as deviated.

**agentKnowledge:** YES (app-views.json:1657-1668).
- `preferredTool`: "query_route_deviation" (line 1658)
- `keyMetrics`: ["deviation rate", "deviated journeys", "excess distance vs plan"] (line 1659-1663)
- `exampleQuestions`: ["Which journeys deviated most from plan?", "How much excess distance did deviations add?"] (line 1664-1667)
- `gotchas`: "Deviation compares the actual path against the planned route; a journey with no planned route is excluded, not counted as zero deviation." (line 1668)

**clickEmits on map:** None - no selectedFeature will be populated via map click.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | How many journeys deviated from plan? | Counting | Partial | Channel C: agentKnowledge.preferredTool "query_route_deviation" (line 1658) can compute this via tool round-trip. Agent is NOT told the on-screen KPI number directly (KPI card values never enter viewState or mapState). | Publish KPI values as viewState memo fields (e.g. `kpi_deviated=5, kpi_deviation_rate=12.5%`). | High |
| 2 | What is the current deviation rate? | Counting | Partial | Same as #1 - preferredTool can compute but on-screen value not directly grounded. | Same fix: publish `kpi_deviation_frac` memo. | High |
| 3 | How much total excess distance was caused by deviations? | Counting | Partial | preferredTool "query_route_deviation" can answer. On-screen value not forwarded. | Publish `kpi_excess_km` memo. | High |
| 4 | Which journey deviated the most? | Ranking/superlative | Partial | preferredTool can query this. Table has ranked data client-side but rows are not in any channel. | Publish `worst_journey_summary` memo from table row #1 (journey_id, deviation_pct, excess_km). | Med |
| 5 | Which operator has the most deviations? | Ranking | Partial | preferredTool can GROUP BY operator. Not shown on screen as a summary. | preferredTool suffices for this - no extra fix needed beyond tool availability. | Low |
| 6 | What journey is currently selected? | Per-entity detail | Yes | Channel A: viewState includes `selected_journey=<id>` when a table row is clicked (emits line 1811, route.ts:38-42). | - | - |
| 7 | Show me the planned vs actual route for the selected journey | Spatial/on-map | Partial | Agent knows a journey is selected (viewState.selected_journey). Map shows it but agent cannot see the geometry. mapState.layers[0/1].featureCount tells whether paths rendered. | Agent can confirm paths are rendered via featureCount > 0 but cannot describe the route shape. Acceptable - spatial detail is visual. | Low |
| 8 | How many routes are shown on the map? | Counting | Yes | Channel B: mapState.layers[0].featureCount and layers[1].featureCount (route.ts:69). Both path layers report their feature counts. | - | - |
| 9 | Are both planned and actual layers rendering? | Map-state/rendering | Yes | Channel B: mapState.layers[].rendered and mapState.emptyLayers[] (route.ts:72-76). | - | - |
| 10 | What does the legend show? | Map-state/rendering | Yes | Channel B: mapState.legend = ["Planned route", "Actual route (deviated)"] (route.ts:89, config line 1721-1741). | - | - |
| 11 | What is the deviation threshold being used? | Per-entity detail | Yes | Channel A: viewState includes `deviation_threshold=0.10` if set via context (params line 1688). Note: this comes from context, always present. | - | - |
| 12 | How does this journey's actual distance compare to planned? | Per-entity detail | Partial | If selected_journey is set, preferredTool can query the specific row. Table has actual_km vs planned_km but not in channel. | Publish `selected_journey_detail` memo when a row is selected (actual_km, planned_km, excess_km, deviation_pct). | Med |
| 13 | Which entity (vehicle) has the highest cumulative excess distance? | Ranking | Partial | preferredTool "query_route_deviation" can compute this aggregation. | No extra fix needed - tool handles it. | Low |
| 14 | How many journeys have no planned route and are therefore excluded? | Counting | No | Not computed anywhere on screen. The KPI query's WHERE clause excludes them implicitly. The tool might answer if it handles this edge case. | Add to agentKnowledge.gotchas a hint that the tool can count excluded journeys, or add a dedicated memo. | Low |
| 15 | What is the viewport showing? | Map-state/rendering | Yes | Channel B: mapState.bbox (route.ts:77-79). | - | - |

## Notes

- This is the best-grounded of the three views thanks to the agentKnowledge block (line 1657-1668). The preferredTool "query_route_deviation" gives the agent a query path for most data questions.
- The primary gap is that KPI card values (total_journeys, deviated, deviation_frac, excess_km) are computed and rendered on screen but never forwarded to the agent. The agent must re-query via the tool to answer "what does the card say?" which may return slightly different numbers if data changes between render and tool call.
- Table row data (top 20 journeys with their metrics) is also invisible. The `selected_journey` selection key is the only table-derived scalar the agent sees.
- Recommended fix: publish KPI metric values as bounded viewState memo fields after the MetricCards query resolves. This is a generic framework enhancement (all MetricCards areas could auto-publish their values).
