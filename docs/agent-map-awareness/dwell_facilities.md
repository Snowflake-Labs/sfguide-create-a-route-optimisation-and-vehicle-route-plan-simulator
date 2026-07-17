# dwell_facilities - Facility Utilization

## Summary

Purpose: Dwell load by facility and facility type - where vehicles spend the most time. NO map. Defined in `app-views.json:2370-2464`.

**Entities**: Facilities/locations with dwell metrics (session count, avg/max dwell minutes, facility type).

**Data source**: `FLEET_APP.DWELL.VW_FACILITY_UTILIZATION` (`app-views.json:2385,2419,2443`).

**Areas** (3):
- `metrics` (MetricCards) - facilities count, total_visits, avg_dwell, max_dwell (`app-views.json:2382-2414`).
- `byfac` (Chart) - horizontal bar: top 12 facilities by total dwell minutes (`app-views.json:2416-2438`).
- `bytype` (Chart) - pie chart: visits by facility type (`app-views.json:2440-2463`).

**Map**: None. No map component, no mapState channel available.

**Emits to viewState**: None - no interactive selection components.

**agentKnowledge**: None (`app-views.json:2370-2373` has no agentKnowledge block).

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|----------------|------------------------|---------------|----------|
| 1 | How many facilities are tracked? | Counting/aggregation | No | Metric value (facilities count) from kpi query not in any channel. | Add agentKnowledge with keyMetrics and preferredTool (e.g., query_dwell). | High |
| 2 | What is the average dwell time across facilities? | Counting/aggregation | No | avg_dwell metric value not exposed. | agentKnowledge + preferredTool. | High |
| 3 | What facility has the longest total dwell? | Ranking/superlatives | No | Top-12 bar chart data not in any channel. Data exists in VW_FACILITY_UTILIZATION. | agentKnowledge with preferredTool + exampleQuestion. | High |
| 4 | What is the maximum single-session dwell recorded? | Counting/aggregation | No | max_dwell metric value not exposed. | agentKnowledge keyMetrics. | Med |
| 5 | What types of facilities do we have? | Per-entity detail | No | Pie chart data (facility_type breakdown) not in any channel. Data in VW_FACILITY_UTILIZATION.FACILITY_TYPE. | agentKnowledge preferredTool. | Med |
| 6 | Which facility type gets the most visits? | Ranking/superlatives | No | Pie chart values not exposed. | agentKnowledge preferredTool. | Med |
| 7 | Where are the busiest facilities located? | Spatial | No | No map on this view, no geographic data in any channel. VW_FACILITY_UTILIZATION may have location coords but view doesn't render them. | agentKnowledge.gotchas: "This view shows utilization metrics only. For geographic facility locations, see the SLA Alerts view map." | Low |
| 8 | What region is this scoped to? | Context | Yes | Always-injected activeContext (route.ts:108-140). | None needed. | - |
| 9 | How many total visits across all facilities? | Counting/aggregation | No | total_visits metric value not exposed. | agentKnowledge keyMetrics. | Med |
| 10 | Compare the top 3 facilities by dwell time | Comparison/breakdown | No | Chart data not in any channel. | agentKnowledge preferredTool. | Med |
| 11 | What vehicle type is this tracking? | Context | Yes | activeContext includes vehicle_type. | None needed. | - |
| 12 | Is there a facility exceeding a dwell threshold? | Per-entity detail | No | No threshold/alerting info in any channel. SLA thresholds exist in dwell_sla view but not here. | agentKnowledge.gotchas noting SLA breach info is in the SLA Alerts view. | Low |

## Notes

- This is a NO-MAP, NO-emits, NO-agentKnowledge view. The agent receives only activeContext (region, vehicle_type). It cannot answer any data question about what the view displays.
- Identical structural gap to dwell_overview: all three areas produce visual output but none feeds the agent.
- Highest-value fix: add an agentKnowledge block with `preferredTool: "query_dwell"`, keyMetrics: ["distinct facilities", "total visits", "avg dwell (min)", "max dwell (min)"], exampleQuestions, and a gotchas note about the lack of geographic data on this view.
- For spatial questions, the agent should be guided to either query the underlying data via tool or suggest navigation to the SLA Alerts view which has a map.
- Grounding tally: Yes=2, Partial=0, No=10.

## Post-fix update (Gap 1 + Gap 2 implemented)

- Gap 1 (kpi_memo): the MetricCards area publishes `__memo_metrics` carrying facilities, total_visits, avg_dwell, and max_dwell.
- Gap 2 (agentKnowledge): `preferredTool: query_dwell` + keyMetrics + exampleQuestions + a gotcha (utilization only, no geographic data; for facility locations use the SLA Alerts view).
- Now Yes via memo: Q1 (facilities), Q2 (avg dwell), Q4 (max dwell), Q9 (total visits). Now Yes via query_dwell: Q3 (longest total dwell), Q5 (facility types), Q6 (type with most visits), Q10 (compare top 3).
- Still No (no geography on this view): Q7, Q12 (both routed to the SLA Alerts view via the gotcha).
- Revised tally: Yes=10, Partial=0, No=2 (was 2/0/10).
