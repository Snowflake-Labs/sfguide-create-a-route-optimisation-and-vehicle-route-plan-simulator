# Fleet Intelligence — Solution Accelerator app (Step 2)

This is the Fleet Intelligence app built on the Solution Accelerator (SA) host, migrated from
the ORS control app per the Step 2 plan
(`.snowflake/cortex/plans/step2-sa-synapse-three-skills.plan.md`).

Everything for Step 2 lives in THIS work repo (vendored), on branch `feature/sa-synapse-app`.
The SA repo (`solution-accelerator`) and `synapse` repo are read-only references/source.

## Layout

```
fleet_sa_app/
  app/                      # the SA "app bundle" (config consumed by the host)
    app.yaml                # app identity (reverse-DNS id, version, tags)
    app-config.json         # name/desc, snowflake db.schema, region+vehicle contextBar
    install.json            # logical user/ops/admin role binding (Native App, Phase 2F)
    views/                  # per-view YAML dashboards (added in Phase 2B)
  ui/                       # vendored SA Next.js host (Next 15 / React 19)
    src/app/api/region/     # NEW: hybrid region/vehicle CONFIG-write endpoint (Phase 2A)
    src/components/context-bar.tsx  # NEW: region/vehicle enum pickers (Phase 2A)
    .npmrc                  # vendored: points @snowflake/* at internal Artifactory
```

## Region / vehicle context (Hybrid)

The header context bar drives both halves of the "Hybrid" decision:
1. Client: sets store `context.<id>` (`region`, `vehicle_type`). Any dashboard view whose
   `params` reference `context.region` / `context.vehicle_type` auto-refetches. This replaces
   the old `refetchOn` mechanism.
2. Server: POSTs `/api/region`, which `UPDATE`s `FLEET_INTELLIGENCE.<schema>.CONFIG`
   (`REGION`, `VEHICLE_TYPE`) so projection views (`SELECT REGION FROM CONFIG`) and the
   routing tool layer observe the same active context.

Target schemas for the CONFIG write are allowlisted in the route (env `FLEET_CONFIG_SCHEMAS`,
default `DWELL_ANALYSIS,ROUTE_DEVIATION,ROUTE_OPTIMIZATION`). Schema names are validated, never
interpolated from raw input.

## Running locally

The vendored host depends on `@snowflake/stellar-*` packages that are NOT on public npm — they
resolve via Snowflake's internal Artifactory (see `ui/.npmrc`). Installing therefore requires
network access + auth to that registry.

```bash
cd ui
npm install                                  # public npm only
APP_CONFIG=../app/app-config.json \
APP_VIEWS_CONFIG=../app/app-views.json \
AGENT_MODE=agent-object \
AGENT_DATABASE=FLEET_INTELLIGENCE \
AGENT_SCHEMA=SYNAPSE_USER \
AGENT_NAME=FLEET_AGENT \
SNOWFLAKE_ACCOUNT_URL=https://pm-fleet-test.snowflakecomputing.com \
SNOWFLAKE_PAT=<pat> \
SNOWFLAKE_WAREHOUSE=MY_WH \
SNOWFLAKE_ROLE=ACCOUNTADMIN \
npm run dev
```

The chat uses **agent-object mode** pointed at `FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_AGENT`
(created in Phase 2D), which exposes the routing tools via the `FLEET_USER_MCP` server. Routing
tool results render as deck.gl maps in chat via the inline registry (`get_directions`,
`optimize_routes`, `compute_isochrone`, `find_poi`, `pharma_catchment` -> `RouteMapInline`).

`app-views.json` lives at `app/app-views.json` (the two ported dashboards).

## Status

- Phase 2A (done): vendored host, app bundle, hybrid region context, role declarations.
- Phase 2B (done, build-verified): public-npm build (stellar deps removed); deck.gl Map area + CARTO tile proxy (`/api/tiles`); `area`/`pie`/`scatter` chart types; `Slider` + `ClickableTable` parity widgets; two ported dashboards (`dwell_overview`, `dwell_congestion`) in `app/app-views.json`, all four queries validated on wgb26798.
- Phase 2C+: synapse User + Admin tool bundles (per-bundle MCP servers); agent wiring (analyst/SVs deferred to Step 3); Tier-3 showcases; Native App packaging.

### Translation rules (SA data tap)
- `/api/query` LOWERCASES all column keys -> view configs reference lowercase columns.
- `/api/query` sends NO default db/schema -> queries MUST be fully qualified (`FLEET_INTELLIGENCE.<schema>.<table>`).
- Region/vehicle refetch (hybrid): each area's `data.params` references `context.region` + `context.vehicle_type`; changing the contextBar updates the store (auto-refetch) AND POSTs `/api/region` to update server-side CONFIG. Params absent from SQL are harmless and still trigger refetch.

### Map area (deck.gl)
- Pure layers ported from the control app: `ui/src/lib/map/{layer-spec,layer-compiler,map-fit}.ts`. Runtime: `areas/map-view.tsx` (DeckGL + CARTO basemap via `/api/tiles`), `areas/view-map.tsx` (SA area, per-layer `useViewData`).
- Requires the full deck.gl 9.2.x suite (core, layers, geo-layers, mesh-layers, aggregation-layers, extensions, react, widgets) + `h3-js` — all public npm.
