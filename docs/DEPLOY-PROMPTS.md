# Deployment Prompts (Sequential)

Run these prompts **in order**, one at a time. Wait for each to complete before starting the next.

---

## Prompt 1: Stage Upload + Phase 0-1 (Infrastructure)

```
Upload all workspace files to @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE for deployment:

1. Upload SQL files:
   COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/
   FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/'
   PATTERN='.*\.sql';

2. Upload service YAML specs individually (NOT with PATTERN='.*yaml'):
   - .cortex/skills/build-routing-solution/openrouteservice_app/services/downloader/downloader_spec.yaml → @ORS_SPCS_STAGE/services/downloader/
   - .cortex/skills/build-routing-solution/openrouteservice_app/services/openrouteservice/openrouteservice.yaml → @ORS_SPCS_STAGE/services/openrouteservice/
   - .cortex/skills/build-routing-solution/openrouteservice_app/services/ors_control_app/ors_control_app_service.yaml → @ORS_SPCS_STAGE/services/ors_control_app/
   - .cortex/skills/build-routing-solution/openrouteservice_app/services/vroom/vroom-service.yaml → @ORS_SPCS_STAGE/services/vroom/
   - .cortex/skills/build-routing-solution/openrouteservice_app/services/gateway/routing-gateway-service.yaml → @ORS_SPCS_STAGE/services/gateway/

3. Upload ors-config.yml ONLY to SanFrancisco:
   COPY FILES INTO @ORS_SPCS_STAGE/SanFrancisco/ FROM workspace FILES=('ors-config.yml');

4. Remove stray ors-config from deploy/ paths:
   REMOVE @ORS_SPCS_STAGE/deploy/ors-config.yml;
   REMOVE @ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/openrouteservice_app/staged_files/ors-config.yml;

5. Create warehouses:
   - ROUTING_DEPLOY (LARGE, auto_suspend=120)
   - ROUTING_ANALYTICS (XS, auto_suspend=60)

6. USE WAREHOUSE ROUTING_DEPLOY; USE SCHEMA OPENROUTESERVICE_APP.CORE;

7. Execute modules 00-06 sequentially (each is an EXECUTE IMMEDIATE FROM @ORS_SPCS_STAGE/deploy/.cortex/skills/build-routing-solution/.../modules/0X_....sql)

8. Seed REGION_ORS_MAP with SanFrancisco if not exists.

9. WAIT: Poll SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP until all 5 show RUNNING.

IMPORTANT: EXECUTE IMMEDIATE FROM will return error 391917 from snowflake_sql_execute — this is a known result-format parsing issue, NOT an execution failure. After each module, verify success by checking created objects exist.

Log any REAL errors (not 391917) to logs/.
```

---

## Prompt 2: Phase 2-3 (Seed Data + Demo Skills)

```
Continue deployment. USE WAREHOUSE ROUTING_DEPLOY; USE SCHEMA OPENROUTESERVICE_APP.CORE;

Phase 2 — Seed Data:
1. Create stage: CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_APP.CORE.SEED_DATA_STAGE;
2. Upload parquets from workspace datasets/ to @SEED_DATA_STAGE (7 COPY FILES commands per deploy-all.sql lines 120-150)
3. EXECUTE IMMEDIATE FROM @ORS_SPCS_STAGE/deploy/datasets/load-seed-data.sql;
4. Verify: SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS; — expect 6008

Phase 3 — Demo Skills (6 modules, USE WAREHOUSE ROUTING_DEPLOY for Overture Maps):
1. fleet-intelligence-taxis/references/seed-data.sql
2. fleet-intelligence-food-delivery/references/sql-projection-views.sql
3. route-deviation/references/seed-data.sql
4. dwell-analysis/references/sql-pipeline.sql
5. route-optimization/references/seed-data.sql
6. retail-catchment/references/seed-data.sql

All via EXECUTE IMMEDIATE FROM @ORS_SPCS_STAGE/deploy/.cortex/skills/{skill}/references/{file}.sql

Verify: SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES; — expect ~1.4M

IMPORTANT: 391917 errors from snowflake_sql_execute are OK — verify objects exist after each module. Log REAL errors to logs/.
```

---

## Prompt 3: Phase 4 (Tool Procedures)

```
Continue deployment. USE WAREHOUSE ROUTING_DEPLOY; USE SCHEMA OPENROUTESERVICE_APP.CORE;

Phase 4 — Execute these EXECUTE IMMEDIATE FROM statements in order:
1. setup-agent-playground/references/deploy-demo-data.sql (creates SF_TOP_PHARMACIES, SF_DRUG_FORMULARY)
2. add-weather-routing/references/deploy-weather-tool.sql
3. add-pharma-supply-chain/references/deploy-pharma-supply-chain.sql
4. add-pharma-supply-chain/references/deploy-robot-telemetry.sql
5. add-plant-map/references/build-plant-footprints.sql
6. add-pharma-intelligence/references/deploy-pharma-data.sql
7. add-pharma-intelligence/references/deploy-pharma-tools.sql
8. add-pharma-intelligence/references/deploy-plant-impact-tool.sql
9. routing-agent/references/deploy-agent.sql
10. build-routing-solution/.../stored_procedures/tool_pharma_catchment.sql
11. add-plant-map/references/tool-create-plant.sql
12. add-plant-map/references/tool-alter-plant.sql

All paths prefixed: @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/deploy/.cortex/skills/

Verify: SELECT PROCEDURE_NAME FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA='ROUTING_AGENT' ORDER BY 1;
— expect 13+ tool procedures

Log errors to logs/.
```

---

## Prompt 4: Phase 5-7 (Agent + Streamlit + Verify)

```
Continue deployment. USE WAREHOUSE ROUTING_DEPLOY;

Phase 5 — Semantic Views then Agent (ORDER IS CRITICAL):
1. EXECUTE IMMEDIATE FROM @ORS_SPCS_STAGE/deploy/.cortex/skills/add-fleet-analytics/references/deploy-fleet-analytics.sql
2. EXECUTE IMMEDIATE FROM @ORS_SPCS_STAGE/deploy/.cortex/skills/setup-agent-playground/references/deploy-semantic-view.sql
3. EXECUTE IMMEDIATE FROM @ORS_SPCS_STAGE/deploy/.cortex/skills/setup-agent-playground/references/configure-agent.sql
   ← THIS MUST BE LAST (references all tools + semantic views)

4. Create Streamlit:
   CREATE OR REPLACE STREAMLIT SYNTHETIC_DATASETS.UNIFIED.FLEET_MAP
     FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/fleet-map'
     MAIN_FILE='streamlit_app.py' QUERY_WAREHOUSE=DEFAULT_WH
     COMMENT='{"origin":"sf_sit-is-fleet","name":"oss-fleet-explorer-app","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}';

5. Upload agent-demos.json:
   COPY FILES INTO @ORS_SPCS_STAGE/config/ FROM workspace FILES=('agent-demos.json');

Phase 6 — Cleanup:
   USE WAREHOUSE ROUTING_ANALYTICS;
   DROP WAREHOUSE IF EXISTS ROUTING_DEPLOY;

Phase 7 — Verify:
   SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP; — 5 RUNNING
   SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.FACT_TRIPS; — 6008
   SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT; — ROUTING_AGENT exists
   SHOW STREAMLITS IN SCHEMA SYNTHETIC_DATASETS.UNIFIED; — FLEET_MAP exists
   
   Verify agent has cortex_analyst_text_to_sql tools with semantic_view bindings:
   DESCRIBE AGENT FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT;
   — agent_spec must contain 'cortex_analyst_text_to_sql' AND 'tool_resources' AND 'FLEET_TRIPS_SV'

Log final results to logs/deploy-all_{date}.md
```

---

## Why Split?

| Problem with single prompt | Fix |
|---|---|
| Context window overflow (30+ operations + error handling) | 4 focused prompts, each ~8 operations |
| 391917 error ambiguity causes re-execution loops | Each prompt explicitly states "391917 = OK, verify objects" |
| Module 12 vs configure-agent confusion | Prompt 4 explicitly says use Phase 5 scripts, NOT Module 12 |
| Service polling blocks progress | Prompt 1 ends with polling — no wasted context |
| Lost warehouse/schema context between calls | Each prompt starts with USE WAREHOUSE + USE SCHEMA |
| No verification between phases | Each prompt has specific verification queries |

## Alternative: Single Prompt (if you want one-shot)

If you prefer a single prompt, the key additions needed are:

1. **Explicitly state which SQL files to use** (deploy-all.sql references, NOT module 12)
2. **Add "391917 is OK" guidance** — prevents re-execution loops
3. **Add per-phase verification queries** — provides checkpoints
4. **State the workspace stage URI** — prevents stage name resolution failures
5. **Add: "Do NOT use Module 12 (12_agent_and_streamlit.sql) — use Phase 5 scripts from deploy-all.sql"**
