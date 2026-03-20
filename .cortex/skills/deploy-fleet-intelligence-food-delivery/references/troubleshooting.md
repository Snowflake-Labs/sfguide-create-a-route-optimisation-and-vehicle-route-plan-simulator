# Troubleshooting & Uninstall

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | City not provisioned — run `ROUTING.CREATE_CITY_ORS_SERVICE('{LOCATION}')` then `ROUTING.CREATE_CITY_FUNCTIONS('{LOCATION}')` |
| ORS routes failing | `CALL SYSTEM$GET_SERVICE_LOGS('FLEET_INTELLIGENCE_APP.ROUTING.ORS_SERVICE_{LOCATION}', 0, 'ors', 50)` |
| `DIRECTIONS()` returns NULL but `DIRECTIONS_{LOCATION}()` works | Generic `DIRECTIONS()` routes to default ORS (Karlsruhe graph). Always use city-specific function. |
| `MATRIX_TABULAR()` returns "out of bounds" (Error 6010) | `MATRIX_TABULAR` routes to default ORS (Karlsruhe graph). Use `MATRIX_{LOCATION}()` instead. Error: "Source point(s) out of bounds" means coordinates are outside the loaded graph area. |
| No restaurants/addresses found | Verify Overture Maps shares installed (Step 1b) |
| Missing Overture data | `CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR')` then `CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR` |
| Docker build fails | Ensure Docker running with linux/amd64 support |
| Image push fails | `snow spcs image-registry login -c {CONNECTION_NAME}` |
| `ADD VERSION` error 512020 | Use `REGISTER VERSION` (release channels enabled) |
| EAI bind fails "Object does not exist" | Must use `SYSTEM$REFERENCE()` handle via `REGISTER_SINGLE_CALLBACK` |
| `EXTERNAL_ACCESS_DOWNLOAD_REF` binding fails | Create network rule + EAI first, then: `CALL FLEET_INTELLIGENCE_APP.CORE.REGISTER_SINGLE_CALLBACK('EXTERNAL_ACCESS_DOWNLOAD_REF', 'ADD', SYSTEM$REFERENCE('EXTERNAL_ACCESS_INTEGRATION', 'FLEET_INTEL_DOWNLOAD_EAI', 'PERSISTENT', 'USAGE'))` |
| `SYSTEM$SET_REFERENCE()` fails | Cannot call from outside app. Use `REGISTER_SINGLE_CALLBACK` instead. |
| `ALTER APPLICATION ... SET REFERENCES` fails | Not a valid property. Use `REGISTER_SINGLE_CALLBACK` instead. |
| ORS graph cache stale after PBF update | Clear cached graph: `REMOVE @FLEET_INTELLIGENCE_APP.ROUTING.ORS_GRAPHS_SPCS_STAGE/{Region}/driving-car/;` then suspend/resume the service |
| ORS driving-car graph persists from old PBF | Other profiles (cycling, hgv) rebuild correctly, but driving-car may cache. Clear `ORS_GRAPHS_SPCS_STAGE/{Region}/driving-car/` explicitly. |
| Endpoint "provisioning in progress" | Wait 2-3 minutes after READY |
| Data not showing after build | Toggle city selector or reload page |
| Agent error "Unknown function SNOWFLAKE.CORTEX.COMPLETE" | `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP` |
| SPCS not picking up new image | Must use NEW tag and update manifest.yml + service YAML |
| Consumer app not offered upgrade | Release directives must be set per-channel: `ALTER APPLICATION PACKAGE ... MODIFY RELEASE CHANNEL DEFAULT SET DEFAULT RELEASE DIRECTIVE VERSION=... PATCH=...` — the standard `SET DEFAULT RELEASE DIRECTIVE` (without channel) silently does nothing on packages with release channels |
| `ADD PATCH` error 093359 | Manifest changes require full new VERSION (not patch) |
| Max versions error | Deregister old: `ALTER APPLICATION PACKAGE ... DEREGISTER VERSION ...` |
| Streamlit error 099106 "There is already a live version" | DROP and recreate the Streamlit app entirely. `ALTER ... CHECKOUT LIVE VERSION` does not reliably fix this. |
| Streamlit page shows "Travel time matrix not found" | Run Step 12 (Travel Time Matrix) to create `ROUTING.{PREFIX}_HEXAGONS` and `ROUTING.{PREFIX}_TRAVEL_TIME_MATRIX` tables |
| `SF_ADDRESSES` table not found | Use `ADDRESSES_NUMBERED` (from Step 7) instead — it has the `LOCATION` geography column |

## Complete Teardown / Uninstall

> **WARNING:** Destructive and irreversible.

Execute in order, each as separate statement:

### 1. Drop the Application
```sql
DROP APPLICATION IF EXISTS FLEET_INTELLIGENCE_APP CASCADE;
```

### 2. Drop Compute Pools
```sql
DROP COMPUTE POOL IF EXISTS FLEET_INTELLIGENCE_APP_compute_pool;
DROP COMPUTE POOL IF EXISTS FLEET_INTELLIGENCE_APP_routing_pool;
```

If still in use, suspend first:
```sql
ALTER COMPUTE POOL FLEET_INTELLIGENCE_APP_compute_pool SUSPEND;
ALTER COMPUTE POOL FLEET_INTELLIGENCE_APP_routing_pool SUSPEND;
```

### 3. Drop Application Package
```sql
DROP APPLICATION PACKAGE IF EXISTS FLEET_INTELLIGENCE_PKG;
```

### 4. Drop External Access
```sql
DROP EXTERNAL ACCESS INTEGRATION IF EXISTS fleet_intel_map_tiles_eai;
DROP EXTERNAL ACCESS INTEGRATION IF EXISTS fleet_intel_download_eai;
DROP NETWORK RULE IF EXISTS fleet_intel_map_tiles_rule;
DROP NETWORK RULE IF EXISTS fleet_intel_download_rule;
```

### 5. Drop Setup Database
```sql
DROP DATABASE IF EXISTS FLEET_INTELLIGENCE_SETUP;
```

### 6. Drop Warehouse (Optional)
```sql
DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;
```

### 7. Verify Cleanup
```sql
SHOW APPLICATIONS LIKE 'FLEET_INTELLIGENCE%';
SHOW APPLICATION PACKAGES LIKE 'FLEET_INTELLIGENCE%';
SHOW COMPUTE POOLS LIKE 'FLEET_INTELLIGENCE%';
SHOW DATABASES LIKE 'FLEET_INTELLIGENCE%';
SHOW EXTERNAL ACCESS INTEGRATIONS LIKE 'fleet_intel%';
```

All queries should return empty results.
