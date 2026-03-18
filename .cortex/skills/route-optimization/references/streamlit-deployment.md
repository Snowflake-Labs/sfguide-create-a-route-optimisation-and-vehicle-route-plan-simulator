# Streamlit Deployment Reference

Detailed instructions for Step 9 of the route-optimization workflow.

## Update Default Location

Open `assets/streamlit/routing.py` and find:
```python
place_input = st.text_input('Choose Input', 'Golden Gate Bridge, San Francisco')
```

If it already matches `<NOTEBOOK_CITY>`, skip modification. Otherwise, update to a well-known landmark:

| City | Landmark |
|------|----------|
| London | `'Big Ben, London'` |
| Paris | `'Eiffel Tower, Paris'` |
| Berlin | `'Brandenburg Gate, Berlin'` |
| Zurich | `'Zurich Main Station, Zurich'` |
| New York | `'Empire State Building, New York'` |
| Tokyo | `'Tokyo Tower, Tokyo'` |
| Sydney | `'Sydney Opera House, Sydney'` |

For other cities, choose a well-known central landmark.

## Deploy to Snowflake

1. Create stage:
   ```sql
   CREATE STAGE IF NOT EXISTS OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT 
   DIRECTORY = (ENABLE = TRUE) 
   ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
   COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-route-optimization-demo", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';
   ```

2. Upload files:
   ```bash
   snow stage copy "assets/streamlit/routing.py" \
     @OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite
   
   snow stage copy "assets/streamlit/extra.css" \
     @OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite
   
   snow stage copy "assets/streamlit/environment.yml" \
     @OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite
   
   snow stage copy "assets/streamlit/logo.svg" \
     @OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite

   snow stage copy "assets/streamlit/config.toml" \
     @OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT --connection <ACTIVE_CONNECTION> --overwrite
   ```

3. Create the Streamlit app:
   ```sql
   CREATE OR REPLACE STREAMLIT OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR.SIMULATOR
   FROM  @OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR.STREAMLIT
   MAIN_FILE = 'routing.py'
   QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
   TITLE = 'Simulator'
   COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-deploy-route-optimization-demo", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';

   ALTER STREAMLIT OPENROUTESERVICE_SETUP.VEHICLE_ROUTING_SIMULATOR.SIMULATOR ADD LIVE VERSION FROM LAST;
   ```

The Streamlit app automatically detects available routing methods by reading `ors-config.yml` from `@OPENROUTESERVICE_SETUP.PUBLIC.ORS_SPCS_STAGE`. It extracts profiles with `enabled: true` and populates the "Choose Method" dropdowns. If the config cannot be read, it falls back to: `driving-car`, `driving-hgv`, `cycling-road`.
