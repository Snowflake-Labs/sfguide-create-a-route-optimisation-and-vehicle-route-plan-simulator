CREATE APPLICATION ROLE IF NOT EXISTS app_user;
CREATE SCHEMA IF NOT EXISTS core
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"core"}}';
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_user;

CREATE SCHEMA IF NOT EXISTS travel_matrix
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"matrix"}}';
GRANT USAGE ON SCHEMA travel_matrix TO APPLICATION ROLE app_user;

EXECUTE IMMEDIATE FROM 'modules/01_core_infra.sql';
EXECUTE IMMEDIATE FROM 'modules/02_routing_functions.sql';
EXECUTE IMMEDIATE FROM 'modules/03_city_management.sql';
EXECUTE IMMEDIATE FROM 'modules/04_service_lifecycle.sql';
EXECUTE IMMEDIATE FROM 'modules/05_matrix_pipeline.sql';
EXECUTE IMMEDIATE FROM 'modules/06_matrix_ops.sql';
