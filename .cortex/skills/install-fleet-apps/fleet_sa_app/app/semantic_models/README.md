# Semantic models (Cortex Analyst) — FLEET_AGENT data layer

The consumer agent `FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_AGENT` answers analytical
questions via **Cortex Analyst** over the 10 native semantic views below (one
`cortex_analyst_text_to_sql` tool per view, wired in `../agent-spec.json`). These views
are authored and live in `FLEET_INTELLIGENCE.SEMANTIC`. This file records the agent's
data dependencies; the views themselves are managed Snowflake objects.

| Agent tool | Semantic view | Primary source schema |
|---|---|---|
| query_dwell | `FLEET_INTELLIGENCE.SEMANTIC.SV_DWELL_ANALYTICS` | `DWELL_ANALYSIS` |
| query_fleet_operations | `FLEET_INTELLIGENCE.SEMANTIC.SV_FLEET_OPERATIONS` | `SYNTHETIC_DATASETS.UNIFIED` (cross-DB) |
| query_route_deviation | `FLEET_INTELLIGENCE.SEMANTIC.SV_ROUTE_DEVIATION` | `ROUTE_DEVIATION` |
| query_asset_velocity | `FLEET_INTELLIGENCE.SEMANTIC.SV_ASSET_VELOCITY` | `ROUTE_OPTIMIZATION` |
| query_taxis | `FLEET_INTELLIGENCE.SEMANTIC.SV_TAXIS` | `FLEET_INTELLIGENCE_CAR` |
| query_food_delivery | `FLEET_INTELLIGENCE.SEMANTIC.SV_FOOD_DELIVERY` | `FLEET_INTELLIGENCE_EBIKE` |
| query_catchment | `FLEET_INTELLIGENCE.SEMANTIC.SV_CATCHMENT` | `CATCHMENT` |
| query_offers | `FLEET_INTELLIGENCE.SEMANTIC.SV_OFFERS` | `MARKETPLACE` |
| query_backload_matching | `FLEET_INTELLIGENCE.SEMANTIC.SV_BACKLOAD_MATCHING` | `BACKLOAD_MATCHING` |
| query_dhl_backload | `FLEET_INTELLIGENCE.SEMANTIC.SV_DHL_BACKLOAD` | `DHL_NTBO` |

The agent also has `data_to_chart` and the `ROUTING_MCP` routing tools (in `OPENROUTESERVICE_APP.ROUTING`) attached.

## Grants implication (3E)
A non-admin consumer role (`FLEET_APP_USER`) needs `USAGE` on each semantic view and
`SELECT` on the underlying tables/views — including the cross-database
`SYNTHETIC_DATASETS.UNIFIED.*` objects backing `SV_FLEET_OPERATIONS`.

## Reproducing the views (3G)
The views are recreated from `GET_DDL('semantic_view', '<name>')`. Full untruncated DDL
is dumped to a deploy artifact during Phase 3G (tier-C self-containment); see the deploy
pipeline. Validate each with the `semantic-view` skill / `call_cortex_analyst` against the
view name.
