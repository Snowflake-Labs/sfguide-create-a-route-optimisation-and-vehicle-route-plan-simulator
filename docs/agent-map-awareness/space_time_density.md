# space_time_density - Space-Time Density

## Summary

**Purpose:** Shows where fleet activity concentrates over space and time using H3 hexbins by hour-of-day. Combines congestion and demand density views into one animatable heatmap.

**Data entities:** Vehicle telemetry positions (`F_VW_FACT_VEHICLE_TELEMETRY_SCOPED`), POIs (`F_VW_DIM_POIS_SCOPED`).

**Map layers:**
- `(unnamed h3 layer)` (type: h3) - H3 resolution-8 hexbins colored by selected metric (time spent or distinct vehicles). Tooltip: h3_index, dwell_min, entities. (app-views.json:1584-1615)

**Key metrics (KPI area):** None - no MetricCards component. Aggregate values are embedded in the hex layer data itself (dwell_min, entities per hex).

**Tables:**
- `places` (Table, line 1619-1633): Top 6 places by time spent (place name, dwell_min, vehicles).
- `drivers` (Table, line 1635-1649): Top 6 drivers by dwell (driver ID, dwell_min).

**Filters/selection emits:**
- `selected_metric` (ComboBox, line 1529-1531): "time" or "entities".
- `selected_hour` (Slider, line 1544-1545): 0-23.
- `aggregate_all` (Checkbox, line 1554-1555): true/false.

**agentKnowledge:** None (app-views.json:1508 - no agentKnowledge block).

**clickEmits on map:** None - no selectedFeature will be populated.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | How many hexagons are showing on the map right now? | Counting | Yes | Channel B: mapState.layers[0].featureCount (route.ts:69) | - | - |
| 2 | What is the total dwell time across all hexbins at the current hour? | Counting/aggregation | No | Not in any channel. Data exists in the h3 layer query (sum of dwell_min) but no KPI card aggregates it and no viewState/mapState carries totals. | Add an agentKnowledge.preferredTool pointing to a semantic view or add a KPI MetricCards area whose values are published as viewState memo fields. | High |
| 3 | Which hex has the highest dwell time right now? | Ranking/superlative | No | Layer data rows are never sent to the agent; featureCount is the only number. Data exists client-side (sorted hex rows). | Publish a viewState memo field `top_hex_summary` (pre-joined string: "hex=X, dwell=Y min") from the top-1 row of the layer query result. Channel A extension. | High |
| 4 | What are the top places by dwell? | Ranking | No | The "places" Table component data is not in any channel. Agent sees neither row contents nor even a featureCount for non-map areas. | Publish a viewState memo `top_places_summary` from the places query top-3 rows (pre-joined string). | High |
| 5 | Which driver has the longest dwell time? | Ranking | No | Same gap as #4 - "drivers" Table data never reaches agent. | Publish `top_drivers_summary` memo field. | High |
| 6 | What metric am I viewing - time or vehicles? | Spatial/on-map | Yes | Channel A: viewState includes `selected_metric=time` or `selected_metric=entities` (route.ts:38-42, emits line 1530). | - | - |
| 7 | What hour am I looking at? | Spatial/on-map | Yes | Channel A: viewState includes `selected_hour=12` (emits line 1544-1545). | - | - |
| 8 | Am I aggregating the whole period or a single hour? | Map-state/rendering | Yes | Channel A: viewState includes `aggregate_all=true/false` (emits line 1554-1555). | - | - |
| 9 | Are there any blank layers on the map? | Map-state/rendering | Yes | Channel B: mapState.emptyLayers[] (route.ts:76). | - | - |
| 10 | What does the legend mean? | Map-state/rendering | Yes | Channel B: mapState.legend = ["Lower activity", "Higher activity"] (route.ts:89, config line 1562-1580). | - | - |
| 11 | How many distinct vehicles are active this hour? | Counting | No | Not surfaced. The hex layer carries per-hex entity counts but no global total. A SUM across hexes double-counts vehicles appearing in multiple cells. | Add a KPI MetricCards area with total_vehicles and publish as viewState memo. Or add agentKnowledge with preferredTool routing to a semantic view that can compute it. | Med |
| 12 | Where is the densest area geographically (neighborhood/area name)? | Spatial | No | Agent gets hex IDs (via tooltip) but never receives them. No reverse-geocoding of H3 to place name exists. | Publish `densest_hex_label` memo (reverse-geocode top hex center to nearest POI name client-side, or just report lat/lng). | Med |
| 13 | How does dwell at hour 8 compare to hour 18? | Comparison/breakdown | No | Only one hour's data is loaded at a time. Agent has no cross-hour data. | Would require a preferredTool (semantic view) that can query multiple hours. Add agentKnowledge block with a tool that queries the telemetry. | Med |
| 14 | What is the bounding box of the current viewport? | Map-state/rendering | Yes | Channel B: mapState.bbox (route.ts:77-79). | - | - |
| 15 | Show me what changed between this hour and the previous hour | Time/trend | No | Only current hour rendered. No temporal delta computed. | Requires a new tool or agentKnowledge.preferredTool to diff hours. | Low |

## Notes

- This view has NO agentKnowledge block, so the agent receives no routing hint and cannot call any tool to answer data questions. The viewState carries only the three filter scalars (selected_metric, selected_hour, aggregate_all). The mapState carries featureCount, bbox, legend, and empty-layer info - but never row-level data.
- The richest client-side data (hex layer rows with dwell_min/entities, places table, drivers table) is completely invisible to the agent. This is the highest-gap view of the three assigned.
- Recommended minimal fix: (1) add an `agentKnowledge` block with `preferredTool` pointing to a semantic view over telemetry; (2) publish `top_places_summary` and `top_drivers_summary` memo strings into viewState from the already-fetched table data.

## Post-fix update (Gap 1 + Gap 2 implemented)

- Gap 1 (kpi_memo): N/A - this view has no MetricCards area, so nothing to publish.
- Gap 2 (agentKnowledge): `preferredTool: query_fleet_ops` + keyMetrics + exampleQuestions + a gotcha added. The gotcha is deliberately honest: the H3 hex heatmap, per-hex dwell, and hour-of-day animation are client-side telemetry aggregates NOT modeled in SV_FLEET_OPS, so query_fleet_ops answers only trip/origin volume, not density.
- Effect: Gap 2 here mainly prevents the agent from misrouting density questions (it now says what it cannot answer) rather than unlocking new answers. Fully answering per-hex/per-hour density (Q2-Q5, Q11, Q13) needs a dedicated telemetry semantic view (future) plus Gap 4 table memos for the places/drivers tables.
- Revised tally: Yes=6, Partial=0, No=9 (unchanged); the block improves answer honesty, not coverage.
