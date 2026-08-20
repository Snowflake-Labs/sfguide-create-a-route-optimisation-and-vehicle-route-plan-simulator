# Agent Map-Awareness Audit - Summary

Read-only catalog of the questions a real user would ask on each FLEET_SA_APP view,
classified against what the left-panel Cortex agent can actually answer from its
current grounding. This is analysis only; no app code/config was changed.

## How the agent is grounded (three channels)

Injection point: `.cortex/skills/install-fleet-apps/fleet_sa_app/ui/src/app/api/chat/route.ts`.

- Channel A - viewState summary (`route.ts:36-42`): active view's viewState flattened to
  `key=value`, non-null scalars only. Config views publish `{...context, ...panelViewState}`
  (`view-map.tsx:331-334`) = region/vehicle/dataset/date-range plus scalar selection/toggle/filter
  keys. Never carries table rows, KPI numbers, or chart data.
- Channel B - mapState (`route.ts:58-92`; built in `view-map.tsx:455-498`): per-layer
  featureCount (row count only), type, colorBy, rendered/gated; plus emptyLayers, bbox, selection,
  legend labels, and ONE `selectedFeature` (bounded scalar attrs, max 20 keys) that only populates
  when the view has `clickEmits` and the user map-clicks a matching feature.
- Channel C - agentKnowledge (`route.ts:44-50`): static per-view hints
  (preferredTool/keyMetrics/exampleQuestions/gotchas), present only when the view JSON has an
  `agentKnowledge` block. A `preferredTool` lets the agent query the data via a Cortex Analyst /
  MCP round-trip (but the agent is never told the exact on-screen value).

Also always injected: activeContext region/vehicle/dataset/date (`route.ts:108-140`) and the
availableViews link list (`route.ts:93-97`).

The gold-standard `emergency_response` view (reference baseline, not re-audited) shows the target
quality bar: it computes a client-side memo, serializes bounded pre-joined strings (risk_bands,
addresses_by_band, hazard_zones, participants_by_county, centers_workload, total_km, etc.) into
viewState, and carries a rich agentKnowledge block. See its registration in
`ui/src/lib/packs/fleet/index.ts:29-61` and component
`ui/src/components/views/areas/emergency-response.tsx`.

## Per-view rollup

| View | Label | Map | agentKnowledge | clickEmits | Yes | Partial | No |
|------|-------|-----|----------------|------------|-----|---------|-----|
| emergency_response | Emergency Response | yes | yes (rich) | n/a (custom) | reference baseline (gold standard) | | |
| live_asset_operations | Live Operations | yes | yes | no | 6 | 11 | 1 |
| journey_inspector | Journey Inspector | yes | yes | no | 12 | 6 | 2 |
| responsible_party_performance | Performance | yes | yes | no | 12 | 5 | 1 |
| space_time_density | Space-Time Density | yes | yes | no | 6 | 0 | 9 |
| plan_vs_actual_performance | Plan-vs-Actual | yes | yes | no | 7 | 6 | 2 |
| dispatch_execution_board | Dispatch Board | yes | yes | no | 9 | 0 | 7 |
| safety_risk_scorecard | Safety / Risk Scorecard | yes | yes | no | 7 | 2 | 6 |
| dwell_overview | Dwell Overview | no | yes | n/a | 11 | 1 | 0 |
| dwell_facilities | Facility Utilization | no | yes | n/a | 10 | 0 | 2 |
| dwell_sla | SLA Alerts | yes | yes | no | 6 | 8 | 2 |
| fleetops_origins | Top Origins | yes | yes | no | 12 | 1 | 2 |
| catchment | Catchment | yes | yes | yes | 5 | 9 | 2 |
| site_impact | Site Impact | yes | yes | no | 7 | 11 | 2 |
| closure_impact | Closure Impact | yes | yes | no | 7 | 11 | 2 |
| asset_velocity | Asset Velocity | yes | yes | no | 14 | 2 | 2 |
| sap_binding | SAP Binding | no | yes | n/a | 8 | 0 | 4 |
| ops_console | Ops Console | no (custom) | no | n/a | 0 | 2 | 13 |
| vrp_simulator | Route Optimization Simulator | yes (custom) | no | n/a | 0 | 1 | 19 |
| **Totals** | (18 audited views) | | | | **139** | **76** | **78** |

293 questions catalogued across 18 views (emergency_response counted as baseline only).

**Pre-fix:** Roughly 28% Yes, 33% Partial, 39% No - the agent could not fully answer about
two-thirds of what a user would ask about the screen.

**Post-fix (Gap 1 + Gap 2 implemented):** Roughly 47% Yes, 26% Partial, 27% No. See the
"Post-fix status" section below. These totals are a conservative lower bound: they re-tally only
the 9 views that gained an agentKnowledge block, and do not re-count the additional Gap 1
kpi_memo gains on the 6 views that already had agentKnowledge (live_asset_operations,
plan_vs_actual_performance, dwell_sla, catchment, site_impact, closure_impact), which also now
carry their exact on-screen KPI values.

### Best-grounded

- `sap_binding` (8/0/4) - the search_sap_binding tool answers most content questions; remaining
  No's are out-of-scope live status questions.
- `site_impact` / `closure_impact` (7/11/2) - good agentKnowledge + slider values in viewState.
- `plan_vs_actual_performance` (7/6/2) - only config view whose agentKnowledge names a preferredTool.

### Worst-grounded

- `vrp_simulator` (0/1/19) - custom view that publishes NOTHING to any channel; total blind spot.
- `ops_console` (0/2/13) - custom view fetching rich live platform data every ~15s, publishes none.
- `dwell_overview` / `dwell_facilities` (2/0/10) - no map, no emits, no agentKnowledge; agent sees
  only region/vehicle context.
- `dispatch_execution_board` (5/1/10) and `space_time_density` (6/0/9) - map views with rich KPIs /
  tables / charts, none of which reach the agent, and no agentKnowledge block.

## Top cross-view gaps (ranked) and shared fixes

1. **KPI / MetricCards values never reach any channel (systemic, affects ~13 views).**
   Every config view computes headline metrics (active entities, empty miles %, dwell breaches,
   utilization, deviation %, etc.) but none serialize the result anywhere. The agent can only
   quote them via a preferredTool round-trip (and only where one is configured), so its answer can
   diverge from what is on screen. This is the single largest cluster of Partial gaps.
   Shared fix: extend the generic `MetricCards` area / `view-map.tsx` to auto-publish the computed
   metric values as a bounded `kpi_memo` viewState string (client-side, cheap, one code change that
   helps every config view). High priority.

2. **Missing agentKnowledge blocks (9 config views: journey_inspector,
   responsible_party_performance, space_time_density, dispatch_execution_board,
   safety_risk_scorecard, dwell_overview, dwell_facilities, fleetops_origins, asset_velocity).**
   With no `preferredTool`, the agent has no routing hint and often cannot even reach the data via a
   tool. Cheapest possible fix (pure JSON edit in `app-views.json`): add an agentKnowledge block
   with `preferredTool` (query_fleet_ops / query_route_deviation / query_dwell / SV_FLEET_OPS as
   appropriate) plus keyMetrics + exampleQuestions + gotchas. High priority, low cost.

3. **No `clickEmits` on map layers (all map views except catchment).**
   `selectedFeature.attrs` therefore never populates from a map click, so "tell me about the one I
   clicked / this flagged stop / this breach point" is stuck at Partial or No. Table selection sets
   `selection` (a scalar) but not the feature attrs. Shared fix: add `clickEmits` to the primary
   point/choropleth layer on each map view so a click surfaces a bounded attribute snapshot
   (JSON-only edit; catchment already demonstrates the pattern at `app-views.json:2947`).
   Medium priority.

4. **Table row data is invisible (all ClickableTable views).**
   Only the selected rowKey scalar reaches the agent via `emits`; the visible rows (top drivers,
   worst routes, flagged facilities, offer list) are never sent. "List / rank the ones on screen"
   is consistently No unless a preferredTool can recompute it. Shared fix: publish a bounded
   pre-joined `table_memo` (top N rows, key columns) as a viewState string, or rely on gap #2's
   preferredTool. Medium priority.

5. **Custom views publish nothing (vrp_simulator, ops_console).**
   These are the worst-grounded views but the cheapest to fix, because a custom component can call
   `updateViewState` / `onStateChange` / `setMapState` freely (exactly what emergency_response
   does). Fix: compute a bounded memo from the already-in-memory solve result / live platform state,
   publish via onStateChange + setMapState, and add an agentKnowledge block to the registration.
   High priority (vrp_simulator especially, being a flagship demo view).

6. **Live-ORS analytic values are computed per interaction and not persisted (catchment,
   site_impact, closure_impact, emergency_response).**
   As with emergency_response, the on-screen numbers exist only client-side and there is no SQL /
   verb to recover the exact rendered set. These views must follow the memo-to-viewState pattern
   rather than relying on a tool round-trip. Medium/High priority per view.

### The single highest-leverage change

`mapState.featureCount` is the only numeric signal that is reliably present, which is why
"how many features are on the map" is the one consistently-Yes counting class everywhere. Making
the generic `view-map.tsx` / `MetricCards` renderer auto-publish computed KPI values (gap #1) plus
adding agentKnowledge blocks to the nine views missing them (gap #2) would together convert the
large majority of Partial/No config-view questions to Yes with no per-view custom code.

## Post-fix status (Gap 1 + Gap 2 implemented)

Two shared fixes have been implemented and deployed:

- **Gap 1 - KPI memo (code):** the generic `MetricCardsArea` now publishes each view's computed
  headline metrics as a bounded, per-area `__memo_<areaName>` viewState string; `route.ts`
  Channel A renders those under an "On-screen metric values:" label instead of lumping them into
  "Active filters:". `view-renderer.tsx` threads the area name so a view with two MetricCards
  areas (journey_inspector) does not clobber a sibling memo. One code change upgrades all 13
  MetricCards views. (`metric-cards.tsx`, `view-renderer.tsx`, `chat/route.ts`.)
- **Gap 2 - agentKnowledge (config):** the 9 config views that lacked it now have an
  agentKnowledge block with verified `preferredTool` + keyMetrics + exampleQuestions + gotchas.
  `safety_risk_scorecard` intentionally OMITS `preferredTool` because safety events are not
  modeled in any semantic view; `dispatch_execution_board` keeps `query_fleet_ops` as a weak
  hint but its gotcha states work-item status / plan adherence are not in the SV.

Remaining gaps (not in this pass): Gap 3 (clickEmits on map layers), Gap 4 (table_memo for
Clickable tables), Gap 5 (custom views vrp_simulator / ops_console publish nothing), Gap 6
(live-ORS analytic memos). Follow-up SV recommendation: a dedicated safety-event semantic view
would unlock event-type rankings and trends for safety_risk_scorecard and journey_inspector.

## Files in this folder

One markdown file per audited view (18), plus this summary. Each per-view file lists 12-20
realistic user questions with per-question grounding classification, the exact grounding source or
gap (cited to file:line), a suggested fix, and a priority.
