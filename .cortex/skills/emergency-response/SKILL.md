---
name: emergency-response
description: "Deploy the Emergency Response Intelligence demo: 5-page React dashboard + 6-step Dynamic Table pipeline that automates participant-impact assessment for wildfire, hurricane, flood, tornado, and snow events using free Snowflake Marketplace hazard data (NWS Alerts, FEMA, Census, FEMA NRI) plus ORS isochrones and OPTIMIZATION with avoid_polygons. Use when: setting up emergency response demo, hazard impact dashboard, evacuation routing, participant safety analytics, NWS alert geofencing, Innovage / PACE / paratransit hazard exposure analysis. Do NOT use for: standard fleet tracking (use fleet-intelligence-taxis), retail trade area analysis (use retail-catchment), route deviation analytics (use route-deviation), generic dispatch (use route-optimization). Triggers: emergency response, hazard impact, wildfire impact, hurricane evacuation, flood exposure, tornado warning, NWS alerts, FEMA, evacuation routing, participant safety, avoid polygons, geofence alert, Innovage, PACE."
depends_on:
  - build-routing-solution
  - fleet-intelligence-taxis
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: demo
---

# Deploy Emergency Response Intelligence

Deploys a 5-page React dashboard plus 6-step Dynamic Table pipeline that automates the manual ArcGIS participant-impact workflow used by emergency operations teams (e.g. Innovage PACE, paratransit, healthcare, retail field ops). Uses free Snowflake Marketplace hazard data (NWS Alerts, FEMA Disasters, FEMA NRI, Census ACS, NAD) and the existing ORS-on-SPCS routing/isochrones/OPTIMIZATION services. Differentiating capability vs ArcGIS Online: ORS isochrones and VRP solves with NWS alert geometries passed as `avoid_polygons`, so reachability and dispatch routing automatically detour around the active hazard.

## Prerequisites

1. ORS app deployed via `build-routing-solution` (4 services RUNNING in `OPENROUTESERVICE_APP`).
2. Region provisioned (default `SanFrancisco`) with `BOUNDARY` baked in `OPENROUTESERVICE_APP.CORE.REGION_CATALOG`.
3. Driver telemetry available (loaded by `fleet-intelligence-taxis` -- supplies the `DRIVERS` GPS layer used on Page 4 Dispatch).
4. Two free Snowflake Marketplace listings (auto-installed in Step 0a of `references/sql-pipeline.sql` via `SYSTEM$ACCEPT_LEGAL_TERMS` + `CREATE DATABASE FROM LISTING` -- same pattern as `retail-catchment` and `route-optimization`):
   - **Snowflake Public Data (Free)** -- listing `GZTSZ290BV255` -> creates `SNOWFLAKE_PUBLIC_DATA_FREE` with schema `public_data` (NWS Alerts, FEMA, Census ACS, NAD, Geography, Overture Maps).
   - **kipi.ai FEMA National Risk Index (Free)** -- listing `GZSTZKU9FH9` -> creates `FEMA_NATIONAL_RISK_INDEX` with schema `NRI_SCH` (`NRI_CENSUSTRACTS`, `NRI_COUNTIES`).
5. Bundled IPAWS seed parquet (`assets/ipaws_sf.parquet`) -- pre-built locally by `scripts/build_ipaws_sf_seed.py` and committed to the repo. Loaded into `EMERGENCY_RESPONSE.SOURCE.IPAWS_SF` via `COPY INTO` from `@EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE` (Steps 0c-0f). No runtime API access required.
6. `ROUTING_ANALYTICS` warehouse available.
7. A role with privileges in the table below.

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | Creates `EMERGENCY_RESPONSE` database |
| CREATE SCHEMA | DB `EMERGENCY_RESPONSE` | Creates `CONFIG`, `SOURCE`, `CORE`, `PIPELINE` schemas |
| CREATE TABLE | DB `EMERGENCY_RESPONSE` | Creates static + synthetic tables |
| CREATE VIEW | DB `EMERGENCY_RESPONSE` | Creates `SOURCE.V_*` re-mappers over Marketplace data |
| CREATE DYNAMIC TABLE | DB `EMERGENCY_RESPONSE` | Creates 6 Dynamic Tables in `PIPELINE` |
| CREATE FUNCTION | DB `EMERGENCY_RESPONSE` | Creates `ORS_ISOCHRONE_AVOIDING`, `ORS_OPTIMIZATION_AVOIDING` UDFs |
| CREATE PROCEDURE | DB `EMERGENCY_RESPONSE` | Creates `GENERATE_INNOVAGE_DATASET`, `EXPORT_IMPACTED_CSV` |
| CREATE STAGE | Schema `EMERGENCY_RESPONSE.SOURCE` | Creates `IPAWS_SEED_STAGE` for the bundled IPAWS parquet |
| USAGE ON WAREHOUSE `ROUTING_ANALYTICS` | Warehouse | Used by all Dynamic Tables |
| USAGE ON DATABASE `OPENROUTESERVICE_APP` | DB | Calls ISOCHRONES / OPTIMIZATION / MATRIX service functions |
| USAGE ON SCHEMA `OPENROUTESERVICE_APP.CORE` | Schema | Calls service functions and reads `REGION_CATALOG` |
| IMPORT SHARE | Account | Required to install Marketplace listings via `CREATE DATABASE FROM LISTING` (Step 0a) |
| IMPORTED PRIVILEGES on Marketplace shares | Share | Reads `SNOWFLAKE_PUBLIC_DATA_FREE.public_data.*` and `FEMA_NATIONAL_RISK_INDEX.NRI_SCH.*` |

> ACCOUNTADMIN is NOT required. Create role `EMERGENCY_RESPONSE_ROLE` with the above grants.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `REGION` | `SanFrancisco` | Provisioned ORS region; defines BOUNDARY for spatial filters |
| `NUM_PARTICIPANTS` | `5000` | Synthetic participant addresses (frail-elderly weighted) |
| `NUM_STAFF` | `300` | Synthetic staff home addresses |
| `NUM_CENTERS` | `12` | Synthetic adult day care centers (weighted near medical zips) |
| `NUM_DRIVERS` | `40` | Synthetic drivers (reuses fleet-intelligence-taxis schema) |
| `VULNERABILITY_WEIGHTING` | `0.5` | Blend factor: `score = w * NRI_SoVI + (1-w) * synthetic_frailty` |
| `TARGET_LAG` | `5 minutes` | Dynamic Table refresh cadence |
| `H3_RESOLUTION_HISTORY` | `7` | Hexagon resolution for Page 5 historical heatmap |

CONFIG table created at `EMERGENCY_RESPONSE.CONFIG.PARAMS (PARAM_NAME VARCHAR, PARAM_VALUE VARCHAR)` with COMMENT tracking tag.

## Pipeline Architecture

```
Marketplace (public_data + NRI_SCH)
        |
        v
EMERGENCY_RESPONSE.SOURCE.V_*           <- re-mapping views
        |
        v
EMERGENCY_RESPONSE.CORE.{PARTICIPANTS, STAFF, CENTERS, DRIVERS}
        |
        v
PIPELINE.STG_NWS_ACTIVE_ALERTS         (Step 1)
        |
PIPELINE.STG_PARTICIPANT_VULNERABILITY (Step 2)
        |
        v
PIPELINE.FACT_IMPACTED_PARTICIPANTS    (Step 3)  ST_WITHIN(participant, alert.boundary)
        |
        +--> PIPELINE.FACT_REACHABILITY_BY_CENTER (Step 4)  ORS isochrones with avoid_polygons
        |
        +--> PIPELINE.FACT_DISPATCH_PLAN          (Step 5)  ORS OPTIMIZATION with avoid_polygons
        |
        +--> PIPELINE.FACT_HAZARD_HISTORY_H3      (Step 6)  5y FEMA history aggregated to H3
```

## Error Logging

> Follow the Error Logging convention in AGENTS.md. Log file prefix: `emergency-response`.

## Quick Start

```sql
-- 1. Set query tag (per AGENTS.md, hard requirement)
ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- 2. Verify both Marketplace listings are accessible (auto-installed by Step 0a)
SELECT COUNT(*) FROM SNOWFLAKE_PUBLIC_DATA_FREE.public_data.geography_index WHERE level = 'County' LIMIT 1;
SELECT COUNT(*) FROM FEMA_NATIONAL_RISK_INDEX.NRI_SCH.NRI_CENSUSTRACTS LIMIT 1;

-- 3. Verify ORS is up (per AGENTS.md "Do NOT assume ORS is running")
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;
-- All 5 services must be RUNNING
```

Then run the pipeline:

```sql
-- Run each Step in references/sql-pipeline.sql sequentially
```

## Workflow

### Step 1: Run SQL Pipeline

Execute statements in `references/sql-pipeline.sql` sequentially using `snowflake_sql_execute`. Every CREATE includes the COMMENT tracking tag per AGENTS.md.

| Step | Object | Type | Description |
|------|--------|------|-------------|
| 0a | Marketplace listings (`SNOWFLAKE_PUBLIC_DATA_FREE`, `FEMA_NATIONAL_RISK_INDEX`) | DDL | `SYSTEM$ACCEPT_LEGAL_TERMS` + `CREATE DATABASE FROM LISTING` (idempotent) |
| 0 | Database + 4 schemas (CONFIG, SOURCE, CORE, PIPELINE) | DDL | Create container |
| 0b | CONFIG.PARAMS | Table | Single-table key/value config |
| 0c | SOURCE.IPAWS_SEED_STAGE | Stage | Holds bundled `ipaws_sf.parquet` (PARQUET file format) |
| 0d | (out-of-band) `snow stage copy assets/ipaws_sf.parquet @SOURCE.IPAWS_SEED_STAGE/` | CLI | Uploads the bundled seed parquet (or use `COPY FILES` from a Workspace) |
| 0e | SOURCE.IPAWS_SF | Table | GEOGRAPHY-first IPAWS rows pre-clipped to SF region |
| 0f | `COPY INTO IPAWS_SF` | DML | Loads the parquet, transforms `search_geometry_geojson` -> GEOGRAPHY |
| 1 | SOURCE.V_NWS_ALERTS_ACTIVE | View | Re-mapper over Marketplace NWS alerts (active + region-filtered via REGION_CATALOG.BOUNDARY) |
| 2 | SOURCE.V_FEMA_DISASTERS_RECENT | View | Last 90 days of FEMA disaster declarations |
| 3 | SOURCE.V_FEMA_NRI_TRACTS | View | Census-tract-level NRI risk + SoVI for 6 perils (HRCN, RFLD, WFIR, TRND, ISTM, SWND) |
| 4 | SOURCE.V_ACS_VULNERABLE_POP_TRACTS | View | ACS disability + age 65+ pct per tract |
| 4a | SOURCE.V_IPAWS_SF | View | Re-shapes `IPAWS_SF` rows to match the live-alert schema for the UNION in Step 8 |
| 5 | CORE.PARTICIPANTS / STAFF / CENTERS / DRIVERS | Tables | Synthetic Innovage entities (GEOGRAPHY first) |
| 6 | CORE.GENERATE_INNOVAGE_DATASET(REGION) | Procedure | Populates the 4 entity tables (Census-tract weighted) |
| 7 | CORE.ORS_ISOCHRONE_AVOIDING / ORS_OPTIMIZATION_AVOIDING | UDFs | Wrap OPENROUTESERVICE_APP service funcs with avoid_polygons |
| 8 | PIPELINE.STG_NWS_ACTIVE_ALERTS | Dynamic Table | Filtered to severity >= Moderate AND ST_INTERSECTS(boundary, region); UNIONs live IPAWS rows where `expires_time > NOW()` |
| 9 | PIPELINE.STG_PARTICIPANT_VULNERABILITY | Dynamic Table | Participant + composite vulnerability score 0-100 |
| 10 | PIPELINE.FACT_IMPACTED_PARTICIPANTS | Dynamic Table | ST_WITHIN(participant, alert.boundary) |
| 11 | PIPELINE.FACT_REACHABILITY_BY_CENTER | Dynamic Table | Calls ORS_ISOCHRONE_AVOIDING per (center, alert) |
| 12 | PIPELINE.FACT_DISPATCH_PLAN | Dynamic Table | Calls ORS_OPTIMIZATION_AVOIDING per alert with available drivers |
| 13 | PIPELINE.FACT_HAZARD_HISTORY_H3 | Dynamic Table | 5y FEMA history + bundled IPAWS history -> H3 res 7 with severity-weighted score |
| 15 | (verification) | EXECUTE IMMEDIATE | Raises if `SOURCE.IPAWS_SF` is empty (means seed parquet wasn't uploaded) |

### Step 2: Verify Pipeline

```sql
SELECT 'STG_NWS_ACTIVE_ALERTS', COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS
UNION ALL SELECT 'FACT_IMPACTED_PARTICIPANTS', COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS
UNION ALL SELECT 'FACT_REACHABILITY_BY_CENTER', COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.FACT_REACHABILITY_BY_CENTER
UNION ALL SELECT 'FACT_DISPATCH_PLAN', COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.FACT_DISPATCH_PLAN
UNION ALL SELECT 'FACT_HAZARD_HISTORY_H3', COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.FACT_HAZARD_HISTORY_H3;
```

If `STG_NWS_ACTIVE_ALERTS` is 0, no live alert covers the region today. The demo includes a fallback offline GeoJSON at `assets/sample_alerts.geojson` that can be inserted into `SOURCE.MOCK_ALERTS` to keep pages populated.

### Step 3: Deploy React Pages

The 5 demo pages live inside the existing `ors_control_app` shell so they share authentication and the deck.gl map base. After redeploying the control app image (per AGENTS.md `Control App Image Deployment` section), the pages appear under the new `Emergency` sidebar group:

| Page | Path | Inspired by |
|------|------|-------------|
| Hazard Operations Center | `/emergency/hazard-ops` | fleet-intelligence-taxis Live View |
| Participant Triage | `/emergency/triage` | retail-catchment ranking |
| Reachability Under Hazard | `/emergency/reachability` | GIScience Ahrtal-Avoid-Areas-Isochrones |
| Driver Dispatch | `/emergency/dispatch` | route-optimization + backload-matching |
| Vulnerability Planning | `/emergency/vulnerability` | dwell-analysis H3 heatmap |

Server API endpoints (full table in `references/server-api.md`):

```
GET  /api/emergency/alerts?region=...
GET  /api/emergency/impacted/:alert_id
GET  /api/emergency/reachability/:alert_id
POST /api/emergency/dispatch
GET  /api/emergency/history?h3_res=7
GET  /api/emergency/export/:alert_id.csv
```

## Marketplace Datasets

| Dataset | Listing | Used by |
|---------|---------|---------|
| NWS Alerts | Snowflake Public Data (Free) | Pages 1, 2, 3, 4 (live hazard layer + avoid_polygons input) |
| FEMA Disasters | Snowflake Public Data (Free) | Page 5 historical H3 heatmap |
| FEMA NRI (kipi.ai) | kipi.ai FEMA NRI (Free) | Page 2 vulnerability scoring |
| Census ACS | Snowflake Public Data (Free) | Page 2 participant generator + vulnerability |
| NAD (US addresses) | Snowflake Public Data (Free) | Synthetic participant address backfill |
| Overture Maps | Snowflake Public Data (Free) | Optional center placement (`health` POIs) |
| Geography Tables | Snowflake Public Data (Free) | County / tract boundary GeoJSON for Page 1 |
| OpenFEMA IPAWS Archived Alerts | Bundled parquet (`assets/ipaws_sf.parquet`) | Page 1 (live UNION when alerts still in window) + Page 5 (historical H3 heatmap). Pre-built one-time via `scripts/build_ipaws_sf_seed.py`; no runtime API access. |

## Refreshing the IPAWS Seed

The IPAWS seed parquet is rebuilt only when a maintainer wants newer alerts.
It is NOT part of the install workflow.

```bash
# From repo root:
python3 .cortex/skills/emergency-response/scripts/build_ipaws_sf_seed.py
# Pages OpenFEMA /IpawsArchivedAlerts.jsonl since 2023-01-01 (status='Actual')
# and ST_INTERSECTS each row's searchGeometry against the SF polygon stored
# at assets/sf_boundary.geojson. Writes assets/ipaws_sf.parquet.
# Expected runtime: 5-10 minutes. Output: low-MB parquet with hundreds of rows.

git add .cortex/skills/emergency-response/assets/ipaws_sf.parquet
git commit -m "chore(emergency-response): refresh IPAWS SF seed"
```

After the refresh, re-upload the parquet to the install stage:

```bash
snow stage copy \
  .cortex/skills/emergency-response/assets/ipaws_sf.parquet \
  @EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE/ \
  --overwrite -c <connection>
```

Then re-run Step 0f (`COPY INTO`) from `references/sql-pipeline.sql` to land
the new rows. The downstream Dynamic Tables refresh automatically within the
`TARGET_LAG` window.

## Examples

### Example 1: Default San Francisco demo
User: "Deploy emergency response"
Actions:
1. Verify both Marketplace listings installed.
2. Run `references/sql-pipeline.sql` Steps 0-13.
3. Run `CALL CORE.GENERATE_INNOVAGE_DATASET('SanFrancisco');`.
4. Open `/emergency/hazard-ops` in the control app.
Result: 5-page demo with live NWS alerts and synthetic participants.

### Example 2: Different region
User: "Set up emergency response demo for Florida hurricane scenario"
Actions:
1. Provision `Florida` region via `routing-customization` first.
2. Update `CONFIG.PARAMS` with `REGION='Florida'`.
3. Re-run pipeline Step 5 onwards.
Result: Florida-specific demo with hurricane evacuation zones.

## Stopping Points

- After Step 6: Verify `CORE.PARTICIPANTS` has expected row count (~5K for SF default).
- After Step 8: Verify `STG_NWS_ACTIVE_ALERTS` returns rows (or fall back to mock alerts).
- After Step 11: Sanity check that at least one row in `FACT_REACHABILITY_BY_CENTER` has `unreachable_participants > 0` (proves avoid_polygons works).

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `STG_NWS_ACTIVE_ALERTS` is empty | No live alert in region today. Insert from `assets/sample_alerts.geojson` into `SOURCE.MOCK_ALERTS` and union into the view. |
| Step 15 verification raises (IPAWS_SF empty) | The bundled parquet was not uploaded to the install stage. Re-run `snow stage copy assets/ipaws_sf.parquet @EMERGENCY_RESPONSE.SOURCE.IPAWS_SEED_STAGE/ --overwrite -c <connection>`, then re-execute Step 0f. |
| `FACT_REACHABILITY_BY_CENTER` errors | ORS isochrone call failing. Check `SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;` and run a smoke test: `SELECT OPENROUTESERVICE_APP.CORE.ISOCHRONES(...)` |
| `FACT_DISPATCH_PLAN` empty | Either no impacted participants today OR no drivers `ON_SHIFT` -- check `CORE.DRIVERS.STATUS`. |
| Pages 1-5 return 401 | Control app not redeployed since adding `/api/emergency/*` routes. Rebuild + push image per AGENTS.md control app section. |
| Avoid polygons ignored by ORS | `avoid_polygons` argument must be a valid MultiPolygon GeoJSON. Use `ST_ASGEOJSON(ST_FORCE2D(boundary))` to strip Z values. |
| Census tract join misses | NWS alerts ship with county FIPS, not tract. Use `geography_relationships` table to bridge County -> Tracts. |

## Cleanup

```sql
DROP DATABASE IF EXISTS EMERGENCY_RESPONSE CASCADE;
-- Cascades the IPAWS_SEED_STAGE, IPAWS_SF table, V_IPAWS_SF view, all schemas,
-- and the COMMENT-tagged objects underneath the database.
-- Optional: only drop the Marketplace databases if no other skill is using them
-- DROP DATABASE IF EXISTS SNOWFLAKE_PUBLIC_DATA_FREE;
-- DROP DATABASE IF EXISTS FEMA_NATIONAL_RISK_INDEX;
-- The control app code changes (server/routes/emergency.ts and src/components/emergency/*)
-- are removed by reverting the related git commits in feat/<github_login>-feat.
```

> **Tip:** Use the `routing-solution-cleanup` skill to discover all tagged objects via the COMMENT tracking tag `oss-emergency-response`.
