# dwell_overview - Dwell Overview

## Summary

Purpose: Fleet dwell-time analytics and SLA monitoring summary dashboard - top-line KPIs, daily trends chart, and top-10 facilities bar chart. NO map. Defined in `app-views.json:2260-2368`.

**Entities**: Dwell sessions (stops), vehicles/drivers, facilities/locations.

**Data sources**:
- `FLEET_APP.DWELL.VW_DWELL_SESSIONS` (metrics: total trips, avg dwell, SLA compliance, active drivers) - `app-views.json:2280`.
- `FLEET_APP.DWELL.VW_DAILY_TRENDS` (daily trend line chart) - `app-views.json:2316`.
- `FLEET_APP.DWELL.VW_FACILITY_UTILIZATION` (top 10 facilities bar chart) - `app-views.json:2347`.

**Areas** (3):
- `metrics` (MetricCards) - total_trips, avg_dwell, sla_frac (%), active_drivers (`app-views.json:2277-2311`).
- `trends` (Chart) - line chart: daily dwells + trips over last 30 days (`app-views.json:2313-2342`).
- `facilities` (Chart) - bar chart: top 10 facilities by visit count (`app-views.json:2344-2367`).

**Map**: None. No map component, no mapState channel available.

**Emits to viewState**: None - no interactive selection components (no ClickableTable, no FilterBar, no KPI emit).

**agentKnowledge**: None (`app-views.json:2260-2263` has no agentKnowledge block).

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|----------------|------------------------|---------------|----------|
| 1 | What is the average dwell time? | Counting/aggregation | No | Metric value from kpi query (avg_dwell) not in any channel. No agentKnowledge, no viewState memo, no map. | Add agentKnowledge with preferredTool (e.g., query_dwell) and keyMetrics listing avg dwell, SLA compliance, etc. | High |
| 2 | How many total dwell sessions are there? | Counting/aggregation | No | Same gap - metric value (total_trips) not exposed. | Same fix - agentKnowledge or viewState memo. | High |
| 3 | What is the SLA compliance rate? | Counting/aggregation | No | sla_frac metric value not in any channel. | agentKnowledge with keyMetrics. | High |
| 4 | How many active drivers are there? | Counting/aggregation | No | active_drivers metric not exposed. | agentKnowledge with keyMetrics. | High |
| 5 | What is the trend - are dwells increasing or decreasing? | Time/trend | No | Chart data (30-day daily totals) not in any channel. Agent cannot see the line chart values. | agentKnowledge with preferredTool that queries VW_DAILY_TRENDS, or publish a trend summary memo (e.g., "trending_direction=up/down"). | Med |
| 6 | Which facility has the most visits? | Ranking/superlatives | No | Top-10 bar chart data not in any channel. Data exists in VW_FACILITY_UTILIZATION. | agentKnowledge with preferredTool + exampleQuestion. | Med |
| 7 | What region and date range am I looking at? | Context | Yes | Always-injected activeContext (route.ts:108-140): region, vehicle_type, date_range_start, date_range_end. | None needed. | - |
| 8 | Where do vehicles dwell the longest (geographically)? | Spatial | No | No map on this view, no mapState. Data has location but this view does not render it. Could point to dwell_sla or dwell_facilities views. | agentKnowledge with exampleQuestions noting spatial queries should use query_dwell tool, or suggest navigating to dwell_sla. | Low |
| 9 | What vehicle type is this scoped to? | Context | Yes | activeContext includes vehicle_type (route.ts:125-129). | None needed. | - |
| 10 | How does today compare to last week? | Comparison/breakdown | No | No temporal comparison data in any channel. Raw data exists in VW_DAILY_TRENDS. | agentKnowledge preferredTool (query_dwell). | Low |
| 11 | What types of facilities are in the top 10? | Per-entity detail | No | Facility type not in this view's queries (only LOCATION_NAME, TOTAL_SESSIONS). Available in VW_FACILITY_UTILIZATION.FACILITY_TYPE. | agentKnowledge noting the dwell_facilities view has type breakdowns, or preferredTool. | Low |
| 12 | What does "SLA compliance" mean here? | Per-entity detail | No | Threshold logic (DWELL_MINUTES <= 30) visible in SQL (app-views.json:2280) but not exposed to agent. | agentKnowledge.gotchas: "SLA compliance = fraction of sessions with dwell <= 30 min." | Med |

## Notes

- This is a NO-MAP, NO-emits, NO-agentKnowledge view. The agent receives almost nothing beyond activeContext (region, vehicle_type, date range). Channel A viewState is empty (no interactive selections). Channel B mapState is absent (no map). Channel C agentKnowledge is absent.
- The view is essentially opaque to the agent - it cannot answer any data question about what is displayed.
- Single highest-value fix: add an agentKnowledge block with `preferredTool: "query_dwell"`, keyMetrics listing the four KPI names, exampleQuestions, and a gotchas note about the 30-min SLA threshold.
- Secondary fix: publishing metric values (total_trips, avg_dwell, sla_frac, active_drivers) as viewState memo fields (requires view-map.tsx extension for MetricCards to push values into panelViewState).
- Grounding tally: Yes=2, Partial=0, No=10.

## Post-fix update (Gap 1 + Gap 2 implemented)

- Gap 1 (kpi_memo): the MetricCards area publishes `__memo_metrics` carrying total_trips, avg_dwell, sla_frac, and active_drivers.
- Gap 2 (agentKnowledge): `preferredTool: query_dwell` + keyMetrics + exampleQuestions + a gotcha (SLA compliance = fraction of sessions at/under the 30-minute threshold; no map on this view).
- Now Yes via memo: Q1 (avg dwell), Q2 (total sessions), Q3 (SLA rate), Q4 (active drivers). Now Yes via query_dwell / gotcha: Q5 (trend), Q6 (top facility), Q10 (today vs last week), Q11 (facility types), Q12 (SLA definition).
- Still Partial (no map here): Q8 (spatial - route to SLA Alerts view or tool).
- Revised tally: Yes=11, Partial=1, No=0 (was 2/0/10), assuming SV_DWELL_ANALYTICS exposes the daily trend and facility breakdowns per its definition.
