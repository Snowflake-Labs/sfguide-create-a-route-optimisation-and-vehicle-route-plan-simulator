---
name: fleet-explorer-app
description: "Deploy the Fleet Explorer Streamlit app with pydeck maps, ORS directions, and isochrones. Warehouse-based (not container runtime). Snowflake branded with Inter font. Use when: deploy fleet map, create fleet explorer, deploy streamlit map app, fleet explorer app. Do NOT use for: fleet data generation (use fleet-intelligence-taxis), route optimization notebooks, or ORS infrastructure deployment."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: demo
---

# Deploy Fleet Explorer Streamlit App

Deploys a Snowflake-branded Streamlit app with 5 tabs: POI Map, Directions, Isochrones, Route Optimization (VRP), and Travel Matrix (H3 Heatmap). Runs on warehouse (not container runtime). Uses `pydeck` via `environment.yml` (Snowflake conda channel).

---

## Prerequisites

- `build-routing-solution` deployed (ORS services running)
- `SYNTHETIC_DATASETS.UNIFIED.DIM_POIS` table populated
- Warehouse `DEFAULT_WH` available

---

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `APP_NAME` | fleet-map | Folder name in workspace |
| `DEPLOY_DATABASE` | SYNTHETIC_DATASETS | Database for Streamlit object |
| `DEPLOY_SCHEMA` | UNIFIED | Schema for Streamlit object |
| `WAREHOUSE` | DEFAULT_WH | Query warehouse |

---

## Required Privileges

| Privilege | Object | Notes |
|-----------|--------|-------|
| USAGE | WAREHOUSE DEFAULT_WH | Query execution |
| SELECT | SYNTHETIC_DATASETS.UNIFIED.DIM_POIS | POI data |
| USAGE | OPENROUTESERVICE_APP.CORE functions | Directions, Isochrones |
| CREATE STREAMLIT | SYNTHETIC_DATASETS.UNIFIED | Deploy app |

---

## Deployment Steps

### Step 1: Create the app folder structure

Create these files in the workspace at `fleet-map/`:

```
fleet-map/
├── .streamlit/
│   └── config.toml
├── environment.yml
├── pyproject.toml
├── snowflake.yml
└── streamlit_app.py
```

### Step 2: Write all files

Write each file with the **exact content** from `references/app-files.md`.

### Step 3: Deploy the Streamlit object

```sql
CREATE OR REPLACE STREAMLIT {{DEPLOY_DATABASE}}.{{DEPLOY_SCHEMA}}.FLEET_MAP
  FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/fleet-map'
  MAIN_FILE = 'streamlit_app.py'
  QUERY_WAREHOUSE = {{WAREHOUSE}}
  COMMENT = 'Fleet Explorer - Snowflake branded geospatial analytics with ORS';
```

### Step 4: Verify deployment

```sql
SHOW STREAMLITS LIKE 'FLEET_MAP' IN SCHEMA {{DEPLOY_DATABASE}}.{{DEPLOY_SCHEMA}};
```

---

## Key Technical Notes

- **Packages**: `pydeck` is installed via `environment.yml` (conda channel: snowflake), NOT `pyproject.toml` alone
- **Session**: Uses `get_active_session()` NOT `st.connection("snowflake")`
- **Data types**: DIM_POIS columns have literal `"` in NAME values — use `TRIM(NAME, '"')::TEXT`
- **ISOCHRONES function**: 4th parameter is **minutes** (not seconds). Must cast args: `LNG::FLOAT, LAT::FLOAT, MINUTES::NUMBER`
- **DIRECTIONS function**: Uses `ARRAY_CONSTRUCT(lng, lat)` for origin/destination
- **OPTIMIZATION function**: Each vehicle MUST have `"profile": "driving-car"`. Use `"capacity"` + `"delivery"` to force multi-vehicle splits
- **MATRIX function**: Returns VARIANT with `"durations"` key (array of arrays, seconds). First row = durations from first location
- **H3**: Use `H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lng, lat), resolution)` — returns VARCHAR
- **Branding**: Snowflake blue `#29B5E8`, font Inter (Google Fonts), light theme background, CSS overrides for all accent elements
- **No external images**: Do not use external URLs for logos (blocked in runtime)
- **Tooltips**: Use `tooltip={"html": "...", "style": {...}}` format on all pydeck charts
- **SQL injection in POI names**: Never include POI names directly in SQL strings (apostrophes break queries). Remove `description` from VROOM jobs or escape with `replace("'", "''")`
- **ORS auto-suspend**: ORS_SERVICE has `auto_suspend_secs=600`. Set to 0 during demos: `ALTER SERVICE ... SET AUTO_SUSPEND_SECS = 0`
- **CHECK_HEALTH()**: Hits the gateway, not ORS engine directly. May return true even when ORS is still loading graph (~2 min after resume)

---

## Cleanup

```sql
DROP STREAMLIT IF EXISTS {{DEPLOY_DATABASE}}.{{DEPLOY_SCHEMA}}.FLEET_MAP;
```

Remove workspace folder: `fleet-map/`
