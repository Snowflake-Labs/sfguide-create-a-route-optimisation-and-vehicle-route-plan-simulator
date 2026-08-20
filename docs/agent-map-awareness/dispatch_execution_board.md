# dispatch_execution_board - Dispatch Execution Board

## Summary

**Purpose:** Manage scheduled work items against plan - shows a jobs list, resource utilization chart, and planned-vs-actual timeline by day.

**Data entities:** Work items (`F_FACT_WORK_ITEM_SCOPED`), journeys (`F_FACT_JOURNEY_SCOPED`), plans (`F_DIM_PLAN_SCOPED`), sites (`F_DIM_SITE_SCOPED`).

**Map layers:**
- `dest-sites` (type: scatterplot, line 1926-1948) - Blue dots for destination sites, sized uniformly (radius 200m), tooltip shows site name and job count. Data: destination sites with aggregated job count.
- `entity-actual` (type: path, line 1951-1971) - Red actual route path for the selected entity's journeys. Gated on `selected_entity IS NOT NULL`.

**Key metrics (KPI MetricCards, line 1828-1863):**
- scheduled (total work items count)
- entities (distinct entity count)
- operators (distinct operator count)
- dest_sites (distinct destination site count)

**Tables:**
- `jobs` (ClickableTable, line 1865-1896): Top 100 work items with job_id, entity, operator, origin, destination, planned_start, status. Exception-first sorting (MISSED, LATE, DELAYED first).

**Charts:**
- `resource` (Chart/bar, line 1975-2000): Jobs per entity (top 12).
- `timeline` (Chart/area+line, line 2002-2034): Planned vs Actual count by day.

**Filters/selection emits:**
- `selected_entity` (from ClickableTable row click, line 1894-1896): used by the path layer to show that entity's actual routes on the map.

**agentKnowledge:** None (app-views.json:1816 - no agentKnowledge block).

**clickEmits on map:** None - no selectedFeature will be populated.

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|-----------------|-------------------------|---------------|----------|
| 1 | How many scheduled jobs are there? | Counting | No | KPI card computes `scheduled` count (line 1831) but the value is never in viewState or mapState. No agentKnowledge or preferredTool exists. | Publish KPI values as viewState memo fields (e.g. `kpi_scheduled=42, kpi_entities=8`). Add agentKnowledge with preferredTool for deeper queries. | High |
| 2 | How many vehicles/entities are involved? | Counting | No | Same gap - KPI `entities` value not in any channel. | Same fix as #1. | High |
| 3 | How many operators are assigned? | Counting | No | KPI `operators` value not forwarded. | Same fix as #1. | High |
| 4 | How many destination sites are there? | Counting | No | KPI `dest_sites` value not forwarded. mapState.layers[0].featureCount for dest-sites gives the number of distinct map points (site-level aggregation), which equals dest_sites. | Partial via mapState featureCount of "dest-sites" layer (route.ts:69). But agent does not know the layer represents "destination sites" without agentKnowledge. Add agentKnowledge hint. | Med |
| 5 | Which entity is currently selected? | Per-entity detail | Yes | Channel A: viewState includes `selected_entity=<id>` when table row clicked (emits line 1895, route.ts:38-42). | - | - |
| 6 | What are the recent jobs and their statuses? | Per-entity detail | No | Jobs table data (100 rows with status, entity, operator, origin, destination) never reaches agent. Only `selected_entity` is forwarded. | Publish `jobs_status_summary` memo (pre-joined: "N scheduled, M missed, K late") from the loaded table data. | High |
| 7 | Are there any missed or late jobs? | Counting | No | Exception statuses (MISSED, LATE, DELAYED) are in the table but not summarized to agent. | Same fix as #6 - status breakdown memo. | High |
| 8 | Which entity has the most jobs? | Ranking | No | Resource bar chart data (top 12 entities by job count) is not in any channel. | Publish `top_entity_by_jobs` memo from chart data row #1. | Med |
| 9 | How many destination sites are shown on the map? | Counting | Yes | Channel B: mapState.layers[0].featureCount for "dest-sites" (route.ts:69). | - | - |
| 10 | Is the entity's actual route showing on the map? | Map-state/rendering | Yes | Channel B: mapState.layers[1] ("entity-actual") rendered/featureCount. If selected_entity is null, featureCount=0 and layer appears in emptyLayers (route.ts:72-76). | - | - |
| 11 | What does the legend say? | Map-state/rendering | Yes | Channel B: mapState.legend = ["Destination site", "Selected route (actual)"] (route.ts:89, config line 1902-1922). | - | - |
| 12 | How does planned compare to actual today/this week? | Time/trend | No | Timeline chart (planned vs actual by day) data not in any channel. No preferredTool to query it. | Publish `timeline_summary` memo (e.g. "planned=15, actual=12 today") or add agentKnowledge.preferredTool. | Med |
| 13 | Which site receives the most jobs? | Ranking | No | Dest-sites layer data has per-site job counts (in tooltip: `{jobs}`) but individual rows not forwarded. | Publish `top_site_by_jobs` memo from dest-sites layer top-1 row. | Med |
| 14 | What is the busiest day in the period? | Time/trend | No | Timeline chart has per-day planned/actual counts but not in any channel. | Add agentKnowledge.preferredTool or publish a memo. | Low |
| 15 | What is the overall plan adherence rate? | Comparison | No | Not computed anywhere on screen. Would need planned total vs actual total (timeline data). | Add to agentKnowledge as a keyMetric; add preferredTool. | Med |
| 16 | What are the details of the selected entity's routes? | Per-entity detail | Partial | Agent knows selected_entity (Channel A). Map shows routes (Channel B: featureCount of entity-actual > 0). But journey details (distance, duration, stops) are not in any channel. | If selected_entity is set, publish `selected_entity_route_count` memo. For full details, add a preferredTool. | Med |

## Notes

- This view has NO agentKnowledge block, leaving the agent with no tool routing hint. It cannot answer any data-value question from grounding alone.
- The KPI MetricCards compute 4 useful aggregate values (scheduled, entities, operators, dest_sites) that are rendered on screen but completely invisible to the agent.
- The jobs table (100 rows with rich status/assignment data) and the two charts (resource utilization, planned-vs-actual timeline) are all opaque to the agent.
- The only scalar the agent receives from user interaction is `selected_entity` (Channel A) and the map layer metadata (Channel B).
- Recommended fixes in priority order: (1) Add an `agentKnowledge` block with `preferredTool` for work-item queries and `keyMetrics` listing scheduled count, adherence rate, exception count. (2) Publish KPI values and a status-breakdown memo as viewState fields. (3) Publish top-entity and timeline summaries as bounded memo strings.

## Post-fix update (Gap 1 + Gap 2 implemented)

- Gap 1 (kpi_memo): the MetricCards area publishes `__memo_kpi` carrying scheduled, entities, operators, and dest_sites counts.
- Gap 2 (agentKnowledge): `preferredTool: query_fleet_ops` kept as a weak hint + keyMetrics + exampleQuestions + a gotcha stating work-item status (MISSED/LATE/DELAYED), plan adherence, and planned-vs-actual-by-day are NOT in any SV (no work-item/plan semantic view exists).
- Now Yes via memo: Q1 (scheduled), Q2 (entities), Q3 (operators), Q4 (destination sites).
- Still No (need Gap 4 table/status memo or a work-item SV): Q6, Q7, Q8, Q12, Q13, Q14, Q15; Q16 stays Partial.
- Revised tally: Yes=9, Partial=0, No=7 (was 5/1/10).
