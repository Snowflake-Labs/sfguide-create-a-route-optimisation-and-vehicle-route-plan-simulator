   CREATE OR REPLACE NETWORK RULE ORS_OSM_NETWORK_RULE
     TYPE = HOST_PORT  MODE = EGRESS
     VALUE_LIST = ('0.0.0.0:443','0.0.0.0:80','snowflakecomputing.com','download.bbbike.org:443','download.geofabrik.de:443')
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE NETWORK RULE ORS_CARTO_NETWORK_RULE
     TYPE = HOST_PORT  MODE = EGRESS
     VALUE_LIST = ('a.basemaps.cartocdn.com:443','b.basemaps.cartocdn.com:443','c.basemaps.cartocdn.com:443','d.basemaps.cartocdn.com:443')
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_OSM_EAI
     ALLOWED_NETWORK_RULES = (ORS_OSM_NETWORK_RULE)
     ENABLED = TRUE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

   CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION ORS_CARTO_EAI
     ALLOWED_NETWORK_RULES = (ORS_CARTO_NETWORK_RULE)
     ENABLED = TRUE
     COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE COMPUTE POOL IF NOT EXISTS OPENROUTESERVICE_APP_COMPUTE_POOL
   INSTANCE_FAMILY = HIGHMEM_X64_S
   MIN_NODES = 5
   MAX_NODES = 5
   AUTO_RESUME = true
   AUTO_SUSPEND_SECS = 600;
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

CREATE SERVICE IF NOT EXISTS core.ors_service
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM spec='services/openrouteservice/openrouteservice.yaml'
   MIN_INSTANCES = 3
   MAX_INSTANCES = 3
   AUTO_SUSPEND_SECS = 14400
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

CREATE SERVICE IF NOT EXISTS core.vroom_service
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM spec='services/vroom/vroom-service.yaml'
   MIN_INSTANCES = 1
   MAX_INSTANCES = 1
   AUTO_SUSPEND_SECS = 14400
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

CREATE SERVICE IF NOT EXISTS core.routing_gateway_service
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM spec='services/gateway/routing-gateway-service.yaml'
   MIN_INSTANCES = 3
   MAX_INSTANCES = 3
   AUTO_SUSPEND_SECS = 14400
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';

CREATE SERVICE IF NOT EXISTS core.ors_control_app
   IN COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL
   FROM SPECIFICATION_FILE='services/ors_control_app/ors_control_app_service.yaml'
   MIN_INSTANCES = 1
   MAX_INSTANCES = 1
   AUTO_SUSPEND_SECS = 14400
   QUERY WAREHOUSE = ROUTING_ANALYTICS
   EXTERNAL_ACCESS_INTEGRATIONS = (ORS_OSM_NETWORK_RULE, ORS_CARTO_EAI)
   COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"ui"}}';


