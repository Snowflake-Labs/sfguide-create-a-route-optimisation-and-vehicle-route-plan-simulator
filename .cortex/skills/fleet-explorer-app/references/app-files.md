# Fleet Explorer App - Complete File Contents

Write each file exactly as shown below. Do not modify.

---

## `.streamlit/config.toml`

```toml
[theme]
primaryColor = "#29B5E8"
backgroundColor = "#FFFFFF"
secondaryBackgroundColor = "#F4F8FB"
textColor = "#1B2332"
font = "sans serif"
```

---

## `environment.yml`

```yaml
name: sf_env
channels:
  - snowflake
dependencies:
  - pydeck
```

---

## `pyproject.toml`

```toml
[project]
name = "fleet-map"
requires-python = ">= 3.11"
version = "0.1.0"
description = "Fleet telemetry and POI map visualisation"
dependencies = [
    "streamlit[snowflake]>=1.54.0",
    "pydeck>=0.9.0"
]

[tool.uv]
constraint-dependencies = ["numba>=0.56.0"]
```

---

## `snowflake.yml`

```yaml
# created-by: streamlit-in-workspaces; skill-version=1.0.0
definition_version: 2
entities:
  streamlit_app:
    type: streamlit
    query_warehouse: "DEFAULT_WH"
    main_file: streamlit_app.py
    artifacts:
      - pyproject.toml
      - streamlit_app.py
      - environment.yml
      - .streamlit/config.toml
```

---

## `streamlit_app.py`

Write the exact content of the current deployed `/fleet-map/streamlit_app.py`. The source is the single source of truth. Copy it verbatim when deploying.

Key characteristics of the current version:
- 5 tabs: POI Map, Directions, Isochrones, Route Optimization, Travel Matrix
- Snowflake branding via CSS (Inter font, #29B5E8 accent override on all elements)
- `get_active_session()` for DB connection
- `TRIM(NAME, '"')::TEXT` for POI names
- ISOCHRONES: pass minutes directly (not seconds), cast `::FLOAT` and `::NUMBER`
- OPTIMIZATION: vehicles must have `"profile": "driving-car"` and `"capacity": [N]`; jobs have `"delivery": [1]`
- MATRIX: vehicle type selectable (driving-car, cycling-regular, foot-walking); tooltips show drive time + distance
- H3: `H3_POINT_TO_CELL_STRING(ST_MAKEPOINT(lng, lat), resolution)`
- All maps use `map_style="dark"` and HTML tooltips with dark styling
- No external image URLs (blocked in runtime)
- No POI names in SQL strings (apostrophe injection risk)

---

## Deploy Command

```sql
CREATE OR REPLACE STREAMLIT {{DEPLOY_DATABASE}}.{{DEPLOY_SCHEMA}}.FLEET_MAP
  FROM 'snow://workspace/USER$.PUBLIC."sfguide-build-fleet-intelligence-with-cortex-code"/versions/live/fleet-map'
  MAIN_FILE = 'streamlit_app.py'
  QUERY_WAREHOUSE = {{WAREHOUSE}}
  COMMENT = 'Fleet Explorer - Snowflake branded geospatial analytics with ORS';
```

## Pre-deploy: Ensure ORS is running

```sql
ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_APP.CORE.VROOM_SERVICE RESUME;
ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE SET AUTO_SUSPEND_SECS = 0;
ALTER SERVICE OPENROUTESERVICE_APP.CORE.VROOM_SERVICE SET AUTO_SUSPEND_SECS = 0;
```

Wait ~2 minutes for ORS graph to load before testing Directions/Isochrones/Optimization.
