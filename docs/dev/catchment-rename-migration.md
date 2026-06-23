# Catchment Rename — Live Deploy Runbook

One-time migration for the "generalize-industry-verbs" change (branch
`feature/sa-synapse-app`). The repo source is already correct for a **fresh**
deploy; this runbook is only for migrating an **existing** account that still
has the old `pharma`/`RETAIL_CATCHMENT` objects.

## Rename map

| Old | New |
|---|---|
| `TOOL_PHARMA_CATCHMENT` | `TOOL_CATCHMENT` (arg `PHARMACY_DESCRIPTION` -> `SITE_DESCRIPTION`) |
| `TOOL_PHARMA_OPTIMIZATION` | `TOOL_DELIVERY_OPTIMIZATION` |
| `TOOL_SUPPLY_CHAIN` | `TOOL_NETWORK_OPTIMIZATION` |
| `SV_RETAIL_CATCHMENT` | `SV_CATCHMENT` |
| schema `FLEET_INTELLIGENCE.RETAIL_CATCHMENT` | `FLEET_INTELLIGENCE.CATCHMENT` |
| table `…RETAIL_CATCHMENT.RETAIL_POIS` | `…CATCHMENT.POIS` |
| demo tables `SF_PHARMA_JOBS` / `SF_HEALTH_DEMOGRAPHICS` / `SF_DRUG_FORMULARY` / `SF_TOP_PHARMACIES` | `DEMO_DELIVERY_STOPS` / `DEMO_AREA_DEMOGRAPHICS` / `DEMO_DEMAND_CATALOG` / `DEMO_KEY_SITES` (+ new `DEMO_DEPOT`) |
| SA verbs `pharma_catchment` / `pharma_optimization` / `supply_chain` | `catchment` / `delivery_optimization` / `network_optimization` |

## Order of operations

1. **Physical schema + table** (migrate data in place, or drop+reseed):
   ```sql
   -- In-place rename (preserves data):
   ALTER SCHEMA FLEET_INTELLIGENCE.RETAIL_CATCHMENT RENAME TO FLEET_INTELLIGENCE.CATCHMENT;
   ALTER TABLE  FLEET_INTELLIGENCE.CATCHMENT.RETAIL_POIS RENAME TO FLEET_INTELLIGENCE.CATCHMENT.POIS;
   -- OR drop the old schema and re-run the retail-catchment skill seed-data.sql
   -- (now creates CATCHMENT.POIS directly).
   ```
   Drop the old demo tables and re-run `setup-agent-playground` so the renamed
   `DEMO_*` tables + `DEMO_DEPOT` exist:
   ```sql
   DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_PHARMA_JOBS;
   DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_HEALTH_DEMOGRAPHICS;
   DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DRUG_FORMULARY;
   DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_TOP_PHARMACIES;
   ```

2. **Procs + agent** — re-run `routing-agent` `deploy-agent.sql` (creates the
   three renamed procs + the agent spec). Then drop the obsolete old procs:
   ```sql
   DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT(VARCHAR, FLOAT, VARCHAR);
   DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION(VARCHAR);
   DROP PROCEDURE IF EXISTS FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN(VARCHAR);
   ```

3. **Semantic view** — deploy `semantic/sv_catchment.sql`; drop old:
   ```sql
   DROP SEMANTIC VIEW IF EXISTS FLEET_INTELLIGENCE.SEMANTIC.SV_RETAIL_CATCHMENT;
   ```
   Validate with `evaluate_semantic_view` on `semantic/sv_catchment.sql`.

4. **Demo data** — run `setup-agent-playground` `deploy-demo-data.sql`
   (seeds `DEMO_*` + `DEMO_DEPOT`, updates `CATCHMENT.CONFIG`) and re-upload
   `agent-demos.json` to `@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/`.

5. **Extended analyst agent** — re-run `semantic/extend_routing_agent.sql`
   (rebinds `query_catchment` -> `SV_CATCHMENT` + the three renamed verb tools).

6. **SA app** — regenerate/apply `packs/fleet/catchment/setup.sql`
   (`FLEET_APP.CATCHMENT.VW_POIS`), re-apply `role_binding.sql`, redeploy the
   agent from `agent-spec.json`.

7. **Control-app + fleet_admin image** — rebuild and redeploy per AGENTS.md
   "Control App Image Deployment" (multi-stage `Dockerfile.runtime`, bump
   `image-versions.env` + service YAML, `snow stage copy`, suspend -> update ->
   resume). Needed because the server fleet-schema arrays + Agent Playground
   tool-proc map changed.

## Verify

- `SHOW PROCEDURES IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT` lists the three
  `TOOL_CATCHMENT` / `TOOL_DELIVERY_OPTIMIZATION` / `TOOL_NETWORK_OPTIMIZATION`;
  old `TOOL_PHARMA_*` / `TOOL_SUPPLY_CHAIN` gone.
- `SHOW SCHEMAS IN DATABASE FLEET_INTELLIGENCE` shows `CATCHMENT` (no `RETAIL_CATCHMENT`).
- `evaluate_semantic_view` passes on `SV_CATCHMENT`.
- Agent Playground shows the "Catchment & Delivery" scenario; each verb runs end-to-end.
