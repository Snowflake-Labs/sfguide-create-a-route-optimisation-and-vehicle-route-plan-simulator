# fleetops_origins - Top Origins

## Summary

**Purpose:** Displays the busiest origin locations by trip volume - where journeys begin. Shows total origins, total trips from origins, average trip duration, and count of distinct location types.

**Entities:** Origin locations (POIs with trip counts), sourced from `FLEET_APP.FLEET_OPS.F_VW_TOP_ORIGINS_SCOPED(region, dataset_id, NULL)`.

**Map layers** (app-views.json:2834-2860):
- `origins` (scatterplot): up to 2000 origin dots sized/positioned by lat/lng, tooltip shows name, category, trips.

**Metrics** (app-views.json:2758-2791): MetricCards showing origins count, total trips, avg duration (min), location types count.

**Chart** (app-views.json:2793-2816): Bar chart of top 12 origins by trip count.

**Tables:** None (chart only).

**Slider/selection emits:** None. No `clickEmits` on map.

**agentKnowledge:** NOT present (app-views.json:2746-2864 - no `agentKnowledge` block).

**viewState keys:** Only context keys (region, vehicle_type, dataset_id). No panel-level selections or filters emit.

**mapState:** Layer `origins` with featureCount (row count up to 2000), legend label "Origin location". No clickEmits so `selectedFeature.attrs` never populates from map click.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | How many origin locations are there? | Counting | No | MetricCards show `origins` count but value is NOT in viewState or mapState. mapState.layers[0].featureCount gives capped row count (<=2000), not true total. | Publish MetricCards results as viewState field `_metrics_origins_count` (client-side memo after query). | High |
| 2 | How many total trips start from these origins? | Counting | No | MetricCards `trips` column not surfaced to agent. | Publish `_metrics_total_trips` in viewState. | High |
| 3 | What is the average trip duration? | Counting | No | MetricCards `avg_dur` column not surfaced. | Publish `_metrics_avg_dur` in viewState. | High |
| 4 | Which origin has the most trips? | Ranking | Partial | mapState.featureCount gives row count only; chart data (top 12 bar) is not in any channel. Agent could use `query_fleet_ops` tool if available, but on-screen value not told. | Add agentKnowledge with preferredTool; or publish top-N origin names+trips as compact viewState memo. | High |
| 5 | What are the top 5 origins by trip count? | Ranking | Partial | Same as #4 - data exists in chart query but not surfaced. preferredTool not declared. | Add agentKnowledge block with preferredTool="query_fleet_ops". | High |
| 6 | How many distinct location types are there? | Counting | No | MetricCards `types` not in any channel. | Include in metrics memo. | Med |
| 7 | What location types do origins belong to? | Per-entity | No | Only count of types in metrics; actual type names are in tooltip but not surfaced. | Publish distinct types list in agentKnowledge.keyMetrics or viewState memo. | Med |
| 8 | Where are the origins concentrated geographically? | Spatial | Partial | mapState.bbox tells viewport extent; legend confirms dots rendered. But no cluster summary or centroid. | Agent can describe bbox extent; for deeper spatial answer would need tool call. Low priority. | Low |
| 9 | Are there any origins on the map with zero trips? | Spatial | No | Query filters `TOTAL_TRIPS > 0` so none shown, but agent not told this. | Add gotchas to agentKnowledge: "Only origins with >0 trips are shown." | Low |
| 10 | What is the busiest area/neighborhood? | Spatial | No | No aggregation by area; only individual origin dots. | Would require H3 or cluster aggregation - new work. | Low |
| 11 | How does origin X compare to origin Y? | Comparison | No | Individual origin data not in any channel (only in tooltip/chart). | preferredTool could answer via SQL round-trip. | Med |
| 12 | Is there a trend in trip counts over time? | Time/trend | No | View has no time dimension; single snapshot. | Out of scope for this view - no fix needed. | Low |
| 13 | What layers are rendered on the map? | Map-state | Yes | mapState.layers array lists layer id, type, featureCount, rendered status. | N/A | N/A |
| 14 | Why is the map blank? | Map-state | Yes | mapState.emptyLayers would list blank layers; agent instructed to diagnose. | N/A | N/A |
| 15 | How many points are on the map? | Map-state | Yes | mapState.layers[0].featureCount (capped at 2000). | N/A (note: capped, not total) | N/A |

## Notes

- This view has NO `agentKnowledge` block - the agent receives no preferredTool, keyMetrics, exampleQuestions, or gotchas. This is the single biggest gap.
- No selections/emits exist so viewState only ever contains context keys (region, vehicle_type, dataset_id).
- MetricCards values (origins count, trips, avg duration, location types) are computed live but never published to any agent-visible channel.
- Chart data (top 12 origins by trips) is rendered visually but invisible to the agent.
- **Primary fix:** Add an `agentKnowledge` block and publish a compact metrics memo to viewState.
- **Counts:** Yes=3, Partial=3, No=9.

## Post-fix update (Gap 1 + Gap 2 implemented)

- Gap 1 (kpi_memo): the MetricCards area publishes `__memo_metrics` carrying origins count, total trips, avg duration, and location-types count.
- Gap 2 (agentKnowledge): `preferredTool: query_fleet_ops` + keyMetrics + exampleQuestions + a gotcha (only origins with >0 trips are shown; the map is capped at 2000 dots so featureCount is not the true total).
- Now Yes via memo: Q1 (origins count), Q2 (total trips), Q3 (avg duration), Q6 (location-types count). Now Yes via query_fleet_ops (SV top origins): Q4 (most trips), Q5 (top 5), Q7 (type names), Q11 (compare origins). Now Yes via gotcha: Q9 (zero-trip origins).
- Still Partial/No: Q8 (spatial concentration), Q10 (busiest neighborhood), Q12 (no time dimension).
- Revised tally: Yes=12, Partial=1, No=2 (was 3/3/9).
