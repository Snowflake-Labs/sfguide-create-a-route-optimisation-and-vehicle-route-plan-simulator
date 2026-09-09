# Agent verb coverage per dashboard view

Which SA app views a Cortex agent can answer **outside** the app (Snowflake CoWork,
`DATA_AGENT_RUN`, an evaluation run), and by what route.

This exists because "can the agent do what the dashboard does?" was repeatedly answered
by guesswork. The answer is mostly yes, and the exceptions are specific. Re-derive this
table rather than assuming, whenever a view is added: the sources of truth are
`fleet_sa_app/app/app-views.json`, `fleet_sa_app/ui/src/lib/packs/fleet/pack-views.json`,
and the verb allowlists in `ui/src/app/api/tool/route.ts` and `ui/src/app/api/ops/route.ts`.

## Why a view can be agent-reachable at all

Three distinct routes, in descending preference:

1. **A Cortex Analyst tool** (`query_*`) over a semantic view. Governed, and the metric
   definition stays in one place. This is what `agentKnowledge.preferredTool` names.
2. **`run_sql`** - one read-only capped statement. Covers anything a semantic view does
   not model, including the routing contract (`ROUTING_PLATFORM.CONTRACT.*`), since
   `FLEET_APP_USER` holds USAGE on those functions.
3. **A synapse verb** - required when the feature is *computation*, not a query: building
   a VROOM challenge, solving it, scoring the result.

A view whose panels are pure SQL over the `FLEET_APP` contract needs no verb: routes 1
and 2 already reach its data. A view that computes something needs route 3, or the agent
can only describe the inputs.

## Declarative views (`app-views.json`, 19)

All render through the generic engine, which issues their SQL via `/api/query` against
the neutral `FLEET_APP` contract. No bespoke server compute, so all are reachable.

| View | Category | Preferred tool |
|---|---|---|
| `live_asset_operations` | Core | `query_fleet_ops` |
| `journey_inspector` | Core | `query_fleet_ops` |
| `responsible_party_performance` | Core | `query_fleet_ops` |
| `space_time_density` | Core | `query_fleet_ops` |
| `plan_vs_actual_performance` | Core | `query_route_deviation` |
| `dispatch_execution_board` | Core | `query_fleet_ops` |
| `safety_risk_scorecard` | Core | none (`run_sql`) |
| `dwell_overview` | Core | `query_dwell` |
| `dwell_facilities` | Core | `query_dwell` |
| `dwell_sla` | Core | `query_dwell` |
| `delivery_sync` | Core | `query_delivery_sync` |
| `fleetops_origins` | Core | `query_fleet_ops` |
| `catchment` | Location | `catchment` (verb) |
| `site_impact` | Location | `query_location` |
| `sourcing_optimizer` | Location | `query_sourcing` |
| `mix_sourcing` | Location | `query_sourcing` |
| `closure_impact` | Location | `query_location` |
| `asset_velocity` | Asset Pool | `query_asset_velocity` |
| `sap_binding` | Help | `search_sap_binding` |

`safety_risk_scorecard` deliberately declares no `preferredTool` - no semantic view models
event severity, so `run_sql` is the honest route. Per Tenet 10, omitting `preferredTool`
is correct there; pointing it at a semantic view that does not model the data would be
worse than leaving it out.

## Pack-registered views (`pack-views.json`, 6)

These carry bespoke server compute, so each needs checking individually.

| View | App calls | Agent route |
|---|---|---|
| `vrp_simulator` | `/api/tool` | Covered - `optimize_routes` |
| `emergency_response` | `/api/query`, `/api/tool`, `/api/ops` | Covered - `evac_seed` + `evac_solve` |
| `ops_console` | `/api/ops` | Covered - ops bundle verbs |
| `backload_matching` | `/api/query`, `/api/backload/solve`, `/api/backload/decide` | `backload_solve` (+ inputs via `query_backload`) |
| `backload_proposals` | `/api/query`, `/api/backload/solve` | `backload_solve` |
| `triangle_proposals` | `sfRead` -> `/api/query`, `MATRIX_TABULAR` in SQL | `backload_chain_solve` |

`/api/tool` and `/api/ops` are **verb dispatchers**, not bespoke logic: they `CALL` a
synapse proc from an allowlist with a checked arity, and optionally bind the trailing
`IDEMPOTENCY_KEY`. So `vrp_simulator`, `emergency_response` and `ops_console` were already
at parity by construction - the app and the agent invoke the same procedure. This is the
pattern the backload views should follow, and the reason step 5 of the parity work
repoints them at `/api/tool` rather than growing a second implementation.

## What is deliberately NOT exposed

**The inherited SA-framework scaffolding.** `/api/write`, `/api/workflow/execute`,
`/api/workflow/resume` and `/api/mcp` come from the upstream Solution Accelerator
template, not from this solution. `ui/src/lib/workflow/app-workflows.ts` registers
`campaignSetupWorkflow` and `campaignExecutionWorkflow`, and `/api/mcp` advertises
`lookup_entity` / `propose_write` / `execute_workflow`. The `entity_detail`,
`workflow_manager` and `workflow_detail` areas belong to that template. Exposing them as
fleet verbs would ship a CDP demo's capability as if it were fleet capability. Leave them.

**Interaction that no verb can carry.** Multi-layer maps (12 of 16 map areas, up to 8
layers), layer toggling, time-window replay, click-through to a record. `data_to_map` is
host-injected, Snowflake-Intelligence-only, and renders **one layer per map**, so it
cannot reproduce a composite. The sanctioned answer is to report the figures and
`deep_link` into the view - which is what every agent spec already instructs. An agent
claiming to have drawn a composite map is a defect, not a feature gap.

## Adding a view

1. If its panels are SQL over `FLEET_APP`, you are done - name a `preferredTool` when a
   semantic view models the data, otherwise leave it out and let `run_sql` serve it.
2. If it computes something, put the computation in a shared framework-agnostic module,
   expose it as a verb, and have the app call the verb. Never a second implementation:
   two copies drift, and only one of them is audited by the synapse envelope (Tenet 7).
3. Add the routing line to every agent spec whose `mcp_servers` includes that bundle -
   `scripts/check_agent_verb_coverage.py` fails otherwise, and an unguided verb is either
   ignored or preferred over a better tool.
4. Update this table.
