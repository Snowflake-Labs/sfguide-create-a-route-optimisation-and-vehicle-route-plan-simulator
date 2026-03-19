# Troubleshooting & Uninstall

## Troubleshooting

| Issue | Solution |
|-------|----------|
| ORS routes returning NULL | City not provisioned — run `ROUTING.CREATE_CITY_ORS_SERVICE()` |
| ORS routes failing | `CALL SYSTEM$GET_SERVICE_LOGS('FLEET_INTELLIGENCE_APP.ROUTING.ORS_SERVICE', 0, 'ors', 50)` |
| No restaurants/addresses found | Verify Overture Maps shares installed (Step 1b) |
| Missing Overture data | `CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR')` then `CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR` |
| Docker build fails | Ensure Docker running with linux/amd64 support |
| Image push fails | `snow spcs image-registry login -c {CONNECTION_NAME}` |
| `ADD VERSION` error 512020 | Use `REGISTER VERSION` (release channels enabled) |
| EAI bind fails "Object does not exist" | Must use `SYSTEM$REFERENCE()` handle |
| Endpoint "provisioning in progress" | Wait 2-3 minutes after READY |
| Data not showing after build | Toggle city selector or reload page |
| Agent error "Unknown function SNOWFLAKE.CORTEX.COMPLETE" | `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION FLEET_INTELLIGENCE_APP` |
| SPCS not picking up new image | Must use NEW tag and update manifest.yml + service YAML |
| `ADD PATCH` error 093359 | Manifest changes require full new VERSION (not patch) |
| Max versions error | Deregister old: `ALTER APPLICATION PACKAGE ... DEREGISTER VERSION ...` |

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
