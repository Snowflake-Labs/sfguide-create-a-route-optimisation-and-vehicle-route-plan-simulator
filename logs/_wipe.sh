#!/usr/bin/env bash
set +e
export SNOWFLAKE_CLI_NO_UPDATE_CHECK=true
C=TIB
TAG='{"origin":"sf_sit-is-fleet","name":"oss-routing-solution-cleanup","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
for AG in FLEET_AGENT FLEET_OPS_AGENT FLEET_ADMIN_AGENT FLEET_SUPER_AGENT; do
  snow sql -q "ALTER SESSION SET query_tag='$TAG'; ALTER SNOWFLAKE INTELLIGENCE SNOWFLAKE_INTELLIGENCE_OBJECT_DEFAULT DROP AGENT FLEET_INTELLIGENCE.SYNAPSE_USER.$AG;" -c $C >/dev/null 2>&1
done
echo "cowork agents deregistered"
for DB in FLEET_APP STARTER_APP MOCK_SAP MOCK_TELEMATICS OPENROUTESERVICE_APP FLEET_INTELLIGENCE SYNTHETIC_DATASETS ROUTING_PLATFORM; do
  snow sql -q "ALTER SESSION SET query_tag='$TAG'; DROP DATABASE IF EXISTS $DB CASCADE;" -c $C 2>&1 | grep -iE "successfully dropped|error" | tail -1
done
for P in FLEET_APPS_COMPUTE_POOL OPENROUTESERVICE_APP_COMPUTE_POOL ORS_POOL_SANFRANCISCO ORS_POOL_UNITEDSTATESOFAMERICA ORS_POOL_USTEXAS; do
  snow sql -q "ALTER SESSION SET query_tag='$TAG'; ALTER COMPUTE POOL IF EXISTS $P STOP ALL; DROP COMPUTE POOL IF EXISTS $P;" -c $C 2>&1 | grep -iE "$P successfully" | tail -1
done
snow sql -q "ALTER SESSION SET query_tag='$TAG'; DROP WAREHOUSE IF EXISTS ROUTING_ANALYTICS;" -c $C 2>&1 | grep -iE "ROUTING_ANALYTICS successfully"
for E in FLEET_APP_CARTO_EAI ORS_CARTO_EAI FLEET_APP_OSM_EAI ORS_OSM_EAI; do
  snow sql -q "ALTER SESSION SET query_tag='$TAG'; DROP INTEGRATION IF EXISTS $E;" -c $C 2>&1 | grep -iE "$E successfully" | tail -1
done
for R in FLEET_APP_USER FLEET_APP_OPS FLEET_APP_ADMIN FLEET_APP_DYNAMIC_READER; do
  snow sql -q "ALTER SESSION SET query_tag='$TAG'; DROP ROLE IF EXISTS $R;" -c $C 2>&1 | grep -iE "$R successfully" | tail -1
done
echo "=== VERIFY ==="
snow sql -q "SHOW DATABASES;" -c $C --format csv 2>&1 | cut -d, -f2 | grep -iE "OPENROUTE|FLEET|SYNTHETIC|ROUTING_PLATFORM|STARTER|MOCK_SAP|MOCK_TELEM" || echo "DBs CLEAN"
snow sql -q "SHOW COMPUTE POOLS;" -c $C --format csv 2>&1 | cut -d, -f1 | grep -iE "OPENROUTE|FLEET|ORS_POOL" || echo "POOLS CLEAN"
snow sql -q "SHOW ROLES LIKE 'FLEET_APP%';" -c $C --format csv 2>&1 | cut -d, -f2 | grep -i FLEET || echo "ROLES CLEAN"
