USE SCHEMA OPENROUTESERVICE_APP.CORE;   

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"05_matrix_pipeline"}}';

CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS (
    JOB_ID VARCHAR NOT NULL,
    REGION VARCHAR NOT NULL,
    PROFILE VARCHAR NOT NULL,
    RESOLUTION VARCHAR NOT NULL,
    STATUS VARCHAR DEFAULT 'PENDING',
    STAGE VARCHAR DEFAULT 'NOT_STARTED',
    HEXAGONS NUMBER DEFAULT 0,
    WORK_QUEUE_ROWS NUMBER DEFAULT 0,
    RAW_ROWS NUMBER DEFAULT 0,
    MATRIX_ROWS NUMBER DEFAULT 0,
    PCT_COMPLETE FLOAT DEFAULT 0,
    MESSAGE VARCHAR,
    ERROR_MSG VARCHAR,
    STATEMENT_HANDLE VARCHAR,
    CREATED_AT TIMESTAMP_NTZ DEFAULT SYSDATE(),
    STARTED_AT TIMESTAMP_NTZ,
    COMPLETED_AT TIMESTAMP_NTZ,
    -- Filter-related columns: previously added via post-hoc
    -- ALTER TABLE ... ADD COLUMN IF NOT EXISTS statements which triggered a
    -- Snowflake compile-time bug (ambiguous column name 'ROAD_FILTER') on
    -- re-runs against accounts where the columns already existed. Folding
    -- them into the canonical CREATE TABLE eliminates that path for fresh
    -- installs; the EXCEPTION-wrapped ALTERs below cover legacy tables.
    ROAD_FILTER BOOLEAN DEFAULT FALSE,
    HEXAGONS_BEFORE_FILTER NUMBER DEFAULT 0,
    HEXAGONS_AFTER_FILTER NUMBER DEFAULT 0,
    FILTER_DURATION_SECONDS FLOAT DEFAULT 0,
    -- Routability accounting, kept separate from the ROAD_FILTER columns above
    -- because it answers a different question. ROAD_FILTER records what the
    -- USER chose (a coverage and cost preference); these record what the build
    -- had to remove for correctness, which happens either way. Reported so a
    -- shrinking cell count is explainable rather than mysterious.
    HEXAGONS_BEFORE_ROUTABILITY NUMBER DEFAULT 0,
    HEXAGONS_AFTER_ROUTABILITY NUMBER DEFAULT 0,
    ROUTABILITY_DURATION_SECONDS FLOAT DEFAULT 0,
    ROUTABILITY_NOTE VARCHAR,
    -- Set when the user ASKED for road-aware filtering and did not get it.
    -- Previously this reverted to unfiltered tessellation and said so only in
    -- MESSAGE, which MATRIX_PROGRESS does not expose, so the build reported
    -- clean and the user never learned their choice was dropped.
    FILTER_WARNING VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}';

-- Legacy backfill for accounts that created MATRIX_BUILD_JOBS before the
-- four filter columns were folded into the canonical CREATE TABLE above.
-- Wrapped in anonymous blocks because Snowflake's ADD COLUMN IF NOT EXISTS
-- can throw "ambiguous column name" at compile time when the column already
-- exists with a DEFAULT clause. We swallow that error so the script keeps
-- running.
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS ROAD_FILTER BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS HEXAGONS_BEFORE_FILTER NUMBER DEFAULT 0;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS HEXAGONS_AFTER_FILTER NUMBER DEFAULT 0;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS FILTER_DURATION_SECONDS FLOAT DEFAULT 0;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;
-- One block per column: sharing a block would skip every later column on any
-- account that already has the first one (first statement raises, the handler
-- swallows it, the rest never run).
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS HEXAGONS_BEFORE_ROUTABILITY NUMBER DEFAULT 0;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS HEXAGONS_AFTER_ROUTABILITY NUMBER DEFAULT 0;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS ROUTABILITY_DURATION_SECONDS FLOAT DEFAULT 0;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS ROUTABILITY_NOTE VARCHAR;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;
EXECUTE IMMEDIATE $$
BEGIN
    ALTER TABLE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        ADD COLUMN IF NOT EXISTS FILTER_WARNING VARCHAR;
EXCEPTION WHEN OTHER THEN RETURN 'skipped';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.ENSURE_MATRIX_TABLES(P_REGION VARCHAR, P_PROFILE VARCHAR, P_RES VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    list_table VARCHAR;
    wq_table VARCHAR;
    raw_table VARCHAR;
    matrix_table VARCHAR;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');

    list_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    wq_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;
    matrix_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || list_table || ' (H3_INDEX VARCHAR, CENTER_POINT GEOGRAPHY) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}''';

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || wq_table || ' (SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, ORIGIN_POINT GEOGRAPHY, DEST_COORDS ARRAY, DEST_HEX_IDS ARRAY) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}''';

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || raw_table || ' (SEQ_ID INTEGER, ORIGIN_H3 VARCHAR, DEST_HEX_IDS ARRAY, MATRIX_RESULT VARIANT) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}''';

    EXECUTE IMMEDIATE 'CREATE TABLE IF NOT EXISTS ' || matrix_table || ' (ORIGIN_H3 VARCHAR, DEST_H3 VARCHAR, TRAVEL_TIME_SECONDS FLOAT, TRAVEL_DISTANCE_METERS FLOAT, CALCULATED_AT TIMESTAMP_LTZ DEFAULT SYSDATE()) COMMENT = ''{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}''';
    RETURN 'Tables ensured: ' || list_table || ', ' || wq_table || ', ' || raw_table || ', ' || matrix_table;
END;
$$;

-- =============================================================================
-- TRAVEL TIME MATRIX: Pipeline procedures
-- =============================================================================

-- Warning ledger: rows are inserted whenever BUILD_HEXAGONS or
-- BUILD_HEXAGONS_ROAD_AWARE cannot resolve P_REGION to a REGION_CATALOG
-- polygon and falls back to the rectangular bbox. The rectangle nearly
-- always over-covers (e.g. California bbox spans Nevada/Oregon/Mexico/Pacific)
-- so any row here means the matrix for that region is built on a fallback
-- that will silently leak hexes outside the intended boundary.
CREATE TABLE IF NOT EXISTS OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BBOX_FALLBACK_WARNINGS (
    LOGGED_AT TIMESTAMP_NTZ DEFAULT SYSDATE(),
    REGION VARCHAR,
    PROFILE VARCHAR,
    RESOLUTION VARCHAR,
    PROC_NAME VARCHAR,
    BBOX_MIN_LAT FLOAT,
    BBOX_MAX_LAT FLOAT,
    BBOX_MIN_LON FLOAT,
    BBOX_MAX_LON FLOAT,
    MESSAGE VARCHAR
)
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix","feature":"bbox-fallback-warning"}}';

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    resolution INTEGER;
    hex_table VARCHAR;
    safe_profile VARCHAR;
    row_count INTEGER;
    catalog_match INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;

    IF (P_RES = 'RES5') THEN
        resolution := 5;
    ELSEIF (P_RES = 'RES6') THEN
        resolution := 6;
    ELSEIF (P_RES = 'RES7') THEN
        resolution := 7;
    ELSEIF (P_RES = 'RES8') THEN
        resolution := 8;
    ELSEIF (P_RES = 'RES9') THEN
        resolution := 9;
    ELSE
        resolution := 10;
    END IF;

    -- Detect catalog match BEFORE the COALESCE so we can warn loudly
    -- when no row exists and we are about to silently fall back to bbox.
    SELECT COUNT(*) INTO :catalog_match
    FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
    WHERE BOUNDARY IS NOT NULL
      AND (UPPER(LOOKUP_NAME) = UPPER(:P_REGION) OR UPPER(REGION_KEY) = UPPER(:P_REGION));

    IF (catalog_match = 0) THEN
        INSERT INTO OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BBOX_FALLBACK_WARNINGS
            (REGION, PROFILE, RESOLUTION, PROC_NAME, BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON, MESSAGE)
        VALUES
            (:P_REGION, :P_PROFILE, :P_RES, 'BUILD_HEXAGONS', :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON,
             'No REGION_CATALOG row matched LOOKUP_NAME / REGION_KEY = ' || :P_REGION || '. Falling back to rectangular bbox; hexes outside the intended polygon will be tessellated.');
    END IF;

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || hex_table;

    -- Land-clip the boundary before tessellating. BOUNDARY is a PBF *extract*
    -- polygon, not a land outline, so on coastal regions it contains open sea
    -- (measured: UsTexas 833,217 km2 vs ~695,700 km2 of Texas land). Cells in
    -- open water are refused by ORS with `6010 ... out of bounds`, and because
    -- BUILD_WORK_QUEUE hash-chunks destinations, a minority of water cells
    -- poisons EVERY chunk and zeroes the whole build.
    --
    -- Independent of the caller's road-filter choice ON PURPOSE. Road-aware
    -- filtering is a coverage and cost preference - "off" means the user wants
    -- a uniform grid over the region, which is legitimate. It does not mean the
    -- user wants grid cells in the sea. Routability is a correctness
    -- precondition, so it is applied in both paths and neither default moves.
    --
    -- Idempotent and cached; leaves ROUTABLE_BOUNDARY NULL on any failure so
    -- the COALESCE below falls back to today's unclipped behaviour.
    CALL OPENROUTESERVICE_APP.CORE.ENSURE_ROUTABLE_BOUNDARY(:P_REGION);

    -- Boundary-aware: enumerate H3 cells inside the region's actual polygon
    -- (from REGION_CATALOG) when available, otherwise fall back to bbox.
    -- This drops water cells and out-of-region cells before any ORS Matrix call.
    EXECUTE IMMEDIATE '
    INSERT INTO ' || hex_table || ' (H3_INDEX, CENTER_POINT)
    WITH region_geom AS (
        SELECT COALESCE(
            (SELECT COALESCE(ROUTABLE_BOUNDARY, BOUNDARY) FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
             WHERE BOUNDARY IS NOT NULL
               AND (UPPER(LOOKUP_NAME) = UPPER(''' || P_REGION || ''')
                    OR UPPER(REGION_KEY) = UPPER(''' || P_REGION || '''))
             ORDER BY BOUNDARY_AREA_KM2 ASC LIMIT 1),
            TO_GEOGRAPHY(''POLYGON((' ||
                P_MIN_LON || ' ' || P_MIN_LAT || ',' ||
                P_MAX_LON || ' ' || P_MIN_LAT || ',' ||
                P_MAX_LON || ' ' || P_MAX_LAT || ',' ||
                P_MIN_LON || ' ' || P_MAX_LAT || ',' ||
                P_MIN_LON || ' ' || P_MIN_LAT || '))'')
        ) AS geom
    )
    SELECT
        h.VALUE::VARCHAR AS h3_index,
        H3_CELL_TO_POINT(h.VALUE::VARCHAR) AS center_point
    FROM region_geom r,
         TABLE(FLATTEN(H3_POLYGON_TO_CELLS_STRINGS(r.geom, ' || resolution || '))) h';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || hex_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' hexagons built: ' || row_count || ' hexagons';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS_ROAD_AWARE(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix","feature":"road-aware"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    resolution INTEGER;
    hex_table VARCHAR;
    safe_profile VARCHAR;
    row_count INTEGER;
    catalog_match INTEGER DEFAULT 0;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;

    IF (P_RES = 'RES5') THEN
        resolution := 5;
    ELSEIF (P_RES = 'RES6') THEN
        resolution := 6;
    ELSEIF (P_RES = 'RES7') THEN
        resolution := 7;
    ELSEIF (P_RES = 'RES8') THEN
        resolution := 8;
    ELSEIF (P_RES = 'RES9') THEN
        resolution := 9;
    ELSE
        resolution := 10;
    END IF;

    -- Detect catalog match BEFORE the COALESCE so we can warn loudly
    -- when no row exists and we are about to silently fall back to bbox.
    SELECT COUNT(*) INTO :catalog_match
    FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
    WHERE BOUNDARY IS NOT NULL
      AND (UPPER(LOOKUP_NAME) = UPPER(:P_REGION) OR UPPER(REGION_KEY) = UPPER(:P_REGION));

    IF (catalog_match = 0) THEN
        INSERT INTO OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BBOX_FALLBACK_WARNINGS
            (REGION, PROFILE, RESOLUTION, PROC_NAME, BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON, MESSAGE)
        VALUES
            (:P_REGION, :P_PROFILE, :P_RES, 'BUILD_HEXAGONS_ROAD_AWARE', :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON,
             'No REGION_CATALOG row matched LOOKUP_NAME / REGION_KEY = ' || :P_REGION || '. Falling back to rectangular bbox; road-aware hexes outside the intended polygon will be tessellated.');
    END IF;

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || hex_table;

    -- Same land clip as the non-road-aware path. Road-aware filtering already
    -- removes open water incidentally (measured: ZERO Overture road segments in
    -- the offshore strip that broke the UsTexas build), but it must not be the
    -- only thing standing between the grid and the sea - the user is free to
    -- turn it off, and this path also silently falls back to plain tessellation
    -- when the Overture share is unavailable.
    CALL OPENROUTESERVICE_APP.CORE.ENSURE_ROUTABLE_BOUNDARY(:P_REGION);

    -- Boundary-aware road-aware tessellation:
    --   * Keep Overture native bbox prefilter (partition prune; without it the
    --     query scans the global transportation table).
    --   * Refine road segments via ST_INTERSECTS against the region's actual
    --     polygon (REGION_CATALOG.BOUNDARY) instead of the bbox rectangle.
    --     Drops foreign-country segments that bleed across the bbox - a
    --     single foreign road would otherwise spawn dozens of out-of-graph
    --     hex candidates via H3_COVERAGE_STRINGS.
    --   * Final clip uses ST_WITHIN(centroid, BOUNDARY) instead of bbox
    --     BETWEEN, catching stray hexes whose centroid sits in foreign
    --     territory but inside the bbox.
    --   * Falls back to bbox polygon if no catalog row exists.
    EXECUTE IMMEDIATE '
    INSERT INTO ' || hex_table || ' (H3_INDEX, CENTER_POINT)
    WITH region_geom AS (
        SELECT COALESCE(
            (SELECT COALESCE(ROUTABLE_BOUNDARY, BOUNDARY) FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
             WHERE BOUNDARY IS NOT NULL
               AND (UPPER(LOOKUP_NAME) = UPPER(''' || P_REGION || ''')
                    OR UPPER(REGION_KEY) = UPPER(''' || P_REGION || '''))
             ORDER BY BOUNDARY_AREA_KM2 ASC LIMIT 1),
            TO_GEOGRAPHY(''POLYGON((' ||
                P_MIN_LON || ' ' || P_MIN_LAT || ',' ||
                P_MAX_LON || ' ' || P_MIN_LAT || ',' ||
                P_MAX_LON || ' ' || P_MAX_LAT || ',' ||
                P_MIN_LON || ' ' || P_MAX_LAT || ',' ||
                P_MIN_LON || ' ' || P_MIN_LAT || '))'')
        ) AS poly
    ),
    road_segments AS (
        SELECT s.geometry
        FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT s, region_geom r
        WHERE s.subtype = ''road''
          -- Overture native bbox prefilter (UNCHANGED - partition prune):
          AND s.bbox:xmin::FLOAT <= ' || P_MAX_LON || '
          AND s.bbox:xmax::FLOAT >= ' || P_MIN_LON || '
          AND s.bbox:ymin::FLOAT <= ' || P_MAX_LAT || '
          AND s.bbox:ymax::FLOAT >= ' || P_MIN_LAT || '
          -- Polygon refine (replaces ST_INTERSECTS against bbox polygon):
          AND ST_INTERSECTS(s.geometry, r.poly)
    ),
    road_hexes AS (
        SELECT DISTINCT c.value::VARCHAR AS h3_index
        FROM road_segments r, TABLE(FLATTEN(H3_COVERAGE_STRINGS(r.geometry, ' || resolution || '))) c
    )
    SELECT h3_index, H3_CELL_TO_POINT(h3_index) AS center_point
    FROM road_hexes h, region_geom r
    WHERE ST_WITHIN(H3_CELL_TO_POINT(h.h3_index), r.poly)';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || hex_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' road-aware hexagons built: ' || row_count || ' hexagons';
END;
$$;

-- =============================================================================
-- PRUNE_UNROUTABLE_HEXAGONS: drop cells the routing graph cannot reach
-- =============================================================================
-- Second and last line of defence after the land clip, for the residue the clip
-- cannot see. Admin polygons include internal waters, and a coarse cell can be
-- qualified by a road at its edge while its CENTROID - the point actually sent
-- to ORS - sits kilometres away: a RES5 cell is 8.5 km across.
--
-- Why this cannot be skipped as "rare": ORS matrix is all-or-nothing per
-- request, and BUILD_WORK_QUEUE chunks destinations by MOD(HASH(dest_h3), n),
-- which spreads bad cells UNIFORMLY. A single unreachable cell therefore does
-- not cost one row, it nulls every chunk containing it.
--
-- Two measured facts drive the design:
--
--   1. An out-of-graph point is unsnappable at ANY radius (the Gulf coordinate
--      that broke the UsTexas build fails at 350 m and at 20 km), while genuine
--      Texas road points snap at 3-5 m. So the radius is deliberately GENEROUS.
--      A tight radius would prune valid rural cells; a generous one prunes only
--      what ORS itself refuses, which is the whole point.
--
--   2. `/snap` is all-or-nothing too. A batch containing ONE off-graph point
--      returns a SINGLE row with IDX NULL - not per-point NULLs - so a naive
--      "snap everything and drop the NULLs" implementation would delete the
--      entire batch, i.e. quietly destroy up to 99 good cells per bad one.
--      Hence the 100 -> 10 -> 1 ladder: a failed batch is re-tried in smaller
--      pieces, and only a failure at size 1 convicts a specific cell.
--
-- Bounded on purpose. Above P_MAX_HEXES the gate is skipped with a recorded
-- note rather than run: laddering 1.1M RES8 cells is not affordable, and the
-- land clip plus road-aware filtering already carry the coarse cases where the
-- ratio of water to land is high.
--
-- NEVER empties the list. If every batch fails the cause is almost certainly
-- the engine (suspended service, wrong region, unloaded profile), not 100%
-- unroutable geography, and deleting everything would turn a recoverable stall
-- into a silent zero-row matrix.
CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.PRUNE_UNROUTABLE_HEXAGONS(
    P_RES VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR,
    P_MAX_HEXES INTEGER DEFAULT 20000, P_RADIUS INTEGER DEFAULT 20000)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix","feature":"routability-gate"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_table    VARCHAR;
    safe_profile VARCHAR;
    hex_count    INTEGER DEFAULT 0;
    unroutable   INTEGER DEFAULT 0;
    undecided    INTEGER DEFAULT 0;
    batch_size   INTEGER;
    pass_no      INTEGER DEFAULT 0;
    rs           RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'OPENROUTESERVICE_APP.TRAVEL_MATRIX.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || hex_table);
    LET c0 CURSOR FOR rs; FOR r IN c0 DO hex_count := r.CNT; END FOR;

    IF (hex_count = 0) THEN
        RETURN 'SKIPPED: hex list is empty for ' || :P_RES;
    END IF;
    IF (hex_count > :P_MAX_HEXES) THEN
        RETURN 'SKIPPED: ' || hex_count || ' cells exceeds the ' || :P_MAX_HEXES
               || '-cell routability-gate ceiling. Land clip and (if enabled) road-aware'
               || ' filtering still applied; unreachable cells may remain.';
    END IF;

    -- Session-scoped work tables (exempt from the object COMMENT rule).
    -- PENDING rows are the ones still to be decided; a row leaves PENDING only
    -- when a batch it was in returned a per-point verdict.
    CREATE OR REPLACE TEMPORARY TABLE OPENROUTESERVICE_APP.CORE.TMP_SNAP_WORK (
        H3_INDEX VARCHAR, CENTER_POINT GEOGRAPHY, PENDING BOOLEAN, ROUTABLE BOOLEAN);
    EXECUTE IMMEDIATE 'INSERT INTO OPENROUTESERVICE_APP.CORE.TMP_SNAP_WORK
        (H3_INDEX, CENTER_POINT, PENDING, ROUTABLE)
        SELECT H3_INDEX, CENTER_POINT, TRUE, NULL FROM ' || hex_table;

    -- Ladder, part 1: batches of 100 then 10. These passes can only ACQUIT or
    -- convict a point via a SUCCESSFUL response (which returns one row per
    -- input, so a NULL SNAPPED_GEOG there is a real per-point verdict). A
    -- REJECTED batch returns a single IDX-NULL row that joins to nothing, so
    -- the whole batch stays PENDING and is split by the next pass. That is the
    -- entire point of the ladder: never convict 100 cells for one bad one.
    FOR pass_no IN 1 TO 2 DO
        batch_size := CASE pass_no WHEN 1 THEN 100 ELSE 10 END;

        -- Snapshot this pass's batching into an IMMUTABLE table. Numbering the
        -- batches inside the per-batch statement instead would be a silent bug:
        -- rows leave PENDING as they are decided, so ROW_NUMBER() over the live
        -- PENDING set renumbers after every batch and batch ids 1..n would then
        -- match nothing, leaving most cells permanently undecided.
        CREATE OR REPLACE TEMPORARY TABLE OPENROUTESERVICE_APP.CORE.TMP_SNAP_BATCH AS
        SELECT H3_INDEX, CENTER_POINT,
               ROW_NUMBER() OVER (ORDER BY H3_INDEX) - 1 AS RN,
               FLOOR((ROW_NUMBER() OVER (ORDER BY H3_INDEX) - 1) / :batch_size) AS BATCH_ID
        FROM OPENROUTESERVICE_APP.CORE.TMP_SNAP_WORK
        WHERE PENDING;

        LET batch_rs RESULTSET := (
            SELECT DISTINCT BATCH_ID AS BID FROM OPENROUTESERVICE_APP.CORE.TMP_SNAP_BATCH ORDER BY BID);
        LET bc CURSOR FOR batch_rs;
        FOR b IN bc DO
            LET bid INTEGER := b.BID;
            BEGIN
                EXECUTE IMMEDIATE '
                MERGE INTO OPENROUTESERVICE_APP.CORE.TMP_SNAP_WORK t
                USING (
                    WITH b AS (
                        SELECT H3_INDEX, CENTER_POINT, RN - MIN(RN) OVER () AS POS
                        FROM OPENROUTESERVICE_APP.CORE.TMP_SNAP_BATCH
                        WHERE BATCH_ID = ' || bid || '
                    ),
                    arr AS (
                        SELECT ARRAY_AGG(ARRAY_CONSTRUCT(ST_X(CENTER_POINT), ST_Y(CENTER_POINT)))
                                 WITHIN GROUP (ORDER BY POS) AS A
                        FROM b
                    ),
                    s AS (
                        SELECT IDX, SNAPPED_GEOG
                        FROM TABLE(OPENROUTESERVICE_APP.CORE.SNAP_POINTS(
                            ''' || P_PROFILE || ''', (SELECT A FROM arr), ' || P_RADIUS || ',
                            ''' || P_REGION || '''))
                        WHERE IDX IS NOT NULL
                    )
                    SELECT b.H3_INDEX, (s.SNAPPED_GEOG IS NOT NULL) AS OK
                    FROM b JOIN s ON s.IDX = b.POS
                ) v
                ON t.H3_INDEX = v.H3_INDEX
                WHEN MATCHED THEN UPDATE SET t.PENDING = FALSE, t.ROUTABLE = v.OK';
            EXCEPTION WHEN OTHER THEN
                NULL;  -- batch stays PENDING; the next pass splits it
            END;
        END FOR;
    END FOR;

    -- Ladder, part 2: a DECISIVE single-point pass over whatever is still
    -- undecided. This step is load-bearing and its shape is deliberate.
    --
    -- Reusing the batched MERGE at size 1 does NOT work, and failing to notice
    -- that would have shipped a gate that misses the exact cells it exists to
    -- remove: an out-of-bounds point makes the request return one IDX-NULL row,
    -- so with `WHERE IDX IS NOT NULL` there is nothing to join to and the point
    -- stays PENDING - reported "undecided" and KEPT. Measured on a 3-cell
    -- ocean-only list: 0 convicted, 3 undecided. Only the in-graph
    -- "no road within radius" cells were ever being caught.
    --
    -- So here the verdict is computed as an aggregate that always yields a row:
    -- zero snapped results means unroutable. At one point per request there is
    -- no collateral - the only cell that can be convicted is the one asked
    -- about.
    LET pend_rs RESULTSET := (
        SELECT H3_INDEX, ST_X(CENTER_POINT) AS LON, ST_Y(CENTER_POINT) AS LAT
        FROM OPENROUTESERVICE_APP.CORE.TMP_SNAP_WORK WHERE PENDING);
    LET pc CURSOR FOR pend_rs;
    FOR p IN pc DO
        BEGIN
            EXECUTE IMMEDIATE '
            MERGE INTO OPENROUTESERVICE_APP.CORE.TMP_SNAP_WORK t
            USING (
                SELECT ''' || p.H3_INDEX || ''' AS H3_INDEX,
                       (SELECT COUNT(SNAPPED_GEOG)
                        FROM TABLE(OPENROUTESERVICE_APP.CORE.SNAP_POINTS(
                            ''' || P_PROFILE || ''',
                            ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(' || p.LON || '::FLOAT, ' || p.LAT || '::FLOAT)),
                            ' || P_RADIUS || ', ''' || P_REGION || '''))
                        WHERE IDX IS NOT NULL) > 0 AS OK
            ) v
            ON t.H3_INDEX = v.H3_INDEX
            WHEN MATCHED THEN UPDATE SET t.PENDING = FALSE, t.ROUTABLE = v.OK';
        EXCEPTION WHEN OTHER THEN
            NULL;  -- a hard SQL error is not evidence about the cell; keep it
        END;
    END FOR;

    SELECT COUNT(CASE WHEN NOT PENDING AND NOT ROUTABLE THEN 1 END),
           COUNT(CASE WHEN PENDING THEN 1 END)
      INTO :unroutable, :undecided
    FROM OPENROUTESERVICE_APP.CORE.TMP_SNAP_WORK;

    -- Refuse to empty the list. Reaching here with everything convicted means
    -- the engine could not answer, not that the region is unroutable.
    IF (unroutable >= hex_count) THEN
        RETURN 'ABORTED: every one of ' || hex_count || ' cells failed to snap, which indicates the'
               || ' routing engine is unavailable for region ' || :P_REGION || ' / profile '
               || :P_PROFILE || ' rather than unroutable geography. Hex list left UNCHANGED.';
    END IF;

    IF (unroutable > 0) THEN
        EXECUTE IMMEDIATE 'DELETE FROM ' || hex_table || ' WHERE H3_INDEX IN
            (SELECT H3_INDEX FROM OPENROUTESERVICE_APP.CORE.TMP_SNAP_WORK
             WHERE NOT PENDING AND NOT ROUTABLE)';
    END IF;

    -- `undecided` is reported, never deleted: a cell nobody could adjudicate is
    -- given the benefit of the doubt.
    RETURN 'PRUNED: ' || unroutable || ' unreachable of ' || hex_count || ' cells'
           || CASE WHEN undecided > 0 THEN ' (' || undecided || ' undecided, kept)' ELSE '' END || '.';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_WORK_QUEUE(P_RES VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR, P_JOB_ID VARCHAR DEFAULT NULL)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_table VARCHAR;
    queue_table VARCHAR;
    safe_profile VARCHAR;
    hex_count INTEGER;
    num_shards INTEGER;
    shard_idx INTEGER DEFAULT 0;
    total_inserted INTEGER DEFAULT 0;
    shard_rows INTEGER;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || hex_table);
    LET cnt_cursor CURSOR FOR rs;
    FOR r IN cnt_cursor DO hex_count := r.CNT; END FOR;

    num_shards := GREATEST(1, LEAST(100, CEIL(hex_count / 5000)));

    EXECUTE IMMEDIATE 'TRUNCATE TABLE ' || queue_table;

    -- The raw response table MUST be cleared with the queue. BUILD_TRAVEL_TIME_
    -- RANGE[_REGION] resumes from `MAX(SEQ_ID)` in the raw table, and this
    -- procedure reassigns SEQ_IDs from scratch over a freshly built cell list -
    -- so surviving rows are not resumable progress, they are stale rows keyed to
    -- a queue that no longer exists.
    --
    -- Leaving them made a failed build UNRETRYABLE, which is the state a user
    -- reaches immediately after any build failure: rebuilding UsTexas RES5 with
    -- the land clip and routability gate correctly produced 2,343 good cells,
    -- then issued ZERO ORS requests because 14,485 error rows from the previous
    -- 2,897-cell attempt already covered every SEQ_ID, and the job failed again
    -- on the OLD errors - reporting 2,897 origins for a 2,343-cell build. Retry
    -- could never clear it, and the counts made the fix look ineffective.
    EXECUTE IMMEDIATE 'TRUNCATE TABLE travel_matrix.' || UPPER(P_REGION) || '_'
                      || safe_profile || '_MATRIX_RAW_' || P_RES;

    FOR shard_idx IN 0 TO num_shards - 1 DO
        EXECUTE IMMEDIATE '
        INSERT INTO ' || queue_table || ' (SEQ_ID, ORIGIN_H3, ORIGIN_POINT, DEST_COORDS, DEST_HEX_IDS)
        WITH pairs AS (
            SELECT
                a.H3_INDEX AS origin_h3,
                a.CENTER_POINT AS origin_point,
                b.H3_INDEX AS dest_h3,
                b.CENTER_POINT AS dest_point,
                MOD(HASH(b.H3_INDEX), GREATEST(CEIL(' || hex_count::VARCHAR || '.0 / 1000), 1)) AS chunk_idx
            FROM ' || hex_table || ' a
            CROSS JOIN ' || hex_table || ' b
            WHERE a.H3_INDEX != b.H3_INDEX
              AND MOD(HASH(a.H3_INDEX), ' || num_shards::VARCHAR || ') = ' || shard_idx::VARCHAR || '
        )
        SELECT
            ROW_NUMBER() OVER (ORDER BY origin_h3, chunk_idx) + ' || total_inserted::VARCHAR || ' AS seq_id,
            origin_h3,
            ANY_VALUE(origin_point),
            ARRAY_AGG(ARRAY_CONSTRUCT(ST_X(dest_point), ST_Y(dest_point))),
            ARRAY_AGG(dest_h3)
        FROM pairs
        GROUP BY origin_h3, chunk_idx';

        rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || queue_table || ' WHERE SEQ_ID > ' || total_inserted::VARCHAR);
        LET sc CURSOR FOR rs;
        FOR r IN sc DO shard_rows := r.CNT; END FOR;
        total_inserted := total_inserted + shard_rows;

        IF (P_JOB_ID IS NOT NULL) THEN
            UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
            SET PCT_COMPLETE = ROUND((:shard_idx + 1) / :num_shards * 30, 1),
                WORK_QUEUE_ROWS = :total_inserted
            WHERE JOB_ID = :P_JOB_ID;
        END IF;
    END FOR;

    RETURN P_RES || ' work queue built: ' || total_inserted || ' chunks (' || num_shards || ' shards, ' || hex_count || ' origins)';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_TRAVEL_TIME_RANGE(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    batch_size INTEGER;
    current_pos INTEGER;
    batch_end INTEGER;
    batch_num INTEGER DEFAULT 0;
    failed_batches INTEGER DEFAULT 0;
    batch_failed BOOLEAN DEFAULT FALSE;
    queue_table VARCHAR;
    raw_table VARCHAR;
    safe_profile VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;

    batch_size := 100;

    resume_sql := 'SELECT COALESCE(MAX(SEQ_ID), ' || (P_START_SEQ - 1) ||
                  ') AS MAX_DONE FROM ' || raw_table ||
                  ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ;
    rs := (EXECUTE IMMEDIATE :resume_sql);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        max_done := row_val.MAX_DONE;
    END FOR;

    current_pos := max_done + 1;

    WHILE (current_pos <= P_END_SEQ) DO
        batch_num := batch_num + 1;
        batch_end := LEAST(current_pos + batch_size - 1, P_END_SEQ);
        retry_count := 0;
        retry_wait := 10;
        batch_failed := FALSE;

        insert_sql := '
        INSERT INTO ' || raw_table || '
        SELECT
            q.SEQ_ID,
            q.ORIGIN_H3,
            q.DEST_HEX_IDS,
            OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
                ''' || P_PROFILE || ''',
                ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)),
                q.DEST_COORDS
            )
        FROM ' || queue_table || ' q
        WHERE q.SEQ_ID BETWEEN ' || current_pos || ' AND ' || batch_end;

        WHILE (retry_count <= max_retries) DO
            BEGIN
                EXECUTE IMMEDIATE :insert_sql;
                retry_count := max_retries + 1;
            EXCEPTION
                WHEN OTHER THEN
                    retry_count := retry_count + 1;
                    IF (retry_count > max_retries) THEN
                        failed_batches := failed_batches + 1;
                        batch_failed := TRUE;
                        retry_count := max_retries + 1;
                    ELSE
                        BEGIN
                            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service RESUME;
                        EXCEPTION WHEN OTHER THEN NULL;
                        END;
                        BEGIN
                            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
                        EXCEPTION WHEN OTHER THEN
                            BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service RESUME; EXCEPTION WHEN OTHER THEN NULL; END;
                        END;
                        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || retry_wait || ')';
                        retry_wait := retry_wait * 2;
                    END IF;
            END;
        END WHILE;

        current_pos := batch_end + 1;
    END WHILE;

    RETURN P_RES || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ', failed_batches=' || failed_batches || ')';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_TRAVEL_TIME_RANGE_REGION(P_RES VARCHAR, P_START_SEQ INTEGER, P_END_SEQ INTEGER, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    batch_size INTEGER;
    current_pos INTEGER;
    batch_end INTEGER;
    batch_num INTEGER DEFAULT 0;
    failed_batches INTEGER DEFAULT 0;
    batch_failed BOOLEAN DEFAULT FALSE;
    queue_table VARCHAR;
    raw_table VARCHAR;
    safe_profile VARCHAR;
    matrix_call VARCHAR;
    insert_sql VARCHAR;
    resume_sql VARCHAR;
    max_done INTEGER DEFAULT 0;
    rs RESULTSET;
    retry_count INTEGER DEFAULT 0;
    max_retries INTEGER DEFAULT 5;
    retry_wait INTEGER DEFAULT 10;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;

    LET is_default BOOLEAN DEFAULT TRUE;
    IF (P_REGION IS NOT NULL AND UPPER(P_REGION) != 'DEFAULT') THEN
        BEGIN
            LET svc_rs RESULTSET := (EXECUTE IMMEDIATE
                'SHOW SERVICES LIKE ''ORS_SERVICE_' || UPPER(P_REGION) || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE');
            LET svc_c CURSOR FOR svc_rs;
            FOR r IN svc_c DO
                is_default := FALSE;
            END FOR;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    IF (NOT is_default) THEN
        matrix_call := P_MATRIX_FN || '(''' || P_REGION || ''', ''' || P_PROFILE || ''', ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)), q.DEST_COORDS)';
    ELSE
        matrix_call := P_MATRIX_FN || '(''' || P_PROFILE || ''', ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)), q.DEST_COORDS)';
    END IF;

    batch_size := 100;

    resume_sql := 'SELECT COALESCE(MAX(SEQ_ID), ' || (P_START_SEQ - 1) ||
                  ') AS MAX_DONE FROM ' || raw_table ||
                  ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ;
    rs := (EXECUTE IMMEDIATE :resume_sql);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        max_done := row_val.MAX_DONE;
    END FOR;

    current_pos := max_done + 1;

    WHILE (current_pos <= P_END_SEQ) DO
        batch_num := batch_num + 1;
        batch_end := LEAST(current_pos + batch_size - 1, P_END_SEQ);
        retry_count := 0;
        retry_wait := 10;
        batch_failed := FALSE;

        insert_sql := '
        INSERT INTO ' || raw_table || '
        SELECT
            q.SEQ_ID,
            q.ORIGIN_H3,
            q.DEST_HEX_IDS,
            ' || matrix_call || '
        FROM ' || queue_table || ' q
        WHERE q.SEQ_ID BETWEEN ' || current_pos || ' AND ' || batch_end;

        WHILE (retry_count <= max_retries) DO
            BEGIN
                EXECUTE IMMEDIATE :insert_sql;
                retry_count := max_retries + 1;
            EXCEPTION
                WHEN OTHER THEN
                    retry_count := retry_count + 1;
                    IF (retry_count > max_retries) THEN
                        failed_batches := failed_batches + 1;
                        batch_failed := TRUE;
                        retry_count := max_retries + 1;
                    ELSE
                        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(' || retry_wait || ')';
                        retry_wait := retry_wait * 2;
                    END IF;
            END;
        END WHILE;

        current_pos := batch_end + 1;
    END WHILE;

    LET error_retry_sql VARCHAR;
    LET error_origin_count INTEGER DEFAULT 0;
    LET retry_pass INTEGER DEFAULT 0;
    LET max_error_retries INTEGER DEFAULT 3;

    WHILE (retry_pass < max_error_retries) DO
        -- Only retry rows that lack BOTH a durations array AND a structured ORS error.
        -- Rows with MATRIX_RESULT:error.code set (e.g. 6010 out-of-bounds) are deterministic
        -- failures - retrying them is futile and creates an infinite delete/re-insert loop.
        error_retry_sql := 'SELECT COUNT(*) AS CNT FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND MATRIX_RESULT:durations IS NULL' ||
            ' AND MATRIX_RESULT:error IS NULL';
        rs := (EXECUTE IMMEDIATE :error_retry_sql);
        LET ec CURSOR FOR rs;
        FOR r IN ec DO error_origin_count := r.CNT; END FOR;

        IF (error_origin_count = 0) THEN
            retry_pass := max_error_retries;
        ELSE
            retry_pass := retry_pass + 1;
            EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';

            -- Only delete rows that have no response at all; preserve rows with
            -- deterministic ORS error responses so they are not retried indefinitely.
            EXECUTE IMMEDIATE 'DELETE FROM ' || raw_table ||
            ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
            ' AND MATRIX_RESULT:durations IS NULL' ||
            ' AND MATRIX_RESULT:error IS NULL';

            LET retry_min INTEGER;
            LET retry_max INTEGER;
            rs := (EXECUTE IMMEDIATE '
                SELECT MIN(q.SEQ_ID) AS MN, MAX(q.SEQ_ID) AS MX FROM ' || queue_table || ' q
                WHERE q.SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ ||
                ' AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || raw_table ||
                ' WHERE SEQ_ID BETWEEN ' || P_START_SEQ || ' AND ' || P_END_SEQ || ')');
            LET mc CURSOR FOR rs;
            FOR r IN mc DO retry_min := r.MN; retry_max := r.MX; END FOR;

            IF (retry_min IS NOT NULL) THEN
                LET rpos INTEGER := retry_min;
                WHILE (rpos <= retry_max) DO
                    LET rend INTEGER := LEAST(rpos + batch_size - 1, retry_max);
                    BEGIN
                        EXECUTE IMMEDIATE '
                        INSERT INTO ' || raw_table || '
                        SELECT q.SEQ_ID, q.ORIGIN_H3, q.DEST_HEX_IDS, ' || matrix_call || '
                        FROM ' || queue_table || ' q
                        WHERE q.SEQ_ID BETWEEN ' || rpos || ' AND ' || rend ||
                        ' AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || raw_table ||
                        ' WHERE SEQ_ID BETWEEN ' || rpos || ' AND ' || rend || ')';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    rpos := rend + 1;
                END WHILE;
            END IF;
        END IF;
    END WHILE;

    RETURN P_RES || ' range [' || P_START_SEQ || '-' || P_END_SEQ ||
           '] complete: ' || batch_num || ' batches of ' || batch_size ||
           ' (resumed from seq ' || max_done || ', fn=' || P_MATRIX_FN || ', failed_batches=' || failed_batches || ')';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.FLATTEN_MATRIX_RAW(P_RES VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    raw_table VARCHAR;
    target_table VARCHAR;
    safe_profile VARCHAR;
    row_count INTEGER;
    rs RESULTSET;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    raw_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_RAW_' || P_RES;
    target_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    EXECUTE IMMEDIATE '
    CREATE OR REPLACE TABLE ' || target_table || '
    CLUSTER BY (ORIGIN_H3)
    COMMENT = ''{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}''
    AS
    SELECT
        r.ORIGIN_H3,
        r.DEST_HEX_IDS[f.INDEX]::VARCHAR AS DEST_H3,
        r.MATRIX_RESULT:durations[0][f.INDEX]::FLOAT AS TRAVEL_TIME_SECONDS,
        r.MATRIX_RESULT:distances[0][f.INDEX]::FLOAT AS TRAVEL_DISTANCE_METERS,
        SYSDATE() AS CALCULATED_AT
    FROM ' || raw_table || ' r,
        LATERAL FLATTEN(input => r.MATRIX_RESULT:durations[0]) f
    WHERE r.MATRIX_RESULT:durations IS NOT NULL
      AND r.MATRIX_RESULT:durations[0][f.INDEX] IS NOT NULL';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || target_table);
    LET c CURSOR FOR rs;
    FOR row_val IN c DO
        row_count := row_val.CNT;
    END FOR;

    RETURN P_RES || ' flatten complete (' || P_REGION || '/' || P_PROFILE || '): ' || row_count || ' travel time pairs';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_MATRIX_FOR_REGION(P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    hex_count INTEGER;
    queue_count INTEGER;
    travel_count INTEGER;
    hex_table VARCHAR;
    queue_table VARCHAR;
    travel_table VARCHAR;
    safe_profile VARCHAR;
    count_sql VARCHAR;
    rs RESULTSET;
    parallel_count INTEGER DEFAULT 4;
    chunk_size INTEGER;
    chunk_start INTEGER;
    chunk_end INTEGER;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    hex_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_LIST_' || P_RES;
    queue_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_WORK_QUEUE_' || P_RES;
    travel_table := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile || '_MATRIX_' || P_RES;

    CALL OPENROUTESERVICE_APP.CORE.ENSURE_MATRIX_TABLES(:P_REGION, :P_PROFILE, :P_RES);

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
    EXCEPTION WHEN OTHER THEN
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service RESUME;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END;
    EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(5)';

    CALL OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || hex_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c2 CURSOR FOR rs;
    FOR r IN c2 DO hex_count := r.CNT; END FOR;

    CALL OPENROUTESERVICE_APP.CORE.BUILD_WORK_QUEUE(:P_RES, :P_REGION, :P_PROFILE);

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || queue_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c4 CURSOR FOR rs;
    FOR r IN c4 DO queue_count := r.CNT; END FOR;

    LET is_default_r BOOLEAN DEFAULT TRUE;
    IF (UPPER(P_REGION) != 'DEFAULT') THEN
        BEGIN
            LET svc_rsr RESULTSET := (EXECUTE IMMEDIATE
                'SHOW SERVICES LIKE ''ORS_SERVICE_' || UPPER(P_REGION) || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE');
            LET svc_cr CURSOR FOR svc_rsr;
            FOR r IN svc_cr DO
                is_default_r := FALSE;
            END FOR;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;
    LET svc_inst INTEGER := 3;
    IF (NOT is_default_r) THEN
        BEGIN
            SHOW SERVICES LIKE 'ORS_SERVICE_%' IN SCHEMA OPENROUTESERVICE_APP.CORE;
            LET sir RESULTSET := (
                SELECT "min_instances"::INTEGER AS MI
                FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
                WHERE "name" = 'ORS_SERVICE_' || UPPER(P_REGION)
                LIMIT 1
            );
            LET sic CURSOR FOR sir;
            FOR r IN sic DO svc_inst := r.MI; END FOR;
        EXCEPTION WHEN OTHER THEN svc_inst := 1;
        END;
    END IF;
    parallel_count := LEAST(GREATEST(svc_inst * 2, 2), 8);

    chunk_size := GREATEST(CEIL(queue_count / parallel_count), 1);
    chunk_start := 1;

    WHILE (chunk_start <= queue_count) DO
        chunk_end := LEAST(chunk_start + chunk_size - 1, queue_count);
        ASYNC (CALL OPENROUTESERVICE_APP.CORE.BUILD_TRAVEL_TIME_RANGE_REGION(:P_RES, :chunk_start, :chunk_end, :P_MATRIX_FN, :P_REGION, :P_PROFILE));
        chunk_start := chunk_end + 1;
    END WHILE;
    AWAIT ALL;

    EXECUTE IMMEDIATE 'CALL OPENROUTESERVICE_APP.CORE.FLATTEN_MATRIX_RAW(''' || P_RES || ''', ''' || P_REGION || ''', ''' || P_PROFILE || ''')';

    count_sql := 'SELECT COUNT(*) AS CNT FROM ' || travel_table;
    rs := (EXECUTE IMMEDIATE :count_sql);
    LET c5 CURSOR FOR rs;
    FOR r IN c5 DO travel_count := r.CNT; END FOR;

    RETURN P_RES || ' complete (' || P_MATRIX_FN || ', ' || P_PROFILE || '): ' || hex_count || ' hexagons, ' ||
           queue_count || ' origins, ' || travel_count || ' travel times (' || parallel_count || ' parallel workers)';
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.MATRIX_PROGRESS(P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    result VARCHAR;
    rs RESULTSET;
BEGIN
    rs := (
        SELECT COALESCE(OBJECT_AGG(
            RESOLUTION,
            OBJECT_CONSTRUCT(                'stage', CASE STATUS WHEN 'COMPLETE' THEN 'COMPLETE' WHEN 'ERROR' THEN 'ERROR' ELSE STAGE END,
                'hexagons', HEXAGONS,
                'work_queue', WORK_QUEUE_ROWS,
                'raw_ingested', RAW_ROWS,
                'flattened', MATRIX_ROWS,
                'pct', PCT_COMPLETE,
                'status', STATUS,
                'error', COALESCE(ERROR_MSG, ''),
                -- Cell accounting. Exposed so a shrinking cell count is
                -- explainable in the UI instead of looking like data loss:
                -- `routability_note` says how many cells the graph could not
                -- reach, and `filter_warning` says when the user's road-aware
                -- choice could not be honoured (previously recorded only in
                -- MESSAGE, which this procedure never returned, so a silently
                -- unfiltered build reported as healthy).
                'road_filter', COALESCE(ROAD_FILTER, FALSE),
                'hexagons_before_routability', COALESCE(HEXAGONS_BEFORE_ROUTABILITY, 0),
                'hexagons_after_routability', COALESCE(HEXAGONS_AFTER_ROUTABILITY, 0),
                'routability_note', COALESCE(ROUTABILITY_NOTE, ''),
                'filter_warning', COALESCE(FILTER_WARNING, '')
            )
        ), OBJECT_CONSTRUCT())::VARCHAR AS OBJ
        FROM (
            -- One row per RESOLUTION, newest first. OBJECT_AGG raises
            -- "Duplicate field key 'RES5'" - a hard STATEMENT_ERROR, not a
            -- degraded result - the moment two jobs share a resolution, and a
            -- second job is exactly what the Retry button creates. So the whole
            -- progress panel broke on the first retry of any build, which is
            -- precisely when a user needs it.
            SELECT *
            FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
            WHERE UPPER(REGION) = UPPER(:P_REGION)
              AND UPPER(REPLACE(PROFILE, '-', '_')) = UPPER(REPLACE(:P_PROFILE, '-', '_'))
              AND STATUS IN ('RUNNING', 'COMPLETE', 'ERROR')
              AND CREATED_AT > DATEADD('day', -30, SYSDATE())
            QUALIFY ROW_NUMBER() OVER (PARTITION BY RESOLUTION ORDER BY CREATED_AT DESC) = 1
        )
    );
    LET c CURSOR FOR rs;
    FOR row_val IN c DO result := row_val.OBJ; END FOR;
    RETURN COALESCE(result, '{}');
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.RESET_MATRIX_DATA(P_REGION VARCHAR, P_PROFILE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
    res_num INTEGER;
    res_label VARCHAR;
BEGIN
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    FOR res_num IN 5 TO 10 DO
        res_label := 'RES' || res_num::VARCHAR;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_LIST_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_WORK_QUEUE_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_RAW_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
        BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_' || res_label; EXCEPTION WHEN OTHER THEN NULL; END;
    END FOR;

    DELETE FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    WHERE UPPER(REGION) = UPPER(:P_REGION)
      AND UPPER(REPLACE(PROFILE, '-', '_')) = :safe_profile;

    RETURN 'Matrix tables dropped for ' || P_REGION || '/' || P_PROFILE;
END;
$$;

CREATE OR REPLACE PROCEDURE OPENROUTESERVICE_APP.CORE.BUILD_MATRIX_JOB_WRAPPER(P_JOB_ID VARCHAR, P_RES VARCHAR, P_MIN_LAT FLOAT, P_MAX_LAT FLOAT, P_MIN_LON FLOAT, P_MAX_LON FLOAT, P_MATRIX_FN VARCHAR, P_REGION VARCHAR, P_PROFILE VARCHAR, P_ROAD_FILTER BOOLEAN DEFAULT FALSE)
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"matrix"}}'
EXECUTE AS OWNER
AS
$$
DECLARE
    safe_profile VARCHAR;
    prefix VARCHAR;
    hex_count INTEGER DEFAULT 0;
    queue_count INTEGER DEFAULT 0;
    raw_count INTEGER DEFAULT 0;
    matrix_count INTEGER DEFAULT 0;
    valid_count INTEGER DEFAULT 0;
    error_count INTEGER DEFAULT 0;
    sample_error VARCHAR DEFAULT '';
    rs RESULTSET;
    wait_attempt INTEGER DEFAULT 0;
    max_wait_attempts INTEGER DEFAULT 40;
    profile_ready BOOLEAN DEFAULT FALSE;
    status_json VARIANT;
    filter_start TIMESTAMP_NTZ;
    used_road_filter BOOLEAN DEFAULT FALSE;
    routability_start TIMESTAMP_NTZ;
    hex_before_routability INTEGER DEFAULT 0;
    routability_note VARCHAR;
    hex_before INTEGER DEFAULT 0;
    resolution_int INTEGER;
    region_pool_name VARCHAR;
    region_svc_name VARCHAR;
    orig_region_pool_max_nodes INTEGER DEFAULT NULL;
    orig_region_svc_min INTEGER DEFAULT NULL;
    orig_region_svc_max INTEGER DEFAULT NULL;
    orig_gateway_pool_max_nodes INTEGER DEFAULT NULL;
    orig_gateway_svc_min INTEGER DEFAULT NULL;
    orig_gateway_svc_max INTEGER DEFAULT NULL;
    target_region_nodes INTEGER DEFAULT 4;
    target_region_instances INTEGER DEFAULT 4;
    target_gateway_nodes INTEGER DEFAULT 8;
    target_gateway_instances INTEGER DEFAULT 8;
BEGIN
    region_pool_name := 'ORS_POOL_' || UPPER(P_REGION);
    region_svc_name := 'ORS_SERVICE_' || UPPER(P_REGION);
    safe_profile := REPLACE(UPPER(P_PROFILE), '-', '_');
    prefix := 'travel_matrix.' || UPPER(P_REGION) || '_' || safe_profile;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STATUS = 'ERROR',
        ERROR_MSG = 'Stale job: still RUNNING after 2+ hours, marked as zombie',
        COMPLETED_AT = SYSDATE()
    WHERE STATUS = 'RUNNING'
      AND STARTED_AT < DATEADD('HOUR', -2, SYSDATE())
      AND JOB_ID != :P_JOB_ID;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STATUS='RUNNING', STAGE='HEXAGONS', STARTED_AT=SYSDATE()
    WHERE JOB_ID = :P_JOB_ID;

    CALL OPENROUTESERVICE_APP.CORE.ENSURE_MATRIX_TABLES(:P_REGION, :P_PROFILE, :P_RES);

    LET is_default BOOLEAN DEFAULT TRUE;
    IF (UPPER(P_REGION) != 'DEFAULT') THEN
        BEGIN
            LET svc_rs RESULTSET := (EXECUTE IMMEDIATE
                'SHOW SERVICES LIKE ''ORS_SERVICE_' || UPPER(P_REGION) || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE');
            LET svc_c CURSOR FOR svc_rs;
            FOR r IN svc_c DO
                is_default := FALSE;
            END FOR;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    -- INVARIANT: this RESUME + SET AUTO_SUSPEND_SECS=0 block must run BEFORE
    -- BUILD_WORK_QUEUE and any other long-running step. Moving it later
    -- re-introduces the WORK_QUEUE drift bug (see AGENTS.md
    -- "AUTO_SUSPEND_SECS Invariant"). All long phases (filtering, work-queue
    -- build, MATRIX_API, sweep) must be protected from auto-suspension.
    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service RESUME;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' RESUME';
    EXCEPTION WHEN OTHER THEN
        BEGIN ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ors_service RESUME; EXCEPTION WHEN OTHER THEN NULL; END;
    END;
    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 0;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 0';
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    -- ===== Compute pool / service scale-up for matrix build =====
    -- Capture original sizes, then bump per-region pool to 4 nodes / ORS service to 4
    -- instances and gateway pool to 8 nodes / gateway service to 8 instances. All
    -- ALTERs are wrapped in EXCEPTION WHEN OTHER THEN NULL so a quota or permission
    -- failure degrades performance but never aborts the build. Sizes are restored
    -- at every exit point (success, early-error returns, EXCEPTION block).
    --
    -- NOTE: If two matrix builds run concurrently against the same region, the
    -- second build will capture the *already-bumped* values as its "original",
    -- so on completion it will leave the pool/service at the bumped size. This
    -- is acceptable since both jobs benefit from the larger pool; the operator
    -- can call OPENROUTESERVICE_APP.CORE.RECONCILE_AUTO_SUSPEND() / manually
    -- ALTER back to baseline once all builds complete.
    IF (NOT is_default) THEN
        BEGIN
            EXECUTE IMMEDIATE 'SHOW COMPUTE POOLS LIKE ''' || region_pool_name || '''';
            LET rp_rs RESULTSET := (
                SELECT "max_nodes"::INTEGER AS MN
                FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1
            );
            LET rp_c CURSOR FOR rp_rs;
            FOR r IN rp_c DO orig_region_pool_max_nodes := r.MN; END FOR;
        EXCEPTION WHEN OTHER THEN orig_region_pool_max_nodes := NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'SHOW SERVICES LIKE ''' || region_svc_name || ''' IN SCHEMA OPENROUTESERVICE_APP.CORE';
            LET rs_rs RESULTSET := (
                SELECT "min_instances"::INTEGER AS MN, "max_instances"::INTEGER AS MX
                FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1
            );
            LET rs_c CURSOR FOR rs_rs;
            FOR r IN rs_c DO orig_region_svc_min := r.MN; orig_region_svc_max := r.MX; END FOR;
        EXCEPTION WHEN OTHER THEN orig_region_svc_min := NULL; orig_region_svc_max := NULL;
        END;
    END IF;
    BEGIN
        SHOW COMPUTE POOLS LIKE 'OPENROUTESERVICE_APP_COMPUTE_POOL';
        LET gp_rs RESULTSET := (
            SELECT "max_nodes"::INTEGER AS MN
            FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1
        );
        LET gp_c CURSOR FOR gp_rs;
        FOR r IN gp_c DO orig_gateway_pool_max_nodes := r.MN; END FOR;
    EXCEPTION WHEN OTHER THEN orig_gateway_pool_max_nodes := NULL;
    END;
    BEGIN
        SHOW SERVICES LIKE 'routing_gateway_service' IN SCHEMA OPENROUTESERVICE_APP.CORE;
        LET gs_rs RESULTSET := (
            SELECT "min_instances"::INTEGER AS MN, "max_instances"::INTEGER AS MX
            FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1
        );
        LET gs_c CURSOR FOR gs_rs;
        FOR r IN gs_c DO orig_gateway_svc_min := r.MN; orig_gateway_svc_max := r.MX; END FOR;
    EXCEPTION WHEN OTHER THEN orig_gateway_svc_min := NULL; orig_gateway_svc_max := NULL;
    END;

    IF (NOT is_default) THEN
        BEGIN
            EXECUTE IMMEDIATE 'ALTER COMPUTE POOL ' || region_pool_name ||
                              ' SET MAX_NODES = ' || target_region_nodes;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || region_svc_name ||
                              ' SET MIN_INSTANCES = ' || target_region_instances ||
                              ' MAX_INSTANCES = ' || target_region_instances;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET MAX_NODES = ' || target_gateway_nodes;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.routing_gateway_service' ||
                          ' SET MIN_INSTANCES = ' || target_gateway_instances ||
                          ' MAX_INSTANCES = ' || target_gateway_instances;
    EXCEPTION WHEN OTHER THEN NULL;
    END;

    EXECUTE IMMEDIATE 'UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET MESSAGE=''Waiting for ORS profile ' || P_PROFILE || ' to become ready...'' WHERE JOB_ID=''' || P_JOB_ID || '''';

    WHILE (wait_attempt < max_wait_attempts AND NOT profile_ready) DO
        EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(15)';
        wait_attempt := wait_attempt + 1;
        BEGIN
            IF (is_default) THEN
                rs := (SELECT PARSE_JSON(TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS())) AS S);
            ELSE
                rs := (EXECUTE IMMEDIATE 'SELECT PARSE_JSON(TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS(''' || P_REGION || '''))) AS S');
            END IF;
            LET cs CURSOR FOR rs;
            FOR r IN cs DO
                status_json := r.S;
            END FOR;
            IF (status_json:profiles IS NOT NULL AND status_json:profiles[P_PROFILE] IS NOT NULL) THEN
                profile_ready := TRUE;
            END IF;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END WHILE;

    LET wait_secs INTEGER := wait_attempt * 15;

    IF (NOT profile_ready) THEN
        EXECUTE IMMEDIATE 'UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET STATUS=''ERROR'', ERROR_MSG=''ORS profile ' || P_PROFILE || ' not ready after ' || wait_secs || ' seconds. Service may need more time to load graphs.'', COMPLETED_AT=SYSDATE() WHERE JOB_ID=''' || P_JOB_ID || '''';
        RETURN 'Job ' || :P_JOB_ID || ' failed: profile ' || :P_PROFILE || ' not ready';
    END IF;

    EXECUTE IMMEDIATE 'UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET MESSAGE=''ORS profile ' || P_PROFILE || ' ready after ' || wait_secs || 's'' WHERE JOB_ID=''' || P_JOB_ID || '''';

    filter_start := SYSDATE();
    used_road_filter := FALSE;
    hex_before := 0;
    resolution_int := CASE P_RES
        WHEN 'RES5' THEN 5 WHEN 'RES6' THEN 6 WHEN 'RES7' THEN 7
        WHEN 'RES8' THEN 8 WHEN 'RES9' THEN 9 ELSE 10 END;

    IF (P_ROAD_FILTER) THEN
        BEGIN
            LET est_rs RESULTSET := (EXECUTE IMMEDIATE
                'SELECT ARRAY_SIZE(H3_POLYGON_TO_CELLS_STRINGS(
                    TO_GEOGRAPHY(''POLYGON((' ||
                        P_MIN_LON || ' ' || P_MIN_LAT || ',' ||
                        P_MAX_LON || ' ' || P_MIN_LAT || ',' ||
                        P_MAX_LON || ' ' || P_MAX_LAT || ',' ||
                        P_MIN_LON || ' ' || P_MAX_LAT || ',' ||
                        P_MIN_LON || ' ' || P_MIN_LAT || '))''),
                    ' || resolution_int || ')) AS CNT');
            LET ec CURSOR FOR est_rs;
            FOR r IN ec DO hex_before := r.CNT; END FOR;
        EXCEPTION WHEN OTHER THEN hex_before := 0;
        END;

        BEGIN
            CALL OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS_ROAD_AWARE(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);
            used_road_filter := TRUE;
        EXCEPTION WHEN OTHER THEN
            LET err_detail VARCHAR := SQLERRM;
            -- The user ASKED for road-aware filtering and is not getting it, so
            -- this goes in FILTER_WARNING (exposed by MATRIX_PROGRESS) as well
            -- as MESSAGE. Reporting it only in MESSAGE meant an unmounted
            -- Overture share produced a silently unfiltered build that looked
            -- healthy in the UI.
            UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
            SET MESSAGE = 'Road-aware filter unavailable: ' || :err_detail || ' -- falling back to full tessellation',
                FILTER_WARNING = 'Road-aware filtering was requested but is unavailable ('
                                 || :err_detail || '). Built the full region grid instead, so the'
                                 || ' cell count and cost are higher than the estimate.'
            WHERE JOB_ID = :P_JOB_ID;
            CALL OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);
        END;
    ELSE
        CALL OPENROUTESERVICE_APP.CORE.BUILD_HEXAGONS(:P_RES, :P_MIN_LAT, :P_MAX_LAT, :P_MIN_LON, :P_MAX_LON, :P_REGION, :P_PROFILE);
    END IF;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_LIST_' || P_RES);
    LET c1 CURSOR FOR rs; FOR r IN c1 DO hex_count := r.CNT; END FOR;
    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STAGE='WORK_QUEUE', HEXAGONS=:hex_count,
        ROAD_FILTER = :used_road_filter,
        HEXAGONS_BEFORE_FILTER = :hex_before,
        HEXAGONS_AFTER_FILTER = :hex_count,
        FILTER_DURATION_SECONDS = DATEDIFF('SECOND', :filter_start, SYSDATE())
    WHERE JOB_ID = :P_JOB_ID;

    -- Routability gate. Runs for BOTH tessellation paths and does not consult
    -- P_ROAD_FILTER: a cell the graph cannot reach yields no matrix rows under
    -- any setting, and because BUILD_WORK_QUEUE hash-chunks destinations, one
    -- such cell nulls every chunk it lands in rather than costing a single row.
    -- Removing it is correctness, not a preference, so the user's coverage
    -- choice is left entirely alone.
    routability_start := SYSDATE();
    hex_before_routability := hex_count;
    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.PRUNE_UNROUTABLE_HEXAGONS(:P_RES, :P_REGION, :P_PROFILE);
        routability_note := (SELECT "PRUNE_UNROUTABLE_HEXAGONS"
                             FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
    EXCEPTION WHEN OTHER THEN
        -- A gate failure must never fail the build: the grid is no worse than
        -- it was before the gate existed.
        routability_note := 'Routability gate skipped: ' || SQLERRM;
    END;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_LIST_' || P_RES);
    LET c1b CURSOR FOR rs; FOR r IN c1b DO hex_count := r.CNT; END FOR;
    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET HEXAGONS = :hex_count,
        HEXAGONS_BEFORE_ROUTABILITY = :hex_before_routability,
        HEXAGONS_AFTER_ROUTABILITY = :hex_count,
        ROUTABILITY_DURATION_SECONDS = DATEDIFF('SECOND', :routability_start, SYSDATE()),
        ROUTABILITY_NOTE = :routability_note
    WHERE JOB_ID = :P_JOB_ID;

    IF (hex_count = 0) THEN
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET STATUS='ERROR',
            ERROR_MSG='No routable cells remain for ' || :P_REGION || ' / ' || :P_PROFILE || ' / ' || :P_RES
                      || '. ' || COALESCE(:routability_note, '') ,
            COMPLETED_AT=SYSDATE()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: no routable cells';
    END IF;

    -- Default the restore target to the steady-state size ('SMALL') so the
    -- restore is ALWAYS a no-op-or-shrink, never a no-op leaving the warehouse
    -- bumped. If the SHOW WAREHOUSES capture below succeeds with a "small"
    -- size (XSMALL/SMALL/MEDIUM) we honour it; if it fails or returns a
    -- bumped size (LARGE/X-LARGE/...) we treat that as drift from a previous
    -- un-restored run and fall back to the steady-state default.
    LET original_wh_size VARCHAR := 'SMALL';
    LET did_bump BOOLEAN := FALSE;
    IF (hex_count > 5000) THEN
        BEGIN
            LET wh_name VARCHAR := CURRENT_WAREHOUSE();
            EXECUTE IMMEDIATE 'SHOW WAREHOUSES LIKE ''' || wh_name || '''';
            LET wh_rs RESULTSET := (SELECT "size" AS SZ FROM TABLE(RESULT_SCAN(LAST_QUERY_ID())) LIMIT 1);
            LET wh_c CURSOR FOR wh_rs;
            LET captured_sz VARCHAR := NULL;
            FOR r IN wh_c DO captured_sz := r.SZ; END FOR;
            -- Only honour the captured size if it is at or below the
            -- steady-state band. Anything LARGE+ is treated as drift from a
            -- prior un-restored run and replaced with the steady-state default.
            IF (captured_sz IS NOT NULL
                AND UPPER(captured_sz) IN ('X-SMALL','XSMALL','SMALL','MEDIUM'))
            THEN
                original_wh_size := captured_sz;
            END IF;
            IF (hex_count > 25000) THEN
                EXECUTE IMMEDIATE 'ALTER WAREHOUSE ' || wh_name || ' SET WAREHOUSE_SIZE = ''X-LARGE''';
            ELSE
                EXECUTE IMMEDIATE 'ALTER WAREHOUSE ' || wh_name || ' SET WAREHOUSE_SIZE = ''LARGE''';
            END IF;
            did_bump := TRUE;
        EXCEPTION WHEN OTHER THEN
            -- Capture or bump failed. Leave original_wh_size at its default
            -- ('SMALL') so any subsequent restore still runs and shrinks the
            -- warehouse if it somehow got bumped. did_bump stays FALSE so we
            -- only restore when we actually changed something.
            NULL;
        END;
    END IF;

    BEGIN
        CALL OPENROUTESERVICE_APP.CORE.BUILD_WORK_QUEUE(:P_RES, :P_REGION, :P_PROFILE, :P_JOB_ID);
    EXCEPTION WHEN OTHER THEN
        IF (did_bump) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER WAREHOUSE ' || CURRENT_WAREHOUSE() || ' SET WAREHOUSE_SIZE = ''' || original_wh_size || '''';
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        RAISE;
    END;

    IF (did_bump) THEN
        BEGIN
            EXECUTE IMMEDIATE 'ALTER WAREHOUSE ' || CURRENT_WAREHOUSE() || ' SET WAREHOUSE_SIZE = ''' || original_wh_size || '''';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_WORK_QUEUE_' || P_RES);
    LET c2 CURSOR FOR rs; FOR r IN c2 DO queue_count := r.CNT; END FOR;
    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STAGE='BUILDING', WORK_QUEUE_ROWS=:queue_count
    WHERE JOB_ID = :P_JOB_ID;

    -- AUTO_SUSPEND_SECS=0 was already pinned at the top of this procedure
    -- (before BUILD_WORK_QUEUE) per AGENTS.md AUTO_SUSPEND_SECS invariant.
    -- Do not re-pin here; that pattern caused WORK_QUEUE-stage drift.

    LET svc_instances INTEGER := 3;
    IF (NOT is_default) THEN
        BEGIN
            SHOW SERVICES LIKE 'ORS_SERVICE_%' IN SCHEMA OPENROUTESERVICE_APP.CORE;
            LET svc_rs2 RESULTSET := (
                SELECT "min_instances"::INTEGER AS MI
                FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
                WHERE "name" = 'ORS_SERVICE_' || UPPER(P_REGION)
                LIMIT 1
            );
            LET sc CURSOR FOR svc_rs2;
            FOR r IN sc DO svc_instances := r.MI; END FOR;
        EXCEPTION WHEN OTHER THEN svc_instances := 1;
        END;
    END IF;
    LET parallel_count INTEGER := LEAST(GREATEST(svc_instances * 2, 2), 8);
    LET chunk_size INTEGER := GREATEST(CEIL(queue_count / parallel_count), 1);
    LET chunk_start INTEGER := 1;
    LET chunk_end INTEGER;

    WHILE (chunk_start <= queue_count) DO
        chunk_end := LEAST(chunk_start + chunk_size - 1, queue_count);
        ASYNC (CALL OPENROUTESERVICE_APP.CORE.BUILD_TRAVEL_TIME_RANGE_REGION(:P_RES, :chunk_start, :chunk_end, :P_MATRIX_FN, :P_REGION, :P_PROFILE));
        chunk_start := chunk_end + 1;
    END WHILE;
    AWAIT ALL;

    LET sweep_pass INTEGER := 0;
    LET max_sweep INTEGER := 2;
    LET sweep_batch INTEGER := 25;
    LET sweep_missing INTEGER;
    LET sweep_queue VARCHAR := prefix || '_WORK_QUEUE_' || P_RES;
    LET sweep_raw VARCHAR := prefix || '_MATRIX_RAW_' || P_RES;

    WHILE (sweep_pass < max_sweep) DO
        -- Sweep retry: only delete rows with no response. Rows with a deterministic
        -- ORS error (e.g. 6010 out-of-bounds) are permanent failures and must be kept
        -- to prevent an infinite delete/re-insert loop.
        EXECUTE IMMEDIATE 'DELETE FROM ' || sweep_raw ||
            ' WHERE MATRIX_RESULT:durations IS NULL' ||
            ' AND MATRIX_RESULT:error IS NULL';

        rs := (EXECUTE IMMEDIATE '
            SELECT COUNT(*) AS CNT FROM ' || sweep_queue || ' q
            WHERE q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || sweep_raw || ')');
        LET sm_c CURSOR FOR rs;
        FOR r IN sm_c DO sweep_missing := r.CNT; END FOR;

        IF (sweep_missing = 0) THEN
            sweep_pass := max_sweep;
        ELSE
            sweep_pass := sweep_pass + 1;
            EXECUTE IMMEDIATE 'SELECT SYSTEM$WAIT(30)';

            LET sw_min INTEGER;
            LET sw_max INTEGER;
            rs := (EXECUTE IMMEDIATE '
                SELECT MIN(q.SEQ_ID) AS MN, MAX(q.SEQ_ID) AS MX FROM ' || sweep_queue || ' q
                WHERE q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || sweep_raw || ')');
            LET sw_mc CURSOR FOR rs;
            FOR r IN sw_mc DO sw_min := r.MN; sw_max := r.MX; END FOR;

            IF (sw_min IS NOT NULL) THEN
                LET matrix_call_w VARCHAR;
                IF (NOT is_default) THEN
                    matrix_call_w := P_MATRIX_FN || '(''' || P_REGION || ''', ''' || P_PROFILE || ''', ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)), q.DEST_COORDS)';
                ELSE
                    matrix_call_w := P_MATRIX_FN || '(''' || P_PROFILE || ''', ARRAY_CONSTRUCT(ST_X(q.ORIGIN_POINT), ST_Y(q.ORIGIN_POINT)), q.DEST_COORDS)';
                END IF;

                LET swpos INTEGER := sw_min;
                WHILE (swpos <= sw_max) DO
                    LET swend INTEGER := LEAST(swpos + sweep_batch - 1, sw_max);
                    BEGIN
                        EXECUTE IMMEDIATE '
                        INSERT INTO ' || sweep_raw || '
                        SELECT q.SEQ_ID, q.ORIGIN_H3, q.DEST_HEX_IDS, ' || matrix_call_w || '
                        FROM ' || sweep_queue || ' q
                        WHERE q.SEQ_ID BETWEEN ' || swpos || ' AND ' || swend ||
                        ' AND q.SEQ_ID NOT IN (SELECT SEQ_ID FROM ' || sweep_raw ||
                        ' WHERE SEQ_ID BETWEEN ' || swpos || ' AND ' || swend || ')';
                    EXCEPTION WHEN OTHER THEN NULL;
                    END;
                    swpos := swend + 1;
                END WHILE;
            END IF;
        END IF;
    END WHILE;

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3 CURSOR FOR rs; FOR r IN c3 DO raw_count := r.CNT; END FOR;

    -- Surface partial completion: if far fewer raw rows than queue rows, log warning
    IF (raw_count < queue_count * 0.95 AND raw_count > 0) THEN
        LET missing_pct FLOAT := ROUND((1.0 - raw_count::FLOAT / queue_count) * 100, 1);
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET MESSAGE = 'WARNING: only ' || :raw_count || ' of ' || :queue_count || ' chunks completed (' || :missing_pct || '% missing). ORS may have returned null durations for some origin/dest combos. Consider scaling ORS_SERVICE or reducing chunk size.'
        WHERE JOB_ID = :P_JOB_ID;
    END IF;

    rs := (EXECUTE IMMEDIATE '
        SELECT
            COUNT(CASE WHEN MATRIX_RESULT:durations IS NOT NULL THEN 1 END) AS VALID_CNT,
            COUNT(CASE WHEN MATRIX_RESULT:durations IS NULL THEN 1 END) AS ERROR_CNT
        FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3b CURSOR FOR rs;
    FOR r IN c3b DO
        valid_count := r.VALID_CNT;
        error_count := r.ERROR_CNT;
    END FOR;

    IF (error_count > 0 AND valid_count = 0) THEN
        -- Sample from an ERROR row specifically. Without the WHERE this picked
        -- row 1 of the raw table whatever it contained, so the "Sample:" text
        -- could be an engine build_date or a truncated success payload rather
        -- than the failure being reported.
        rs := (EXECUTE IMMEDIATE '
            SELECT COALESCE(
                MATRIX_RESULT:error:message::VARCHAR,
                MATRIX_RESULT:message:message::VARCHAR,
                LEFT(MATRIX_RESULT::VARCHAR, 200)
            ) AS ERR FROM ' || prefix || '_MATRIX_RAW_' || P_RES || '
            WHERE MATRIX_RESULT:durations IS NULL LIMIT 1');
        LET c3c CURSOR FOR rs;
        FOR r IN c3c DO sample_error := r.ERR; END FOR;

        -- Count DISTINCT ORIGINS, not raw rows. A raw row is one origin x one
        -- destination CHUNK, so a 2,897-cell RES5 build produces 14,485 rows -
        -- and the old message reported that as "errors for all 14485 origins",
        -- overstating the fan-out by 5x and making the number impossible to
        -- reconcile with the cell count shown in the UI.
        LET origin_count INTEGER := :raw_count;
        BEGIN
            rs := (EXECUTE IMMEDIATE 'SELECT COUNT(DISTINCT ORIGIN_H3) AS CNT FROM '
                   || prefix || '_MATRIX_RAW_' || P_RES);
            LET oc CURSOR FOR rs; FOR r IN oc DO origin_count := r.CNT; END FOR;
        EXCEPTION WHEN OTHER THEN NULL;  -- fall back to the row count
        END;

        -- Name the cause when ORS reports out-of-bounds coordinates. This is a
        -- GEOMETRY problem, not an engine problem, and it fails TOTALLY rather
        -- than partially: BUILD_WORK_QUEUE chunks destinations by
        -- MOD(HASH(dest_h3), n), so unreachable cells are spread across every
        -- chunk, and one of them nulls an entire ~1000-destination request. A
        -- minority of bad cells therefore produces a 100% failure, which is
        -- exactly why the raw error alone reads as "nothing works".
        LET cause VARCHAR := '';
        IF (sample_error ILIKE '%out of bounds%' OR sample_error ILIKE '%6010%') THEN
            cause := ' Cause: some cell centres lie outside the routing graph, so ORS rejected'
                  || ' every request containing one. Destinations are hash-distributed across'
                  || ' chunks, so a small number of unreachable cells fails all of them.'
                  || ' Remedy: the region boundary is a PBF extract outline that can extend'
                  || ' past mapped land (for example offshore), so re-run the build - the land'
                  || ' clip and routability gate remove these cells before the matrix stage -'
                  || ' and check ROUTABILITY_NOTE on this job.';
        END IF;

        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET STATUS='ERROR', STAGE='BUILDING',
            ERROR_MSG='ORS returned errors for all ' || :origin_count || ' origins ('
                      || :raw_count || ' origin-chunk requests).' || :cause
                      || ' Sample: ' || :sample_error,
            RAW_ROWS=:raw_count, COMPLETED_AT=SYSDATE()
        WHERE JOB_ID = :P_JOB_ID;
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 3600;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        IF (orig_region_pool_max_nodes IS NOT NULL AND NOT is_default) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER COMPUTE POOL ' || region_pool_name ||
                                  ' SET MAX_NODES = ' || orig_region_pool_max_nodes;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        IF (orig_region_svc_min IS NOT NULL AND NOT is_default) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || region_svc_name ||
                                  ' SET MIN_INSTANCES = ' || orig_region_svc_min ||
                                  ' MAX_INSTANCES = ' || orig_region_svc_max;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        IF (orig_gateway_pool_max_nodes IS NOT NULL) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET MAX_NODES = ' || orig_gateway_pool_max_nodes;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        IF (orig_gateway_svc_min IS NOT NULL) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.routing_gateway_service' ||
                                  ' SET MIN_INSTANCES = ' || orig_gateway_svc_min ||
                                  ' MAX_INSTANCES = ' || orig_gateway_svc_max;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        RETURN 'Job ' || :P_JOB_ID || ' failed: all ' || origin_count || ' origins returned ORS errors';
    END IF;

    IF (error_count > 0) THEN
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET ERROR_MSG='Warning: ' || :error_count || ' of ' || :raw_count || ' origins returned ORS errors'
        WHERE JOB_ID = :P_JOB_ID;
    END IF;

    -- Purge rows with deterministic ORS error responses (e.g. 6010 out-of-bounds).
    -- These hexagon centroids fall outside the routable graph and will never produce
    -- a valid result. Removing them keeps the raw table lean and avoids carrying
    -- error payloads into downstream tables. Retry-eligible rows (durations IS NULL
    -- AND error IS NULL) are NOT touched here.
    EXECUTE IMMEDIATE 'DELETE FROM ' || prefix || '_MATRIX_RAW_' || P_RES ||
        ' WHERE MATRIX_RESULT:error IS NOT NULL';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_RAW_' || P_RES);
    LET c3c CURSOR FOR rs; FOR r IN c3c DO raw_count := r.CNT; END FOR;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STAGE='FLATTENING', RAW_ROWS=:raw_count, PCT_COMPLETE=100
    WHERE JOB_ID = :P_JOB_ID;

    EXECUTE IMMEDIATE 'CALL OPENROUTESERVICE_APP.CORE.FLATTEN_MATRIX_RAW(''' || P_RES || ''', ''' || P_REGION || ''', ''' || P_PROFILE || ''')';

    rs := (EXECUTE IMMEDIATE 'SELECT COUNT(*) AS CNT FROM ' || prefix || '_MATRIX_' || P_RES);
    LET c4 CURSOR FOR rs; FOR r IN c4 DO matrix_count := r.CNT; END FOR;

    IF (matrix_count = 0 AND raw_count > 0) THEN
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET STATUS='ERROR', STAGE='FLATTENING',
            ERROR_MSG='Flatten produced 0 pairs from ' || :raw_count || ' RAW rows (valid=' || :valid_count || ', errors=' || :error_count || ')',
            RAW_ROWS=:raw_count, COMPLETED_AT=SYSDATE()
        WHERE JOB_ID = :P_JOB_ID;
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 3600;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        IF (orig_region_pool_max_nodes IS NOT NULL AND NOT is_default) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER COMPUTE POOL ' || region_pool_name ||
                                  ' SET MAX_NODES = ' || orig_region_pool_max_nodes;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        IF (orig_region_svc_min IS NOT NULL AND NOT is_default) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || region_svc_name ||
                                  ' SET MIN_INSTANCES = ' || orig_region_svc_min ||
                                  ' MAX_INSTANCES = ' || orig_region_svc_max;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        IF (orig_gateway_pool_max_nodes IS NOT NULL) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET MAX_NODES = ' || orig_gateway_pool_max_nodes;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        IF (orig_gateway_svc_min IS NOT NULL) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.routing_gateway_service' ||
                                  ' SET MIN_INSTANCES = ' || orig_gateway_svc_min ||
                                  ' MAX_INSTANCES = ' || orig_gateway_svc_max;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        RETURN 'Job ' || :P_JOB_ID || ' failed: 0 pairs after flatten';
    END IF;

    UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
    SET STATUS='COMPLETE', STAGE='COMPLETE', MATRIX_ROWS=:matrix_count,
        RAW_ROWS=:raw_count, PCT_COMPLETE=100, COMPLETED_AT=SYSDATE()
    WHERE JOB_ID = :P_JOB_ID;

    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_LIST_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_WORK_QUEUE_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;
    BEGIN EXECUTE IMMEDIATE 'DROP TABLE IF EXISTS ' || prefix || '_MATRIX_RAW_' || P_RES; EXCEPTION WHEN OTHER THEN NULL; END;

    BEGIN
        ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 3600;
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    BEGIN
        EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
    EXCEPTION WHEN OTHER THEN NULL;
    END;
    IF (orig_region_pool_max_nodes IS NOT NULL AND NOT is_default) THEN
        BEGIN
            EXECUTE IMMEDIATE 'ALTER COMPUTE POOL ' || region_pool_name ||
                              ' SET MAX_NODES = ' || orig_region_pool_max_nodes;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;
    IF (orig_region_svc_min IS NOT NULL AND NOT is_default) THEN
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || region_svc_name ||
                              ' SET MIN_INSTANCES = ' || orig_region_svc_min ||
                              ' MAX_INSTANCES = ' || orig_region_svc_max;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;
    IF (orig_gateway_pool_max_nodes IS NOT NULL) THEN
        BEGIN
            EXECUTE IMMEDIATE 'ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET MAX_NODES = ' || orig_gateway_pool_max_nodes;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;
    IF (orig_gateway_svc_min IS NOT NULL) THEN
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.routing_gateway_service' ||
                              ' SET MIN_INSTANCES = ' || orig_gateway_svc_min ||
                              ' MAX_INSTANCES = ' || orig_gateway_svc_max;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
    END IF;

    RETURN 'Job ' || :P_JOB_ID || ' complete: ' || matrix_count || ' travel time pairs';
EXCEPTION
    WHEN OTHER THEN
        LET err_msg VARCHAR := SQLERRM;
        BEGIN
            ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.routing_gateway_service SET AUTO_SUSPEND_SECS = 3600;
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        BEGIN
            EXECUTE IMMEDIATE 'ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' || UPPER(P_REGION) || ' SET AUTO_SUSPEND_SECS = 14400';
        EXCEPTION WHEN OTHER THEN NULL;
        END;
        IF (orig_region_pool_max_nodes IS NOT NULL AND NOT is_default) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER COMPUTE POOL ' || region_pool_name ||
                                  ' SET MAX_NODES = ' || orig_region_pool_max_nodes;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        IF (orig_region_svc_min IS NOT NULL AND NOT is_default) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.' || region_svc_name ||
                                  ' SET MIN_INSTANCES = ' || orig_region_svc_min ||
                                  ' MAX_INSTANCES = ' || orig_region_svc_max;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        IF (orig_gateway_pool_max_nodes IS NOT NULL) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER COMPUTE POOL OPENROUTESERVICE_APP_COMPUTE_POOL SET MAX_NODES = ' || orig_gateway_pool_max_nodes;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        IF (orig_gateway_svc_min IS NOT NULL) THEN
            BEGIN
                EXECUTE IMMEDIATE 'ALTER SERVICE OPENROUTESERVICE_APP.CORE.routing_gateway_service' ||
                                  ' SET MIN_INSTANCES = ' || orig_gateway_svc_min ||
                                  ' MAX_INSTANCES = ' || orig_gateway_svc_max;
            EXCEPTION WHEN OTHER THEN NULL;
            END;
        END IF;
        UPDATE OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
        SET STATUS='ERROR', ERROR_MSG=:err_msg, COMPLETED_AT=SYSDATE()
        WHERE JOB_ID = :P_JOB_ID;
        RETURN 'Job ' || :P_JOB_ID || ' failed: ' || :err_msg;
END;
$$;
