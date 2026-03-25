CREATE TABLE IF NOT EXISTS core.CITY_PROVISION_JOBS (
    JOB_ID VARCHAR NOT NULL,
    REGION VARCHAR NOT NULL,
    DISPLAY_NAME VARCHAR,
    PBF_URL VARCHAR,
    PROFILES VARCHAR,
    STATUS VARCHAR DEFAULT 'PENDING',
    STAGE VARCHAR DEFAULT 'NOT_STARTED',
    MESSAGE VARCHAR,
    STATEMENT_HANDLE VARCHAR,
    CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    STARTED_AT TIMESTAMP_NTZ,
    COMPLETED_AT TIMESTAMP_NTZ,
    ERROR_MSG VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"provisioner"}}';
GRANT SELECT ON TABLE core.CITY_PROVISION_JOBS TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.CITY_PROVISION_JOBS TO APPLICATION ROLE app_user;
GRANT UPDATE ON TABLE core.CITY_PROVISION_JOBS TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.CITY_PROVISION_JOBS TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.PROVISION_CITY_WRAPPER(
    P_JOB_ID VARCHAR,
    P_REGION VARCHAR,
    P_DISPLAY_NAME VARCHAR,
    P_PBF_URL VARCHAR,
    P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT,
    P_PROFILES VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"provisioner"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    pbf_filename VARCHAR;
    svc_name VARCHAR;
    svc_status VARCHAR DEFAULT '';
    status_raw VARCHAR;
    status_json VARIANT;
    profile_count INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    UPDATE core.CITY_PROVISION_JOBS
    SET STATUS='RUNNING', STAGE='DOWNLOADING', STARTED_AT=CURRENT_TIMESTAMP(),
        MESSAGE='Inserting city metadata and downloading PBF file...'
    WHERE JOB_ID = :P_JOB_ID;

    BEGIN
        ALTER SERVICE IF EXISTS core.downloader SET AUTO_SUSPEND_SECS = 0;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    MERGE INTO core.CITY_ORS_MAP t USING (
        SELECT :P_REGION AS REGION
    ) s ON t.REGION = s.REGION
    WHEN NOT MATCHED THEN INSERT (REGION, DISPLAY_NAME, PBF_URL, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON, STATUS)
        VALUES (:P_REGION, :P_DISPLAY_NAME, :P_PBF_URL, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, 'PROVISIONING');

    pbf_filename := SPLIT_PART(:P_PBF_URL, '/', -1);
    IF (pbf_filename IS NULL OR pbf_filename = '') THEN
        pbf_filename := 'data.osm.pbf';
    END IF;
    BEGIN
        EXECUTE IMMEDIATE 'SELECT core.DOWNLOAD(''ors_spcs_stage/' || :P_REGION || ''', ''' || :pbf_filename || ''', ''' || :P_PBF_URL || ''')';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    BEGIN
        ALTER SERVICE IF EXISTS core.downloader SET AUTO_SUSPEND_SECS = 14400;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    UPDATE core.CITY_PROVISION_JOBS SET STAGE='CONFIGURING', MESSAGE='Writing ORS configuration...' WHERE JOB_ID = :P_JOB_ID;
    CALL core.WRITE_ORS_CONFIG(:P_REGION, :pbf_filename, :P_PROFILES);

    UPDATE core.CITY_PROVISION_JOBS SET STAGE='STARTING_SERVICE', MESSAGE='Creating ORS service...' WHERE JOB_ID = :P_JOB_ID;
    CALL core.SETUP_CITY_ORS(:P_REGION);

    UPDATE core.CITY_PROVISION_JOBS SET STAGE='WAITING_FOR_SERVICE', MESSAGE='Waiting for ORS service to start...' WHERE JOB_ID = :P_JOB_ID;
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);
    FOR i IN 1 TO 60 DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(10)';
        BEGIN
            EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''' || :svc_name || ''' IN SCHEMA core';
            rs := (EXECUTE IMMEDIATE 'SELECT "status" AS S FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))');
            LET c1 CURSOR FOR rs;
            FOR r IN c1 DO svc_status := r.S; END FOR;
            IF (:svc_status = 'RUNNING') THEN
                UPDATE core.CITY_PROVISION_JOBS SET MESSAGE='ORS service is RUNNING, waiting for graph...' WHERE JOB_ID = :P_JOB_ID;
                BREAK;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    UPDATE core.CITY_PROVISION_JOBS SET STAGE='BUILDING_GRAPH', MESSAGE='Service running — waiting for routing graph to load...' WHERE JOB_ID = :P_JOB_ID;
    FOR i IN 1 TO 40 DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(15)';
        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT core.ORS_STATUS(''' || :P_REGION || ''')::VARCHAR AS S');
            LET c2 CURSOR FOR rs;
            FOR r IN c2 DO status_raw := r.S; END FOR;
            status_json := TRY_PARSE_JSON(:status_raw);
            IF (status_json:service_ready::BOOLEAN = TRUE AND status_json:profiles IS NOT NULL) THEN
                profile_count := ARRAY_SIZE(OBJECT_KEYS(status_json:profiles));
                IF (:profile_count > 0) THEN
                    UPDATE core.CITY_ORS_MAP SET STATUS='DEPLOYED' WHERE REGION = :P_REGION;
                    BEGIN
                        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS core.ORS_SERVICE_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    UPDATE core.CITY_PROVISION_JOBS
                    SET STATUS='COMPLETE', STAGE='READY',
                        MESSAGE='City provisioned — ' || :profile_count || ' profile(s) ready',
                        COMPLETED_AT=CURRENT_TIMESTAMP()
                    WHERE JOB_ID = :P_JOB_ID;
                    RETURN 'Job ' || :P_JOB_ID || ' complete: ' || :profile_count || ' profiles ready';
                END IF;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END FOR;

    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS core.ORS_SERVICE_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    UPDATE core.CITY_ORS_MAP SET STATUS='DEPLOYED' WHERE REGION = :P_REGION;
    UPDATE core.CITY_PROVISION_JOBS
    SET STATUS='COMPLETE', STAGE='READY',
        MESSAGE='Service running but graph may still be loading. Check ORS_STATUS.',
        COMPLETED_AT=CURRENT_TIMESTAMP()
    WHERE JOB_ID = :P_JOB_ID;
    RETURN 'Job ' || :P_JOB_ID || ' complete (graph may still be loading)';

EXCEPTION
    WHEN OTHER THEN
        LET err_msg VARCHAR := SQLERRM;
        BEGIN
            ALTER SERVICE IF EXISTS core.downloader SET AUTO_SUSPEND_SECS = 14400;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS core.ORS_SERVICE_' || UPPER(:P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        UPDATE core.CITY_PROVISION_JOBS
        SET STATUS='ERROR', ERROR_MSG=:err_msg, COMPLETED_AT=CURRENT_TIMESTAMP()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: ' || :err_msg;
END;
$$;
GRANT USAGE ON PROCEDURE core.PROVISION_CITY_WRAPPER(VARCHAR, VARCHAR, VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT, FLOAT, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.GET_PROVISION_STATUS()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"provisioner"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR;
BEGIN
    SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
        'job_id', JOB_ID, 'region', REGION, 'display_name', COALESCE(DISPLAY_NAME, REGION),
        'profiles', COALESCE(PROFILES, ''), 'status', STATUS, 'stage', STAGE,
        'message', COALESCE(MESSAGE, ''), 'error_msg', COALESCE(ERROR_MSG, ''),
        'statement_handle', COALESCE(STATEMENT_HANDLE, ''),
        'created_at', TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD HH24:MI:SS'),
        'started_at', COALESCE(TO_VARCHAR(STARTED_AT, 'YYYY-MM-DD HH24:MI:SS'), ''),
        'completed_at', COALESCE(TO_VARCHAR(COMPLETED_AT, 'YYYY-MM-DD HH24:MI:SS'), '')
    )), ARRAY_CONSTRUCT())::VARCHAR INTO result
    FROM core.CITY_PROVISION_JOBS
    WHERE CREATED_AT > DATEADD('day', -30, CURRENT_TIMESTAMP())
    ORDER BY CREATED_AT DESC;
    RETURN result;
END;
$$;
GRANT USAGE ON PROCEDURE core.GET_PROVISION_STATUS() TO APPLICATION ROLE app_user;

-- =============================================================================
-- MULTI-CITY: Per-region ORS instances with city-prefixed functions
-- =============================================================================

CREATE TABLE IF NOT EXISTS core.CITY_ORS_MAP (
    REGION VARCHAR,
    DISPLAY_NAME VARCHAR,
    PBF_URL VARCHAR,
    MIN_LAT FLOAT,
    MAX_LAT FLOAT,
    MIN_LON FLOAT,
    MAX_LON FLOAT,
    STATUS VARCHAR DEFAULT 'NOT_DEPLOYED',
    CREATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
    UPDATED_AT TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-city"}}';
GRANT SELECT ON TABLE core.CITY_ORS_MAP TO APPLICATION ROLE app_user;
GRANT INSERT ON TABLE core.CITY_ORS_MAP TO APPLICATION ROLE app_user;
GRANT UPDATE ON TABLE core.CITY_ORS_MAP TO APPLICATION ROLE app_user;
GRANT DELETE ON TABLE core.CITY_ORS_MAP TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_city_ors_service(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-city"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    db_name VARCHAR;
    pool_name VARCHAR;
    svc_name VARCHAR;
    ors_spec VARCHAR;
    create_sql VARCHAR;
BEGIN
    db_name := (SELECT CURRENT_DATABASE());
    pool_name := db_name || '_compute_pool';
    svc_name := 'ORS_SERVICE_' || UPPER(:P_REGION);

    CREATE COMPUTE POOL IF NOT EXISTS IDENTIFIER(:pool_name)
        INSTANCE_FAMILY = HIGHMEM_X64_S
        MIN_NODES = 1
        MAX_NODES = 10
        AUTO_RESUME = TRUE
        AUTO_SUSPEND_SECS = 14400;

    ors_spec := '{"spec":{"containers":[{"name":"ors","image":"/openrouteservice_setup/public/image_repository/openrouteservice:v9.0.0","volumeMounts":[{"name":"files","mountPath":"/home/ors/files"},{"name":"graphs","mountPath":"/home/ors/graphs"},{"name":"elevation-cache","mountPath":"/home/ors/elevation_cache"}],"env":{"REBUILD_GRAPHS":"false","ORS_CONFIG_LOCATION":"/home/ors/files/ors-config.yml","XMS":"3G","XMX":"20G"}}],"endpoints":[{"name":"ors","port":8082,"public":false}],"volumes":[{"name":"files","source":"@CORE.ORS_SPCS_STAGE/' || :P_REGION || '"},{"name":"graphs","source":"@CORE.ORS_GRAPHS_SPCS_STAGE/' || :P_REGION || '"},{"name":"elevation-cache","source":"@CORE.ORS_elevation_cache_SPCS_STAGE/' || :P_REGION || '"}]}}';

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS core.' || svc_name;
    create_sql := 'CREATE SERVICE core.' || svc_name || ' IN COMPUTE POOL ' || pool_name || ' FROM SPECIFICATION ''' || ors_spec || ''' MIN_INSTANCES = 1 MAX_INSTANCES = 1 AUTO_SUSPEND_SECS = 0';
    EXECUTE IMMEDIATE :create_sql;

    EXECUTE IMMEDIATE 'GRANT OPERATE ON SERVICE core.' || svc_name || ' TO APPLICATION ROLE app_user';
    EXECUTE IMMEDIATE 'GRANT MONITOR ON SERVICE core.' || svc_name || ' TO APPLICATION ROLE app_user';

    UPDATE core.CITY_ORS_MAP SET STATUS = 'DEPLOYED', UPDATED_AT = CURRENT_TIMESTAMP() WHERE REGION = :P_REGION;

    RETURN 'City ORS service created for region ' || :P_REGION || ': ' || svc_name;
END;
$$;
GRANT USAGE ON PROCEDURE core.create_city_ors_service(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.create_city_functions(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-city"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    LET fn_dir VARCHAR := 'DIRECTIONS_' || UPPER(:P_REGION);
    LET city_path VARCHAR := '/city/' || :P_REGION;

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.' || fn_dir || '(method VARCHAR, jstart ARRAY, jend ARRAY)
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/directions_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.' || fn_dir || '(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.' || fn_dir || '(method VARCHAR, locations VARIANT)
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/directions''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.' || fn_dir || '(VARCHAR, VARIANT) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.ISOCHRONES_' || UPPER(:P_REGION) || '(method TEXT, lon FLOAT, lat FLOAT, range INT)
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/isochrones_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.ISOCHRONES_' || UPPER(:P_REGION) || '(TEXT, FLOAT, FLOAT, INT) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.MATRIX_' || UPPER(:P_REGION) || '(method VARCHAR, origin ARRAY, destinations ARRAY)
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/matrix_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.MATRIX_' || UPPER(:P_REGION) || '(VARCHAR, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE FUNCTION core.OPTIMIZATION_' || UPPER(:P_REGION) || '(jobs ARRAY, vehicles ARRAY, matrices ARRAY DEFAULT [])
        RETURNS VARIANT
        SERVICE=core.routing_gateway_service
        ENDPOINT=''gateway''
        MAX_BATCH_ROWS = 1000
        AS ''' || city_path || '/optimization_tabular''';
    EXECUTE IMMEDIATE 'GRANT USAGE ON FUNCTION core.OPTIMIZATION_' || UPPER(:P_REGION) || '(ARRAY, ARRAY, ARRAY) TO APPLICATION ROLE app_user';

    RETURN 'City routing functions created for region ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE core.create_city_functions(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.write_ors_config(P_REGION VARCHAR, P_PBF_FILE VARCHAR, P_PROFILES VARCHAR)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-city"}}'
EXECUTE AS OWNER
AS
$$
def run(session, p_region, p_pbf_file, p_profiles):
    import tempfile, os

    profiles_list = [p.strip() for p in p_profiles.split(',') if p.strip()]
    all_profiles = [
        'driving-car', 'driving-hgv', 'cycling-regular', 'cycling-road',
        'cycling-mountain', 'cycling-electric', 'foot-walking', 'foot-hiking', 'wheelchair'
    ]

    profile_lines = []
    for p in all_profiles:
        enabled = 'true' if p in profiles_list else 'false'
        profile_lines.append('      ' + p + ':\n        enabled: ' + enabled)

    all_profiles_str = ', '.join(all_profiles)
    lines = [
        'ors:',
        '  engine:',
        '    profile_default:',
        '      build:',
        '        source_file: /home/ors/files/' + p_pbf_file,
        '        instructions: false',
        '      service:',
        '        maximum_distance: 1500000',
        '        maximum_distance_dynamic_weights: 1500000',
        '        maximum_distance_avoid_areas: 1500000',
        '        maximum_distance_alternative_routes: 1500000',
        '        maximum_distance_round_trip_routes: 1500000',
        '        maximum_visited_nodes: 100000000',
        '    profiles:',
    ]
    yaml_content = '\n'.join(lines) + '\n' + '\n'.join(profile_lines) + '\n'
    yaml_content += '\n'.join([
        '  endpoints:',
        '    matrix:',
        '      maximum_visited_nodes: 100000000',
        '      maximum_routes: 250000',
        '    isochrones:',
        '      maximum_locations: 2',
        '      maximum_intervals: 10',
        '      maximum_range_distance:',
        '        - profiles: ' + all_profiles_str,
        '          value: 1500000',
        '      maximum_range_time:',
        '        - profiles: ' + all_profiles_str,
        '          value: 18000',
        '',
    ])

    tmpdir = tempfile.mkdtemp()
    config_path = os.path.join(tmpdir, 'ors-config.yml')
    with open(config_path, 'w') as f:
        f.write(yaml_content)

    try:
        stage_path = '@CORE.ORS_SPCS_STAGE/' + p_region + '/'
        session.file.put(config_path, stage_path, auto_compress=False, overwrite=True)
    finally:
        os.unlink(config_path)
        os.rmdir(tmpdir)

    return 'ORS config written for ' + p_region + ' with profiles: ' + p_profiles
$$;
GRANT USAGE ON PROCEDURE core.write_ors_config(VARCHAR, VARCHAR, VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.setup_city_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-city"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    CALL core.create_compute_pool();
    CALL core.create_stages();
    CALL core.create_city_ors_service(:P_REGION);
    CALL core.create_services();
    SELECT SYSTEM$WAIT(30);
    RETURN 'City ORS deployed for region: ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE core.setup_city_ors(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.resume_city_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-city"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    LET svc_name VARCHAR := 'ORS_SERVICE_' || UPPER(:P_REGION);
    EXECUTE IMMEDIATE 'ALTER SERVICE core.' || svc_name || ' RESUME';
    BEGIN
        ALTER SERVICE IF EXISTS core.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    RETURN 'Resumed ORS services for ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE core.resume_city_ors(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.drop_city_ors(P_REGION VARCHAR)
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-city"}}'
EXECUTE AS OWNER
AS
$$
BEGIN
    LET svc_name VARCHAR := 'ORS_SERVICE_' || UPPER(:P_REGION);

    EXECUTE IMMEDIATE 'DROP SERVICE IF EXISTS core.' || svc_name;

    DELETE FROM core.CITY_ORS_MAP WHERE REGION = :P_REGION;

    RETURN 'Dropped city ORS for ' || :P_REGION;
END;
$$;
GRANT USAGE ON PROCEDURE core.drop_city_ors(VARCHAR) TO APPLICATION ROLE app_user;

CREATE OR REPLACE PROCEDURE core.list_cities()
RETURNS STRING
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"build-routing-solution","version":"1.0","attributes":{"component":"multi-city"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR;
BEGIN
    SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
        'region', REGION,
        'display_name', DISPLAY_NAME,
        'status', STATUS,
        'bbox', OBJECT_CONSTRUCT('min_lat', MIN_LAT, 'max_lat', MAX_LAT, 'min_lon', MIN_LON, 'max_lon', MAX_LON)
    ))::VARCHAR INTO result
    FROM core.CITY_ORS_MAP;
    RETURN COALESCE(result, '[]');
END;
$$;
GRANT USAGE ON PROCEDURE core.list_cities() TO APPLICATION ROLE app_user;
