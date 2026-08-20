# dwell_sla - SLA Alerts

## Summary

Purpose: Dwell sessions that breached SLA thresholds, by severity - filter by severity, review a detail table, and visualize breach locations on a map. Defined in `app-views.json:2466-2744`.

**Entities**: SLA breach events (dwell sessions exceeding threshold), vehicles/drivers, locations/facilities.

**Data source**: `FLEET_APP.DWELL.VW_SLA_ALERTS` (`app-views.json:2498,2509,2545,2571,2673,2731`).

**Areas** (5):
- `filter` (FilterBar) - severity dropdown (CRITICAL/WARNING). Emits `selected_severity` (`app-views.json:2491-2504`).
- `metrics` (MetricCards) - total alerts, critical count, warning count, avg minutes over threshold (`app-views.json:2506-2541`).
- `bystatus` (Chart) - bar chart: alerts by status (`app-views.json:2542-2567`).
- `table` (ClickableTable) - detail rows (driver, location, status, dwell_min, over_warning). Emits `selected_driver` (`app-views.json:2568-2598`).
- `detail` (Map) - two scatterplot layers colored by SLA status (`app-views.json:2599-2741`).

**Map layers** (2):
- `sla-breaches-all` - all breaches (filtered by severity + date), colored OK/WARNING/CRITICAL (`app-views.json:2633-2681`). No `clickEmits`.
- `driver-sla-stops` - selected driver's stops only (gated on `selected_driver` being set) (`app-views.json:2683-2740`). No `clickEmits`.

**Emits to viewState**: `selected_severity` (from FilterBar), `selected_driver` (from table row click).

**agentKnowledge** (`app-views.json:2470-2482`):
- `preferredTool`: "query_dwell"
- `keyMetrics`: ["total SLA alerts", "critical vs warning breaches", "average minutes over the threshold"]
- `exampleQuestions`: ["Which facilities breached SLA the most?", "How many critical dwell alerts this week?"]
- `gotchas`: "Dwell sessions are sessionized from position pings; a stop shorter than the SLA threshold is not counted as a breach."

## User questions & grounding gaps

| # | Question | Category | Answerable now? | Grounding source or gap | Suggested fix | Priority |
|---|----------|----------|----------------|------------------------|---------------|----------|
| 1 | How many SLA alerts are there? | Counting/aggregation | Partial | agentKnowledge.keyMetrics names "total SLA alerts" and preferredTool "query_dwell" can compute it, but the on-screen numeric value is not in any channel. Agent can tool-call to get the answer. | Acceptable via tool round-trip. Could optionally publish metric values to viewState memo for instant answers. | Low |
| 2 | How many critical vs warning breaches? | Comparison/breakdown | Partial | Same as above - agentKnowledge names the metric, preferredTool can query, but on-screen number not directly told. | Same - tool round-trip works. | Low |
| 3 | What severity filter is active? | Context/filter | Yes | Channel A viewState: `selected_severity=<value>` from FilterBar emit (`app-views.json:2500-2503`). | None needed. | - |
| 4 | Which driver is selected? | Per-entity detail | Yes | Channel A viewState: `selected_driver=<value>` from table emit (`app-views.json:2595-2597`). | None needed. | - |
| 5 | What are the details of the selected driver's breaches? | Per-entity detail | Partial | Agent knows `selected_driver=X` (Channel A) and can call query_dwell tool to get that driver's breach details. But the on-screen table row data (location, dwell_min, over_warning) is not directly in any channel. | Acceptable via tool. For instant answer, could add clickEmits on driver-sla-stops layer or publish table selection attrs. | Low |
| 6 | Which facilities breached SLA the most? | Ranking/superlatives | Partial | agentKnowledge.exampleQuestions includes this exact question and preferredTool "query_dwell" can answer it. Agent is prompted to use the tool. | Working as designed - tool round-trip. | - |
| 7 | What is the average minutes over threshold? | Counting/aggregation | Partial | agentKnowledge.keyMetrics names it; preferredTool can compute. On-screen value not told. | Tool round-trip. | Low |
| 8 | Where are the SLA breaches concentrated on the map? | Spatial/on-map | Partial | mapState provides featureCount for sla-breaches-all layer, bbox (viewport), and legend (OK/Warning/Critical labels). But no spatial clustering or location identity. Agent can see how many points and where the viewport is, but not which locations. | Add clickEmits to sla-breaches-all layer so user can click a point and agent sees attrs. Or add agentKnowledge noting the tool can query by location. | Med |
| 9 | Is the driver-sla-stops layer showing anything? | Map-state/rendering | Yes | Channel B mapState.layers[1] (driver-sla-stops) will show featureCount=0 and rendered=false/gated=true when no driver is selected, or featureCount>0 when active. | None needed. | - |
| 10 | What do the map colors mean? | Map-state/rendering | Yes | Channel B mapState.legend: ["OK", "Warning", "Critical"] (`app-views.json:2603-2631`). | None needed. | - |
| 11 | How has the SLA breach rate changed over time? | Time/trend | No | No time-series chart on this view. Data has SESSION_START timestamps so trend is computable, but not displayed or exposed. | agentKnowledge.exampleQuestions could include a time-based question; preferredTool query_dwell can answer. | Low |
| 12 | What region and date range am I looking at? | Context | Yes | Always-injected activeContext (route.ts:108-140). | None needed. | - |
| 13 | What is the worst individual breach (longest dwell over threshold)? | Ranking/superlatives | Partial | preferredTool query_dwell can answer. Table is sorted by MINUTES_OVER_WARNING DESC so top row is worst, but table data not in channel. | Tool round-trip works. | Low |
| 14 | Show me details of a specific breach point on the map | Per-entity detail | No | No clickEmits on either map layer (`app-views.json:2633-2740`). selectedFeature.attrs never populated. Tooltip shows name/sla/dwell_min but only client-side. | Add `clickEmits` to sla-breaches-all layer: `{object: "selected_breach", objectColumn: "name", lng: "lng", lat: "lat"}` with attrs (name, sla, dwell_min). | High |
| 15 | How many breaches are on the map vs total? | Counting/aggregation | Partial | mapState.layers[0].featureCount gives rendered count (capped at 5000). Total is via tool. Agent can compare featureCount to tool result. | Acceptable. | Low |
| 16 | What does "sessionized from position pings" mean? | Per-entity detail | Yes | agentKnowledge.gotchas explains this directly (app-views.json:2481). | None needed. | - |

## Notes

- This is the best-grounded of the four views: it has agentKnowledge (Channel C) with preferredTool, keyMetrics, exampleQuestions, and gotchas. It also has a map (Channel B) and interactive emits (Channel A).
- The main gap is the lack of `clickEmits` on map layers - users cannot click a breach point to get its details into the agent context. This is the single highest-impact fix for this view.
- Most data questions are "Partial" rather than "No" because the agent is told to use query_dwell and can get answers via tool round-trip. The on-screen numbers are not told directly, but the tool path works.
- The driver-sla-stops layer is gated on `selected_driver` - if no driver is selected, it will appear in mapState as gated/blank, which the agent can correctly diagnose.
- Grounding tally: Yes=6, Partial=8, No=2.
