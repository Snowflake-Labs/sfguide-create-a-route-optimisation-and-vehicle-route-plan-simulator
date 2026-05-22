# Troubleshooting -- emergency-response skill

| Issue | Cause | Resolution |
|---|---|---|
| `SYSTEM$ACCEPT_LEGAL_TERMS` errors with insufficient privileges | Role lacks `IMPORT SHARE` on account | Run Step 0a as `ACCOUNTADMIN` once, then re-run remainder of pipeline as `EMERGENCY_RESPONSE_ROLE` |
| `CREATE DATABASE FROM LISTING` fails with "listing not found" | Listing GUID changed or region not supported | Verify GUID in marketplace UI; install region must support the listing (check Marketplace listing page for supported regions) |
| `STG_NWS_ACTIVE_ALERTS` empty | No live NWS alert intersects region today | Insert a row into `SOURCE.MOCK_ALERTS` (see `assets/sample_alerts.geojson`) |
| Marketplace listing not visible | Listing not installed or wrong role | Re-install free listing from Marketplace; ensure role has `IMPORTED PRIVILEGES` on the share |
| `NRI_SCH.NRI_CENSUSTRACTS` does not exist | kipi.ai listing not installed | Install [GZSTZKU9FH9](https://app.snowflake.com/marketplace/listing/GZSTZKU9FH9/) |
| `public_data.us_addresses` missing | Snowflake Public Data Free not installed | Install [GZTSZ290BV255](https://app.snowflake.com/marketplace/listing/GZTSZ290BV255/) |
| `FACT_REACHABILITY_BY_CENTER` errors with InvalidGeoJsonObject | Polygon has self-intersection or Z values | Wrap UDF call body with `ST_BUFFER(ST_FORCE2D(boundary), 0)` |
| `FACT_DISPATCH_PLAN` returns NULL | No drivers ON_SHIFT or no impacted participants | Check `SELECT STATUS, COUNT(*) FROM CORE.DRIVERS GROUP BY 1` |
| ORS service times out on big polygons | Statewide alert geometry too complex | Pre-simplify in source view: `ST_SIMPLIFY(boundary, 200)` |
| All 5 pages render but "no data" | Pipeline DTs not yet refreshed | `SHOW DYNAMIC TABLES IN SCHEMA EMERGENCY_RESPONSE.PIPELINE;` -- check refresh status |
| Page 4 dispatch button errors 500 | Region not provisioned in ORS | `SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;` -- ensure VROOM_SERVICE_<REGION> RUNNING |
| Tracking tag missing on objects | CTAS pattern -- inline COMMENT not supported | Use `ALTER ... SET COMMENT` immediately after CREATE (per AGENTS.md) |
| `ROUTING_ANALYTICS` warehouse missing | Not created yet | `CREATE WAREHOUSE ROUTING_ANALYTICS WAREHOUSE_SIZE='X-SMALL' AUTO_SUSPEND=60 COMMENT='...';` |

## Verification commands

```sql
-- 1. Marketplace data accessible
SELECT COUNT(*) FROM SNOWFLAKE_PUBLIC_DATA_FREE.public_data.geography_index;
SELECT COUNT(*) FROM SNOWFLAKE_PUBLIC_DATA_FREE.public_data.nws_alert_index;
SELECT COUNT(*) FROM FEMA_NATIONAL_RISK_INDEX.NRI_SCH.NRI_CENSUSTRACTS;

-- 2. ORS up
SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP;

-- 3. Pipeline live
SELECT 'STG_NWS_ACTIVE_ALERTS', COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.STG_NWS_ACTIVE_ALERTS
UNION ALL SELECT 'CORE.PARTICIPANTS', COUNT(*) FROM EMERGENCY_RESPONSE.CORE.PARTICIPANTS
UNION ALL SELECT 'CORE.CENTERS',      COUNT(*) FROM EMERGENCY_RESPONSE.CORE.CENTERS
UNION ALL SELECT 'CORE.DRIVERS',      COUNT(*) FROM EMERGENCY_RESPONSE.CORE.DRIVERS
UNION ALL SELECT 'FACT_IMPACTED',     COUNT(*) FROM EMERGENCY_RESPONSE.PIPELINE.FACT_IMPACTED_PARTICIPANTS;
```
