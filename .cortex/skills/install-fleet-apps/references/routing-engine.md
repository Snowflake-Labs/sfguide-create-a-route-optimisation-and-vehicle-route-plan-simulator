# Routing engine: detect + delegate (build-routing-solution is secondary)

This skill OWNS the neutral routing seam `ROUTING_PLATFORM.CONTRACT.*`
(`routing_platform/setup.sql`, applied by the orchestrator). Consumers and the
synapse User verbs bind to that contract, never to a named engine — so the live
ORS/VROOM engine is a swappable provider behind the seam (TENETS.md tenet 1).

The ORS engine itself (the ORS/VROOM/gateway/downloader SPCS services, region
graphs, matrix builders) is the one piece this installer does NOT own. It is
heavy, specialized substrate provided by `build-routing-solution`, which is now
the **secondary, delegated** component.

## Detection (run by install_fleet_apps.sh, layer 3)

```sql
-- contract present?
SELECT SYSTEM$WAIT(0);                 -- no-op; contract applied first
-- engine services present + running?
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;  -- expect ORS_SERVICE_* + ROUTING_GATEWAY_SERVICE
```

Outcomes:

| Engine state | Result |
|---|---|
| Services present | Routing verbs are LIVE (directions, isochrones, optimization, matrix, find_poi, catchment). |
| Absent | Routing verbs install but are INERT. Analytics dashboards + Cortex Analyst + agents are UNAFFECTED. |

## Delegation (enable live routing)

When the engine is absent and live routing is wanted, provision it via the
secondary skill (no re-implementation here):

```
Read and follow .cortex/skills/build-routing-solution/SKILL.md
```

Provision a region, then re-run `install_fleet_apps.sh` (idempotent) — layer 3
will detect the engine and the verbs become LIVE. Nothing else re-installs.

## What survives if build-routing-solution is deleted

| Capability | Survives? |
|---|---|
| SA app + Admin console UI, dashboards, Cortex Analyst | Yes |
| FLEET_APP data contract, packs, roles, agents, synapse MCP servers | Yes |
| Routing contract seam (`ROUTING_PLATFORM.CONTRACT`) | Yes (owned here) |
| LIVE routing verbs (directions/isochrone/VRP/matrix) | No — need an engine provider |
| Dynamic data generation (Data Studio) | No — use the static agnostic seed (`references/seed-data.md`) |

Closing the last two gaps (fully absorbing the ORS substrate so the engine
needs no build-routing-solution) is the optional Phase C in the plan; it is
deferred until the legacy control app is actually retired.
