## Step 6: Upload Streamlit Files

```bash
snow stage copy assets/streamlit/retail_catchment.py @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
snow stage copy assets/streamlit/environment.yml @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
snow stage copy assets/streamlit/extra.css @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
snow stage copy assets/streamlit/logo.svg @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
snow stage copy assets/streamlit/config.toml @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE --overwrite
```

Verify:

```sql
LIST @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE;
```

## Step 7: Create Streamlit App

```sql
CREATE OR REPLACE STREAMLIT FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_CATCHMENT_APP
    FROM @FLEET_INTELLIGENCE.RETAIL_CATCHMENT.STREAMLIT_STAGE
    MAIN_FILE = 'retail_catchment.py'
    QUERY_WAREHOUSE = 'ROUTING_ANALYTICS'
    TITLE = 'Retail Catchment Application'
    COMMENT = '{"origin":"sf_sit-is-fleet", "name":"oss-retail-catchment", "version":{"major":1, "minor":0}, "attributes":{"is_quickstart":1, "source":"streamlit"}}';

ALTER STREAMLIT FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_CATCHMENT_APP ADD LIVE VERSION FROM LAST;
```

## Step 8: Verify and Launch

```sql
SHOW STREAMLITS IN SCHEMA FLEET_INTELLIGENCE.RETAIL_CATCHMENT;

SELECT CONCAT('https://app.snowflake.com/', CURRENT_ORGANIZATION_NAME(), '/', CURRENT_ACCOUNT_NAME(), '/#/streamlit-apps/FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_CATCHMENT_APP') AS streamlit_url;
```
