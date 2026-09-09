/*
 * deploy-agent.sql - Routing TOOL_* procedures
 * Creates the 9 routing/demo TOOL_* procedures in FLEET_INTELLIGENCE.ROUTING_TOOLS.
 * The standalone ROUTING_AGENT Cortex Agent was retired: the app-level FLEET_AGENT
 * (which attaches OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP wrapping these procs)
 * is now the single routing+analytics agent.
 * Run: snow sql -f .cortex/skills/routing-agent/references/deploy-agent.sql -c <connection>
 *
 * For annotated explanations of each procedure, see agent-definitions.md.
 */

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE DATABASE IF NOT EXISTS FLEET_INTELLIGENCE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.ROUTING_TOOLS
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';
CREATE WAREHOUSE IF NOT EXISTS ROUTING_ANALYTICS
    WAREHOUSE_SIZE = 'XSMALL' AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ============================================================================
-- RESOLVE_PROFILE: pure resolver shared by every TOOL_* proc. Given the caller's
-- requested profile/vehicle, the canonical ORS profile the whitelist mapped it
-- to, and the list of profiles ACTUALLY built in the target region (from
-- ORS_STATUS), it returns the profile to use plus a transparency signal:
--   { requested, used, substituted, reason, note, available }
-- substituted is TRUE whenever `used` differs from the literal requested value
-- (per product decision: announce ANY profile change, incl. ebike ->
-- cycling-electric). reason is 'none' | 'renamed' | 'unavailable'. When the
-- canonical profile is not built in the region, it falls back to a same-family
-- built profile, else driving-car, else the first available - and the agent
-- surfaces `note` to the user. AVAILABLE empty/unknown => no availability claim
-- (only renames are flagged), preserving today's behavior when ORS_STATUS fails.
-- ============================================================================
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(REQUESTED STRING, CANONICAL STRING, AVAILABLE ARRAY)
RETURNS OBJECT
LANGUAGE JAVASCRIPT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$
  function fam(p){ p=String(p||''); if(p.indexOf('driving')===0)return 'driving'; if(p.indexOf('cycling')===0)return 'cycling'; if(p.indexOf('foot')===0)return 'foot'; if(p==='wheelchair')return 'wheelchair'; return 'other'; }
  var reqRaw = (REQUESTED===undefined||REQUESTED===null)?null:String(REQUESTED).trim();
  var canon  = (CANONICAL===undefined||CANONICAL===null||String(CANONICAL).trim()==='')?'driving-car':String(CANONICAL).trim().toLowerCase();
  var avail  = Array.isArray(AVAILABLE)?AVAILABLE.map(function(x){return String(x).toLowerCase();}):[];
  var used, reason;
  if(avail.length===0 || avail.indexOf(canon)>=0){ used=canon; reason='none'; }
  else {
    var f=fam(canon), same=null;
    for(var i=0;i<avail.length;i++){ if(fam(avail[i])===f){ same=avail[i]; break; } }
    used = same || (avail.indexOf('driving-car')>=0 ? 'driving-car' : avail[0]);
    reason='unavailable';
  }
  var reqKey = reqRaw?reqRaw.toLowerCase():null;
  var substituted = (reqKey!==null && reqKey!==used);
  if(reason==='none' && substituted) reason='renamed';
  var note=null;
  if(substituted){
    if(reason==='unavailable'){
      note="The requested travel type '"+reqRaw+"' is not available in this region, so the route was computed using the '"+used+"' profile instead."+(avail.length?(" Available profiles: "+avail.join(', ')+"."):"");
    } else {
      note="Routed using the '"+used+"' profile for your requested travel type '"+reqRaw+"'.";
    }
  }
  return { requested: reqRaw, used: used, substituted: substituted, reason: reason, note: note, available: avail };
$$;

-- ============================================================================
-- RESOLVE_PROFILE (2-arg overload): same resolver as above but computes the
-- canonical ORS profile internally from the caller's requested profile/vehicle
-- via the CANON map (the same vehicle->profile whitelist the geocoding procs
-- inline as a CASE). Use this from tools that do not maintain their own CASE
-- whitelist (the optimization + catchment procs). The 3-arg form is unchanged
-- and is still used by the geocoding procs, which compute canonical themselves.
-- ============================================================================
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(REQUESTED STRING, AVAILABLE ARRAY)
RETURNS OBJECT
LANGUAGE JAVASCRIPT
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS $$
  function fam(p){ p=String(p||''); if(p.indexOf('driving')===0)return 'driving'; if(p.indexOf('cycling')===0)return 'cycling'; if(p.indexOf('foot')===0)return 'foot'; if(p==='wheelchair')return 'wheelchair'; return 'other'; }
  // CANON map: mirror of the geocoding procs' CASE whitelist + DIM_VEHICLE_PROFILE.
  // The engine builds 'cycling-electric' as the only cycling graph, so every
  // cycling variant AND the 'ebike' vehicle_type canonicalize to it.
  function canonical(req){
    var k = String(req===undefined||req===null?'':req).trim().toLowerCase();
    var MAP = {
      'driving-car':'driving-car', 'car':'driving-car', 'van':'driving-car',
      'driving-hgv':'driving-hgv', 'hgv':'driving-hgv', 'truck':'driving-hgv',
      'cycling-regular':'cycling-electric', 'cycling-mountain':'cycling-electric',
      'cycling-road':'cycling-electric', 'cycling-electric':'cycling-electric',
      'ebike':'cycling-electric', 'e-bike':'cycling-electric', 'bike':'cycling-electric',
      'bicycle':'cycling-electric', 'cycle':'cycling-electric',
      'foot-walking':'foot-walking', 'foot-hiking':'foot-hiking', 'wheelchair':'wheelchair'
    };
    return MAP[k] || 'driving-car';
  }
  var reqRaw = (REQUESTED===undefined||REQUESTED===null)?null:String(REQUESTED).trim();
  var canon  = canonical(reqRaw);
  var avail  = Array.isArray(AVAILABLE)?AVAILABLE.map(function(x){return String(x).toLowerCase();}):[];
  var used, reason;
  if(avail.length===0 || avail.indexOf(canon)>=0){ used=canon; reason='none'; }
  else {
    var f=fam(canon), same=null;
    for(var i=0;i<avail.length;i++){ if(fam(avail[i])===f){ same=avail[i]; break; } }
    used = same || (avail.indexOf('driving-car')>=0 ? 'driving-car' : avail[0]);
    reason='unavailable';
  }
  var reqKey = reqRaw?reqRaw.toLowerCase():null;
  var substituted = (reqKey!==null && reqKey!==used);
  if(reason==='none' && substituted) reason='renamed';
  var note=null;
  if(substituted){
    if(reason==='unavailable'){
      note="The requested travel type '"+reqRaw+"' is not available in this region, so the route was computed using the '"+used+"' profile instead."+(avail.length?(" Available profiles: "+avail.join(', ')+"."):"");
    } else {
      note="Routed using the '"+used+"' profile for your requested travel type '"+reqRaw+"'.";
    }
  }
  return { requested: reqRaw, used: used, substituted: substituted, reason: reason, note: note, available: avail };
$$;

-- TOOL_DIRECTIONS: Wraps ORS DIRECTIONS with AI geocoding
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DIRECTIONS(
    LOCATIONS_DESCRIPTION VARCHAR,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_safe_profile VARCHAR;
    v_sql VARCHAR;
    res RESULTSET;
    v_locations VARIANT;
    v_coords VARIANT;
    v_profile VARCHAR;
    v_distance_raw FLOAT;
    v_duration_raw FLOAT;
    v_segments VARIANT;
    v_geometry VARIANT;
    v_ors_error VARIANT;
    v_detected_regions VARIANT;
    v_out_of_region_count INT;
    v_total_coords INT;
    v_available ARRAY;
    v_res VARIANT;
    v_used VARCHAR;
BEGIN
    -- Whitelist profile to prevent SQL injection when inlining into dynamic SQL.
    -- ORS DIRECTIONS does not honor bound parameters for the profile arg; inline it instead.
    v_safe_profile := CASE UPPER(PROFILE)
        WHEN 'DRIVING-CAR' THEN 'driving-car'
        WHEN 'DRIVING-HGV' THEN 'driving-hgv'
        -- The engine builds 'cycling-electric' as the only cycling graph, so map
        -- every cycling variant AND the 'ebike' vehicle_type to it. Without this a
        -- cycle/ebike request either errored (ORS 2003 'profile unknown' for the
        -- unbuilt cycling-regular/mountain/road) or silently fell through to
        -- driving-car (wrong travel mode). Keeps cycle/ebike routing as a bike.
        WHEN 'CYCLING-REGULAR' THEN 'cycling-electric'
        WHEN 'CYCLING-MOUNTAIN' THEN 'cycling-electric'
        WHEN 'CYCLING-ROAD' THEN 'cycling-electric'
        WHEN 'CYCLING-ELECTRIC' THEN 'cycling-electric'
        WHEN 'EBIKE' THEN 'cycling-electric'
        WHEN 'FOOT-WALKING' THEN 'foot-walking'
        WHEN 'FOOT-HIKING' THEN 'foot-hiking'
        WHEN 'WHEELCHAIR' THEN 'wheelchair'
        ELSE 'driving-car'
    END;

    -- Resolve the requested profile against the profiles actually built in the
    -- region (best-effort; ORS_STATUS failure -> NULL -> rename-only behavior).
    -- DIRECTIONS uses the default region, so query the default region's profiles.
    BEGIN
        SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(NULL):profiles) INTO :v_available;
    EXCEPTION WHEN OTHER THEN
        v_available := NULL;
    END;
    SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(:PROFILE, :v_safe_profile, :v_available) INTO :v_res;
    v_used := COALESCE(v_res:used::STRING, v_safe_profile);

    -- Step 1: Geocode. Pull locations + coords array out as bound variables
    -- so step 2 can pass them to DIRECTIONS without inlining a CTE-derived
    -- expression into the table function (Snowflake rejects that with
    -- "Unsupported subquery type cannot be evaluated inside Function object").
    v_sql := 'WITH geocoded AS (
            SELECT AI_COMPLETE(
                ''claude-sonnet-4-5'',
                CONCAT(''Extract all locations from this description and return their coordinates. Be precise with worldwide lat/lon coordinates. Description: '', ?),
                {''temperature'': 0, ''max_tokens'': 2000},
                {''type'': ''json'', ''schema'': {''type'': ''object'', ''properties'': {''locations'': {''type'': ''array'', ''items'': {''type'': ''object'', ''properties'': {''name'': {''type'': ''string''}, ''longitude'': {''type'': ''number''}, ''latitude'': {''type'': ''number''}}, ''required'': [''name'', ''longitude'', ''latitude'']}}}}}
            ) AS geocoded_result
        )
        SELECT
            geocoded_result:locations AS locations,
            (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(value:longitude::FLOAT, value:latitude::FLOAT))
             FROM TABLE(FLATTEN(geocoded_result, ''locations''))) AS coords
        FROM geocoded';

    res := (EXECUTE IMMEDIATE :v_sql USING (LOCATIONS_DESCRIPTION));
    LET c CURSOR FOR res;
    OPEN c;
    FETCH c INTO v_locations, v_coords;
    CLOSE c;
    v_profile := v_safe_profile;

    IF (v_locations IS NULL OR v_coords IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ROUTING FAILED: Geocoding returned no locations. Could not parse locations from the description.', 'status', 'FAILED');
    END IF;

    -- Step 1b: Region validation (best-effort; non-fatal). Done as a
    -- separate, simple FLATTEN that calls REGION_FOR_POINT per coord.
    -- Failures here just leave the region info NULL.
    BEGIN
        LET val_sql VARCHAR := 'WITH pts AS (
            SELECT
                OPENROUTESERVICE_APP.CORE.REGION_FOR_POINT(c.value[0]::FLOAT, c.value[1]::FLOAT):lookup_name::STRING AS region_name
            FROM TABLE(FLATTEN(PARSE_JSON(?))) c
        )
        SELECT
            ARRAY_AGG(DISTINCT region_name) WITHIN GROUP (ORDER BY region_name),
            COUNT_IF(region_name IS NULL),
            COUNT(*)
        FROM pts';
        LET v_coords_str VARCHAR := v_coords::STRING;
        res := (EXECUTE IMMEDIATE :val_sql USING (v_coords_str));
        LET cv CURSOR FOR res;
        OPEN cv;
        FETCH cv INTO v_detected_regions, v_out_of_region_count, v_total_coords;
        CLOSE cv;
    EXCEPTION
        WHEN OTHER THEN
            v_detected_regions := NULL;
            v_out_of_region_count := 0;
            v_total_coords := 0;
    END;

    -- Step 2: Call DIRECTIONS with coords as a bound VARIANT parameter.
    LET dir_sql VARCHAR := 'SELECT
            d.RESPONSE:features[0]:properties:summary:distance::FLOAT,
            d.RESPONSE:features[0]:properties:summary:duration::FLOAT,
            d.RESPONSE:features[0]:properties:segments,
            d.RESPONSE:features[0]:geometry,
            d.RESPONSE:error
        FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
            ''' || v_used || ''',
            OBJECT_CONSTRUCT(''coordinates'', PARSE_JSON(?))::VARIANT)) d';

    LET v_coords_str2 VARCHAR := v_coords::STRING;
    res := (EXECUTE IMMEDIATE :dir_sql USING (v_coords_str2));
    LET c2 CURSOR FOR res;
    OPEN c2;
    FETCH c2 INTO v_distance_raw, v_duration_raw, v_segments, v_geometry, v_ors_error;
    CLOSE c2;

    IF (v_locations IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ROUTING FAILED: Geocoding returned no locations. Could not parse locations from the description.', 'status', 'FAILED');
    END IF;

    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('ROUTING FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'locations_requested', v_locations, 'status', 'FAILED');
    END IF;

    IF (v_distance_raw IS NULL OR v_geometry IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error',
              CASE
                WHEN v_out_of_region_count > 0 THEN
                  CONCAT(
                    'ROUTING FAILED: ', v_out_of_region_count::VARCHAR, ' of ', v_total_coords::VARCHAR,
                    ' geocoded coordinates fell outside every provisioned region (detected: ',
                    COALESCE(v_detected_regions::VARCHAR, '[]'),
                    '). The LLM may have geocoded to the wrong city of the same name, or the destination is not in any provisioned region. Try specifying the country or region in your prompt.'
                  )
                ELSE
                  CONCAT(
                    'ROUTING FAILED: OpenRouteService could not compute a route between the requested locations. Detected regions: ',
                    COALESCE(v_detected_regions::VARCHAR, '[]'),
                    '. The locations are inside known regions but no routing graph is loaded that covers them all. Provision the necessary region(s) and retry.'
                  )
              END,
            'locations_requested', v_locations,
            'detected_regions', v_detected_regions,
            'out_of_region_count', v_out_of_region_count,
            'total_coords', v_total_coords,
            'status', 'FAILED'
        );
    END IF;

    RETURN OBJECT_CONSTRUCT(
        'locations', v_locations,
        'profile', v_used,
        'requested_profile', PROFILE,
        'used_profile', v_used,
        'profile_substituted', v_res:substituted,
        'profile_note', v_res:note,
        'distance_km', ROUND(DIV0(v_distance_raw, 1000), 2),
        'duration_mins', ROUND(DIV0(v_duration_raw, 60), 1),
        'segments', v_segments,
        'geometry', v_geometry,
        'detected_regions', v_detected_regions,
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_DIRECTIONS failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DIRECTIONS(VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_SNAP: snap free-text coordinates/places to the nearest routable road edge
-- (per-point nearest-edge snapping via ORS /snap, NOT trajectory map matching).
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_SNAP(
    LOCATIONS_DESCRIPTION VARCHAR,
    RADIUS_METERS NUMBER DEFAULT 350,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_safe_profile VARCHAR;
    v_available ARRAY;
    v_res VARIANT;
    v_used VARCHAR;
    v_sql VARCHAR;
    res RESULTSET;
    v_locations VARIANT;
    v_coords VARIANT;
    v_radius INT;
    v_points VARIANT;
    v_unsnapped INT;
    v_total INT;
BEGIN
    v_radius := COALESCE(:RADIUS_METERS, 350)::INT;
    IF (v_radius <= 0) THEN
        v_radius := 350;
    END IF;

    -- Whitelist profile to prevent SQL injection when inlining into dynamic SQL.
    -- Cycling variants + ebike map to the only built cycling graph (see TOOL_DIRECTIONS).
    v_safe_profile := CASE UPPER(PROFILE)
        WHEN 'DRIVING-CAR' THEN 'driving-car'
        WHEN 'DRIVING-HGV' THEN 'driving-hgv'
        WHEN 'CYCLING-REGULAR' THEN 'cycling-electric'
        WHEN 'CYCLING-MOUNTAIN' THEN 'cycling-electric'
        WHEN 'CYCLING-ROAD' THEN 'cycling-electric'
        WHEN 'CYCLING-ELECTRIC' THEN 'cycling-electric'
        WHEN 'EBIKE' THEN 'cycling-electric'
        WHEN 'FOOT-WALKING' THEN 'foot-walking'
        WHEN 'FOOT-HIKING' THEN 'foot-hiking'
        WHEN 'WHEELCHAIR' THEN 'wheelchair'
        ELSE 'driving-car'
    END;

    -- Resolve the requested profile against the profiles actually built in the
    -- default region (best-effort; failure -> rename-only behavior).
    BEGIN
        SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(NULL):profiles) INTO :v_available;
    EXCEPTION WHEN OTHER THEN
        v_available := NULL;
    END;
    SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(:PROFILE, :v_safe_profile, :v_available) INTO :v_res;
    v_used := COALESCE(v_res:used::STRING, v_safe_profile);

    -- Step 1: geocode the free-text description to a coords array [[lon,lat], ...].
    v_sql := 'WITH geocoded AS (
            SELECT AI_COMPLETE(
                ''claude-sonnet-4-5'',
                CONCAT(''Extract all locations/coordinates from this description and return their coordinates. Be precise with worldwide lat/lon coordinates. Description: '', ?),
                {''temperature'': 0, ''max_tokens'': 2000},
                {''type'': ''json'', ''schema'': {''type'': ''object'', ''properties'': {''locations'': {''type'': ''array'', ''items'': {''type'': ''object'', ''properties'': {''name'': {''type'': ''string''}, ''longitude'': {''type'': ''number''}, ''latitude'': {''type'': ''number''}}, ''required'': [''name'', ''longitude'', ''latitude'']}}}}}
            ) AS geocoded_result
        )
        SELECT
            geocoded_result:locations AS locations,
            (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(value:longitude::FLOAT, value:latitude::FLOAT))
             FROM TABLE(FLATTEN(geocoded_result, ''locations''))) AS coords
        FROM geocoded';

    res := (EXECUTE IMMEDIATE :v_sql USING (LOCATIONS_DESCRIPTION));
    LET c CURSOR FOR res;
    OPEN c;
    FETCH c INTO v_locations, v_coords;
    CLOSE c;

    IF (v_coords IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'SNAP FAILED: Could not parse any coordinates from the description.', 'status', 'FAILED');
    END IF;

    -- Step 2: snap each point to the nearest routable edge. v_radius is a validated
    -- INT so it is safe to inline; coords are passed as a bound VARIANT parameter.
    LET snap_sql VARCHAR := 'SELECT
            ARRAY_AGG(OBJECT_CONSTRUCT_KEEP_NULL(
                ''idx'', s.IDX,
                ''input_lon'', ST_X(s.INPUT_GEOG),
                ''input_lat'', ST_Y(s.INPUT_GEOG),
                ''snapped_lon'', ST_X(s.SNAPPED_GEOG),
                ''snapped_lat'', ST_Y(s.SNAPPED_GEOG),
                ''snapped_distance_m'', s.SNAPPED_DISTANCE,
                ''name'', s.NAME
            )) WITHIN GROUP (ORDER BY s.IDX),
            COUNT_IF(s.SNAPPED_GEOG IS NULL),
            COUNT(*)
        FROM TABLE(OPENROUTESERVICE_APP.CORE.SNAP_POINTS(''' || v_used || ''', PARSE_JSON(?), ' || v_radius || ', NULL)) s';

    LET v_coords_str VARCHAR := v_coords::STRING;
    res := (EXECUTE IMMEDIATE :snap_sql USING (v_coords_str));
    LET c2 CURSOR FOR res;
    OPEN c2;
    FETCH c2 INTO v_points, v_unsnapped, v_total;
    CLOSE c2;

    RETURN OBJECT_CONSTRUCT(
        'locations', v_locations,
        'profile', v_used,
        'requested_profile', PROFILE,
        'used_profile', v_used,
        'profile_substituted', v_res:substituted,
        'profile_note', v_res:note,
        'radius_meters', v_radius,
        'points', v_points,
        'unsnapped_count', v_unsnapped,
        'total_points', v_total,
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_SNAP failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_SNAP(VARCHAR, NUMBER, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_MATCH: map-match a free-text/coordinate trajectory to the road network and
-- return the matched road segments as GeoJSON (HMM map matching via ORS /match,
-- geometry resolved via /export). This is trajectory map matching, unlike TOOL_SNAP.
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_MATCH(
    LOCATIONS_DESCRIPTION VARCHAR,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_safe_profile VARCHAR;
    v_available ARRAY;
    v_res VARIANT;
    v_used VARCHAR;
    v_sql VARCHAR;
    res RESULTSET;
    v_locations VARIANT;
    v_coords VARIANT;
    v_coord_count INT;
    v_resp VARIANT;
    v_geojson VARIANT;
    v_matched_edges INT;
BEGIN
    -- Whitelist profile to prevent SQL injection when inlining into dynamic SQL.
    v_safe_profile := CASE UPPER(PROFILE)
        WHEN 'DRIVING-CAR' THEN 'driving-car'
        WHEN 'DRIVING-HGV' THEN 'driving-hgv'
        WHEN 'CYCLING-REGULAR' THEN 'cycling-electric'
        WHEN 'CYCLING-MOUNTAIN' THEN 'cycling-electric'
        WHEN 'CYCLING-ROAD' THEN 'cycling-electric'
        WHEN 'CYCLING-ELECTRIC' THEN 'cycling-electric'
        WHEN 'EBIKE' THEN 'cycling-electric'
        WHEN 'FOOT-WALKING' THEN 'foot-walking'
        WHEN 'FOOT-HIKING' THEN 'foot-hiking'
        WHEN 'WHEELCHAIR' THEN 'wheelchair'
        ELSE 'driving-car'
    END;

    BEGIN
        SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(NULL):profiles) INTO :v_available;
    EXCEPTION WHEN OTHER THEN
        v_available := NULL;
    END;
    SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(:PROFILE, :v_safe_profile, :v_available) INTO :v_res;
    v_used := COALESCE(v_res:used::STRING, v_safe_profile);

    -- Step 1: geocode the free-text trajectory into an ORDERED coords array.
    v_sql := 'WITH geocoded AS (
            SELECT AI_COMPLETE(
                ''claude-sonnet-4-5'',
                CONCAT(''Extract the ordered sequence of points/coordinates that form this trajectory or path and return their coordinates in order. Be precise with worldwide lat/lon coordinates. Description: '', ?),
                {''temperature'': 0, ''max_tokens'': 2000},
                {''type'': ''json'', ''schema'': {''type'': ''object'', ''properties'': {''locations'': {''type'': ''array'', ''items'': {''type'': ''object'', ''properties'': {''name'': {''type'': ''string''}, ''longitude'': {''type'': ''number''}, ''latitude'': {''type'': ''number''}}, ''required'': [''name'', ''longitude'', ''latitude'']}}}}}
            ) AS geocoded_result
        )
        SELECT
            geocoded_result:locations AS locations,
            (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(value:longitude::FLOAT, value:latitude::FLOAT))
             FROM TABLE(FLATTEN(geocoded_result, ''locations''))) AS coords
        FROM geocoded';

    res := (EXECUTE IMMEDIATE :v_sql USING (LOCATIONS_DESCRIPTION));
    LET c CURSOR FOR res;
    OPEN c;
    FETCH c INTO v_locations, v_coords;
    CLOSE c;

    v_coord_count := COALESCE(ARRAY_SIZE(v_coords), 0);
    IF (v_coords IS NULL OR v_coord_count < 2) THEN
        RETURN OBJECT_CONSTRUCT('error', 'MATCH FAILED: A trajectory needs at least 2 ordered points; could not parse enough from the description.', 'status', 'FAILED');
    END IF;

    -- Step 2: map-match the trajectory and resolve matched edges to geometry.
    LET match_sql VARCHAR := 'SELECT mp.RESPONSE, ST_ASGEOJSON(mp.GEOJSON)::VARIANT, mp.MATCHED_EDGES
        FROM TABLE(OPENROUTESERVICE_APP.CORE.MATCH_PATH(''' || v_used || ''', PARSE_JSON(?), NULL)) mp';
    LET v_coords_str VARCHAR := v_coords::STRING;
    res := (EXECUTE IMMEDIATE :match_sql USING (v_coords_str));
    LET c2 CURSOR FOR res;
    OPEN c2;
    FETCH c2 INTO v_resp, v_geojson, v_matched_edges;
    CLOSE c2;

    IF (v_resp:error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('MATCH FAILED: OpenRouteService returned an error: ', v_resp:error::VARCHAR), 'locations_requested', v_locations, 'status', 'FAILED');
    END IF;

    RETURN OBJECT_CONSTRUCT(
        'locations', v_locations,
        'profile', v_used,
        'requested_profile', PROFILE,
        'used_profile', v_used,
        'profile_substituted', v_res:substituted,
        'profile_note', v_res:note,
        'matched_geometry', v_geojson,
        'matched_edges', v_matched_edges,
        'edge_ids', v_resp:edge_ids,
        'graph_timestamp', v_resp:graph_timestamp,
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_MATCH failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_MATCH(VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_ISOCHRONE: Wraps ORS ISOCHRONES with AI geocoding
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_ISOCHRONE(
    LOCATION_DESCRIPTION VARCHAR,
    RANGE_MINUTES NUMBER,
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_safe_profile VARCHAR;
    v_sql VARCHAR;
    res RESULTSET;
    v_center VARIANT;
    v_range_minutes NUMBER;
    v_profile VARCHAR;
    v_area_raw FLOAT;
    v_geometry VARIANT;
    v_ors_error VARIANT;
    v_detected_region OBJECT;
    v_available ARRAY;
    v_res VARIANT;
    v_used VARCHAR;
BEGIN
    v_safe_profile := CASE UPPER(PROFILE)
        WHEN 'DRIVING-CAR' THEN 'driving-car'
        WHEN 'DRIVING-HGV' THEN 'driving-hgv'
        -- The engine builds 'cycling-electric' as the only cycling graph, so map
        -- every cycling variant AND the 'ebike' vehicle_type to it. Without this a
        -- cycle/ebike request either errored (ORS 2003 'profile unknown' for the
        -- unbuilt cycling-regular/mountain/road) or silently fell through to
        -- driving-car (wrong travel mode). Keeps cycle/ebike routing as a bike.
        WHEN 'CYCLING-REGULAR' THEN 'cycling-electric'
        WHEN 'CYCLING-MOUNTAIN' THEN 'cycling-electric'
        WHEN 'CYCLING-ROAD' THEN 'cycling-electric'
        WHEN 'CYCLING-ELECTRIC' THEN 'cycling-electric'
        WHEN 'EBIKE' THEN 'cycling-electric'
        WHEN 'FOOT-WALKING' THEN 'foot-walking'
        WHEN 'FOOT-HIKING' THEN 'foot-hiking'
        WHEN 'WHEELCHAIR' THEN 'wheelchair'
        ELSE 'driving-car'
    END;

    -- Resolve the requested profile against the profiles built in the region
    -- (best-effort). Surfaces requested vs used + a note when they differ.
    BEGIN
        SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(NULL):profiles) INTO :v_available;
    EXCEPTION WHEN OTHER THEN
        v_available := NULL;
    END;
    SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(:PROFILE, :v_safe_profile, :v_available) INTO :v_res;
    v_used := COALESCE(v_res:used::STRING, v_safe_profile);

    -- First attempt: try with detected region (clips to region boundary).
    v_sql := 'WITH geocoded AS (
            SELECT AI_COMPLETE(
                ''claude-sonnet-4-5'',
                CONCAT(''Extract the location from this description and return its coordinates. Be precise with worldwide lat/lon. Description: '', ?),
                {''temperature'': 0, ''max_tokens'': 1000},
                {''type'': ''json'', ''schema'': {''type'': ''object'', ''properties'': {''name'': {''type'': ''string''}, ''longitude'': {''type'': ''number''}, ''latitude'': {''type'': ''number''}}, ''required'': [''name'', ''longitude'', ''latitude'']}}
            ) AS geocoded_result
        ),
        validated AS (
            -- Resolve LLM-extracted coord to a region; the isochrone is then
            -- clipped to that region''s boundary so it doesn''t extend into
            -- foreign territory or water.
            SELECT geocoded_result,
                   OPENROUTESERVICE_APP.CORE.REGION_FOR_POINT(
                     geocoded_result:longitude::FLOAT,
                     geocoded_result:latitude::FLOAT) AS detected_region
            FROM geocoded
        ),
        isochrone AS (
            SELECT v.geocoded_result AS geo,
                   v.detected_region,
                   i.RESPONSE AS iso_result,
                   i.GEOJSON AS clipped_geom
            FROM validated v,
                 TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES_CLIPPED(
                     ''' || v_used || ''',
                     v.geocoded_result:longitude::FLOAT,
                     v.geocoded_result:latitude::FLOAT,
                     ?::NUMBER,
                     COALESCE(v.detected_region:lookup_name::STRING, ''''))) i
        )
        SELECT
            geo AS center,
            ?::NUMBER AS range_minutes,
            ''' || v_used || ''' AS profile,
            iso_result:features[0]:properties:area::FLOAT AS area_raw,
            iso_result:features[0]:geometry AS geometry,
            iso_result:error AS ors_error,
            detected_region AS detected_region
        FROM isochrone';

    res := (EXECUTE IMMEDIATE :v_sql USING (LOCATION_DESCRIPTION, RANGE_MINUTES, RANGE_MINUTES));
    LET c CURSOR FOR res;
    OPEN c;
    FETCH c INTO v_center, v_range_minutes, v_profile, v_area_raw, v_geometry, v_ors_error, v_detected_region;
    CLOSE c;

    -- If the gateway returned service_unreachable, the resolved region's ORS
    -- service is suspended or not provisioned. Surface an actionable error
    -- naming the region instead of silently falling back to the default region
    -- (which would hide the real failure and route Berlin queries to SF).
    IF (v_ors_error IS NOT NULL AND v_ors_error::STRING = 'service_unreachable' AND v_detected_region IS NOT NULL) THEN
        LET v_region_name VARCHAR := v_detected_region:lookup_name::VARCHAR;
        RETURN OBJECT_CONSTRUCT(
            'error', CONCAT(
                'ISOCHRONE FAILED: ORS service for region ',
                v_region_name,
                ' is not running. Resume it with: ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE_',
                UPPER(v_region_name),
                ' RESUME;'
            ),
            'detected_region', v_detected_region,
            'location_requested', v_center,
            'status', 'FAILED'
        );
    END IF;

    IF (v_center IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'ISOCHRONE FAILED: Geocoding returned no location. Could not parse location from the description.', 'status', 'FAILED');
    END IF;

    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('ISOCHRONE FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'location_requested', v_center, 'status', 'FAILED');
    END IF;

    IF (v_geometry IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error',
              CASE
                WHEN v_detected_region IS NULL THEN
                  'ISOCHRONE FAILED: The geocoded coordinates fall outside every provisioned region. The LLM may have geocoded to the wrong city of the same name. Try specifying the country or region in your prompt.'
                ELSE
                  CONCAT(
                    'ISOCHRONE FAILED: OpenRouteService could not compute an isochrone for ',
                    v_detected_region:lookup_name::VARCHAR,
                    '. The point is inside the region''s boundary but no routing graph is loaded for it - provision the region and retry.'
                  )
              END,
            'location_requested', v_center,
            'detected_region', v_detected_region,
            'status', 'FAILED'
        );
    END IF;

    RETURN OBJECT_CONSTRUCT(
        'center', v_center,
        'range_minutes', v_range_minutes,
        'profile', v_used,
        'requested_profile', PROFILE,
        'used_profile', v_used,
        'profile_substituted', v_res:substituted,
        'profile_note', v_res:note,
        'area_km2', ROUND(DIV0(v_area_raw, 1000000), 2),
        'geometry', v_geometry,
        'detected_region', v_detected_region,
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_ISOCHRONE failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_ISOCHRONE(VARCHAR, NUMBER, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_POI_IN_ISOCHRONE: Find Overture Maps POIs (cafes, restaurants, shops, etc.) reachable within X minutes of a location.
-- Combines ISOCHRONES_CLIPPED with OVERTURE_MAPS__PLACES.CARTO.PLACE via ST_WITHIN.
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_POI_IN_ISOCHRONE(
    LOCATION_DESCRIPTION VARCHAR,
    RANGE_MINUTES NUMBER,
    POI_CATEGORY VARCHAR,
    PROFILE VARCHAR DEFAULT 'driving-car',
    MAX_RESULTS NUMBER DEFAULT 25
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_safe_profile VARCHAR;
    v_sql VARCHAR;
    res RESULTSET;
    v_center VARIANT;
    v_range_minutes NUMBER;
    v_profile VARCHAR;
    v_category VARCHAR;
    v_iso_geojson VARIANT;
    v_iso_geojson_str VARCHAR;
    v_center_lon FLOAT;
    v_center_lat FLOAT;
    v_ors_error VARIANT;
    v_detected_region OBJECT;
    v_pois VARIANT;
    v_poi_count NUMBER;
    v_available ARRAY;
    v_res VARIANT;
    v_used VARCHAR;
BEGIN
    v_safe_profile := CASE UPPER(PROFILE)
        WHEN 'DRIVING-CAR' THEN 'driving-car'
        WHEN 'DRIVING-HGV' THEN 'driving-hgv'
        -- The engine builds 'cycling-electric' as the only cycling graph, so map
        -- every cycling variant AND the 'ebike' vehicle_type to it. Without this a
        -- cycle/ebike request either errored (ORS 2003 'profile unknown' for the
        -- unbuilt cycling-regular/mountain/road) or silently fell through to
        -- driving-car (wrong travel mode). Keeps cycle/ebike routing as a bike.
        WHEN 'CYCLING-REGULAR' THEN 'cycling-electric'
        WHEN 'CYCLING-MOUNTAIN' THEN 'cycling-electric'
        WHEN 'CYCLING-ROAD' THEN 'cycling-electric'
        WHEN 'CYCLING-ELECTRIC' THEN 'cycling-electric'
        WHEN 'EBIKE' THEN 'cycling-electric'
        WHEN 'FOOT-WALKING' THEN 'foot-walking'
        WHEN 'FOOT-HIKING' THEN 'foot-hiking'
        WHEN 'WHEELCHAIR' THEN 'wheelchair'
        ELSE 'driving-car'
    END;

    -- Resolve the requested profile against the profiles built in the region
    -- (best-effort). Surfaces requested vs used + a note when they differ.
    BEGIN
        SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(NULL):profiles) INTO :v_available;
    EXCEPTION WHEN OTHER THEN
        v_available := NULL;
    END;
    SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(:PROFILE, :v_safe_profile, :v_available) INTO :v_res;
    v_used := COALESCE(v_res:used::STRING, v_safe_profile);

    -- Step 1: Geocode + isochrone (clipped to detected region)
    v_sql := 'WITH geocoded AS (
            SELECT AI_COMPLETE(
                ''claude-sonnet-4-5'',
                CONCAT(''Extract the location from this description and return its coordinates. Be precise with worldwide lat/lon. Description: '', ?),
                {''temperature'': 0, ''max_tokens'': 1000},
                {''type'': ''json'', ''schema'': {''type'': ''object'', ''properties'': {''name'': {''type'': ''string''}, ''longitude'': {''type'': ''number''}, ''latitude'': {''type'': ''number''}}, ''required'': [''name'', ''longitude'', ''latitude'']}}
            ) AS geocoded_result
        ),
        validated AS (
            SELECT geocoded_result,
                   OPENROUTESERVICE_APP.CORE.REGION_FOR_POINT(
                     geocoded_result:longitude::FLOAT,
                     geocoded_result:latitude::FLOAT) AS detected_region
            FROM geocoded
        ),
        isochrone AS (
            SELECT v.geocoded_result AS geo,
                   v.detected_region,
                   i.RESPONSE AS iso_result
            FROM validated v,
                 TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES_CLIPPED(
                     ''' || v_used || ''',
                     v.geocoded_result:longitude::FLOAT,
                     v.geocoded_result:latitude::FLOAT,
                     ?::NUMBER,
                     COALESCE(v.detected_region:lookup_name::STRING, ''''))) i
        )
        SELECT
            geo AS center,
            ?::NUMBER AS range_minutes,
            ''' || v_used || ''' AS profile,
            iso_result:features[0]:geometry AS iso_geojson,
            iso_result:error AS ors_error,
            detected_region AS detected_region
        FROM isochrone';

    res := (EXECUTE IMMEDIATE :v_sql USING (LOCATION_DESCRIPTION, RANGE_MINUTES, RANGE_MINUTES));
    LET c CURSOR FOR res;
    OPEN c;
    FETCH c INTO v_center, v_range_minutes, v_profile, v_iso_geojson, v_ors_error, v_detected_region;
    CLOSE c;

    -- If the gateway returned service_unreachable, the resolved region's ORS
    -- service is suspended or not provisioned. Surface an actionable error
    -- naming the region instead of silently falling back to the default region.
    IF (v_ors_error IS NOT NULL AND v_ors_error::STRING = 'service_unreachable' AND v_detected_region IS NOT NULL) THEN
        LET v_region_name VARCHAR := v_detected_region:lookup_name::VARCHAR;
        RETURN OBJECT_CONSTRUCT(
            'error', CONCAT(
                'POI SEARCH FAILED: ORS service for region ',
                v_region_name,
                ' is not running. Resume it with: ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_SERVICE_',
                UPPER(v_region_name),
                ' RESUME;'
            ),
            'detected_region', v_detected_region,
            'location_requested', v_center,
            'status', 'FAILED'
        );
    END IF;

    IF (v_center IS NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', 'POI SEARCH FAILED: Geocoding returned no location. Could not parse location from the description.', 'status', 'FAILED');
    END IF;

    IF (v_ors_error IS NOT NULL) THEN
        RETURN OBJECT_CONSTRUCT('error', CONCAT('POI SEARCH FAILED: OpenRouteService returned an error: ', v_ors_error::VARCHAR), 'location_requested', v_center, 'status', 'FAILED');
    END IF;

    IF (v_iso_geojson IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'error',
              CASE
                WHEN v_detected_region IS NULL THEN
                  'POI SEARCH FAILED: The geocoded coordinates fall outside every provisioned region. The LLM may have geocoded to the wrong city of the same name. Try specifying the country or region in your prompt.'
                ELSE
                  CONCAT(
                    'POI SEARCH FAILED: OpenRouteService could not compute an isochrone for ',
                    v_detected_region:lookup_name::VARCHAR,
                    '. The point is inside the region''s boundary but no routing graph is loaded for it - provision the region and retry.'
                  )
              END,
            'location_requested', v_center,
            'detected_region', v_detected_region,
            'status', 'FAILED'
        );
    END IF;

    -- Step 2: Find Overture POIs inside the isochrone polygon, matching category.
    -- Match against BASIC_CATEGORY and CATEGORIES:primary (case-insensitive).
    v_category := LOWER(POI_CATEGORY);
    v_center_lon := v_center:longitude::FLOAT;
    v_center_lat := v_center:latitude::FLOAT;
    v_iso_geojson_str := v_iso_geojson::STRING;
    LET v_max_results NUMBER := COALESCE(MAX_RESULTS, 25);
    IF (v_max_results > 200) THEN
        v_max_results := 200;
    END IF;

    LET poi_sql VARCHAR := 'SELECT ARRAY_AGG(OBJECT_CONSTRUCT(
                ''name'', name,
                ''longitude'', lon,
                ''latitude'', lat,
                ''distance_m'', distance_m,
                ''primary_category'', primary_cat,
                ''basic_category'', basic_cat
            )) WITHIN GROUP (ORDER BY distance_m) AS pois,
            COUNT(*) AS poi_count
        FROM (
            SELECT
                p.NAMES:primary::STRING AS name,
                ST_X(p.GEOMETRY) AS lon,
                ST_Y(p.GEOMETRY) AS lat,
                ROUND(ST_DISTANCE(p.GEOMETRY, ST_MAKEPOINT(?::FLOAT, ?::FLOAT)), 0) AS distance_m,
                p.CATEGORIES:primary::STRING AS primary_cat,
                p.BASIC_CATEGORY AS basic_cat
            FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
            WHERE ST_WITHIN(p.GEOMETRY, TO_GEOGRAPHY(?))
              AND p.NAMES:primary IS NOT NULL
              AND (
                LOWER(p.BASIC_CATEGORY) = ?
                OR LOWER(p.CATEGORIES:primary::STRING) = ?
                OR LOWER(p.BASIC_CATEGORY) LIKE ''%'' || ? || ''%''
                OR LOWER(p.CATEGORIES:primary::STRING) LIKE ''%'' || ? || ''%''
              )
            ORDER BY distance_m
            LIMIT ' || v_max_results::STRING || '
        )';

    res := (EXECUTE IMMEDIATE :poi_sql USING (
        v_center_lon,
        v_center_lat,
        v_iso_geojson_str,
        v_category,
        v_category,
        v_category,
        v_category
    ));
    LET pc CURSOR FOR res;
    OPEN pc;
    FETCH pc INTO v_pois, v_poi_count;
    CLOSE pc;

    IF (v_poi_count = 0 OR v_pois IS NULL) THEN
        RETURN OBJECT_CONSTRUCT(
            'center', v_center,
            'range_minutes', v_range_minutes,
            'profile', v_used,
            'requested_profile', PROFILE,
            'used_profile', v_used,
            'profile_substituted', v_res:substituted,
            'profile_note', v_res:note,
            'category', POI_CATEGORY,
            'detected_region', v_detected_region,
            'geometry', v_iso_geojson,
            'pois', ARRAY_CONSTRUCT(),
            'count', 0,
            'message', CONCAT('No POIs matching category "', POI_CATEGORY, '" were found within the ', v_range_minutes::VARCHAR, '-minute ', v_profile, ' isochrone. Try a broader category (e.g. "restaurant" instead of "specialty bistro") or a longer range.'),
            'status', 'SUCCESS'
        );
    END IF;

    RETURN OBJECT_CONSTRUCT(
        'center', v_center,
        'range_minutes', v_range_minutes,
        'profile', v_used,
        'requested_profile', PROFILE,
        'used_profile', v_used,
        'profile_substituted', v_res:substituted,
        'profile_note', v_res:note,
        'category', POI_CATEGORY,
        'detected_region', v_detected_region,
        'geometry', v_iso_geojson,
        'pois', v_pois,
        'count', v_poi_count,
        'status', 'SUCCESS'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_POI_IN_ISOCHRONE failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_POI_IN_ISOCHRONE(VARCHAR, NUMBER, VARCHAR, VARCHAR, NUMBER) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ============================================================================
-- TOOL_OVERTURE_SEARCH: Region-wide (NON-isochrone) Overture Maps Places search.
--   Answers "how many / list / which cities" questions over OVERTURE_MAPS__PLACES
--   bounded by either a provisioned region's REGION_CATALOG.BOUNDARY polygon OR an
--   explicit bbox. Complements TOOL_POI_IN_ISOCHRONE (which is drive-time bound).
--
-- Cost-safe by construction:
--   1. bbox prefilter (ST_X/ST_Y BETWEEN) for partition pruning, THEN
--   2. ST_WITHIN(BOUNDARY) authoritative polygon refine (NULL-safe -> bbox-only
--      when no boundary / bbox mode), THEN
--   3. a hard LIMIT (capped at 500) on returned rows/groups.
-- Bounding: pass REGION (resolved via REGION_CATALOG) OR a full bbox
--   (MIN_LON/MIN_LAT/MAX_LON/MAX_LAT). Region wins when both are supplied and the
--   region resolves; an unresolved region falls back to the bbox when present.
-- GROUP_BY: 'list' (default; individual places), 'city' (counts by city), or
--   'category' (counts by basic_category). POI_CATEGORY is optional; when given it
--   matches BASIC_CATEGORY / CATEGORIES:primary with an equality + LIKE fallback.
-- ============================================================================
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_OVERTURE_SEARCH(
    REGION VARCHAR DEFAULT NULL,
    POI_CATEGORY VARCHAR DEFAULT NULL,
    GROUP_BY VARCHAR DEFAULT NULL,
    MAX_RESULTS NUMBER DEFAULT 100,
    MIN_LON FLOAT DEFAULT NULL,
    MIN_LAT FLOAT DEFAULT NULL,
    MAX_LON FLOAT DEFAULT NULL,
    MAX_LAT FLOAT DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_region VARCHAR;
    v_xmn FLOAT;
    v_xmx FLOAT;
    v_ymn FLOAT;
    v_ymx FLOAT;
    v_region_found BOOLEAN DEFAULT FALSE;
    v_cat VARCHAR;
    v_cat_l VARCHAR;
    v_has_cat BOOLEAN;
    v_geometry VARIANT;
    v_mode VARCHAR;
    v_max NUMBER;
    v_bounds VARCHAR;
    v_sql VARCHAR;
    v_rows VARIANT;
    v_cnt NUMBER;
    res RESULTSET;
BEGIN
    v_region := NULLIF(TRIM(COALESCE(REGION, '')), '');

    -- Resolve the region's bbox from its boundary polygon (smallest matching
    -- boundary wins, so a city boundary beats a country boundary of the same name).
    IF (v_region IS NOT NULL) THEN
        res := (EXECUTE IMMEDIATE
            'SELECT ST_XMIN(BOUNDARY), ST_XMAX(BOUNDARY), ST_YMIN(BOUNDARY), ST_YMAX(BOUNDARY)
             FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
             WHERE BOUNDARY IS NOT NULL
               AND (UPPER(LOOKUP_NAME) = UPPER(?) OR UPPER(REGION_KEY) = UPPER(?))
             ORDER BY COALESCE(BOUNDARY_AREA_KM2, 1e15) ASC
             LIMIT 1'
            USING (v_region, v_region));
        LET rc CURSOR FOR res;
        OPEN rc;
        FETCH rc INTO v_xmn, v_xmx, v_ymn, v_ymx;
        CLOSE rc;
        v_region_found := (v_xmn IS NOT NULL);
    END IF;

    -- Fallback to an explicit bbox when no region resolved. If the region was named
    -- but not found AND no bbox was supplied, surface a typed, actionable error.
    IF (NOT v_region_found) THEN
        IF (MIN_LON IS NOT NULL AND MIN_LAT IS NOT NULL AND MAX_LON IS NOT NULL AND MAX_LAT IS NOT NULL) THEN
            v_xmn := MIN_LON; v_xmx := MAX_LON; v_ymn := MIN_LAT; v_ymx := MAX_LAT;
            v_region := NULL;  -- disable boundary refine; bbox is the only bound
        ELSE
            RETURN OBJECT_CONSTRUCT(
                'error', CASE
                    WHEN v_region IS NOT NULL THEN
                        'OVERTURE SEARCH FAILED: region "' || REGION || '" has no boundary in REGION_CATALOG. Provision the region, or pass an explicit bbox (min_lon/min_lat/max_lon/max_lat).'
                    ELSE
                        'OVERTURE SEARCH FAILED: provide either a provisioned region or a full bbox (min_lon/min_lat/max_lon/max_lat).'
                END,
                'error_code', 'OVERTURE_REGION_NOT_FOUND',
                'status', 'FAILED');
        END IF;
    END IF;

    -- Category (optional). has_cat=FALSE bypasses the whole category predicate.
    v_cat := NULLIF(TRIM(COALESCE(POI_CATEGORY, '')), '');
    v_has_cat := (v_cat IS NOT NULL);
    v_cat_l := COALESCE(LOWER(v_cat), '');

    -- Mode.
    v_mode := LOWER(NULLIF(TRIM(COALESCE(GROUP_BY, '')), ''));
    IF (v_mode IS NULL) THEN v_mode := 'list'; END IF;
    IF (v_mode NOT IN ('list', 'city', 'category')) THEN
        RETURN OBJECT_CONSTRUCT(
            'error', 'OVERTURE SEARCH FAILED: group_by must be one of list, city, category (got "' || GROUP_BY || '").',
            'error_code', 'OVERTURE_UNSUPPORTED_GROUP_BY',
            'status', 'FAILED');
    END IF;

    -- Hard cap on returned rows/groups.
    v_max := COALESCE(MAX_RESULTS, 100);
    IF (v_max < 1) THEN v_max := 1; END IF;
    IF (v_max > 500) THEN v_max := 500; END IF;

    -- Shared FROM/WHERE: bbox prune + NULL-safe boundary refine + optional category.
    -- 12 binds in order: xmn, xmx, ymn, ymx, region(IS NULL test), region, region,
    -- has_cat, cat, cat, cat, cat.
    v_bounds :=
        ' FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p' ||
        ' WHERE ST_X(p.GEOMETRY) BETWEEN ? AND ?' ||
        '   AND ST_Y(p.GEOMETRY) BETWEEN ? AND ?' ||
        '   AND ( ? IS NULL OR ST_WITHIN(p.GEOMETRY, (' ||
        '         SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG' ||
        '         WHERE BOUNDARY IS NOT NULL' ||
        '           AND (UPPER(LOOKUP_NAME) = UPPER(?) OR UPPER(REGION_KEY) = UPPER(?))' ||
        '         ORDER BY COALESCE(BOUNDARY_AREA_KM2, 1e15) ASC LIMIT 1)) )' ||
        '   AND ( NOT ? OR (' ||
        '         LOWER(p.BASIC_CATEGORY) = ?' ||
        '         OR LOWER(p.CATEGORIES:primary::STRING) = ?' ||
        '         OR LOWER(p.BASIC_CATEGORY) LIKE ''%'' || ? || ''%''' ||
        '         OR LOWER(p.CATEGORIES:primary::STRING) LIKE ''%'' || ? || ''%'') )';

    IF (v_mode = 'city') THEN
        v_sql := 'SELECT ARRAY_AGG(OBJECT_CONSTRUCT(''city'', city, ''state'', state, ''poi_count'', cnt))' ||
                 '         WITHIN GROUP (ORDER BY cnt DESC) AS out_rows, SUM(cnt) AS cnt, NULL AS geometry FROM (' ||
                 '  SELECT p.ADDRESSES[0]:locality::STRING AS city, p.ADDRESSES[0]:region::STRING AS state, COUNT(*) AS cnt' ||
                 v_bounds ||
                 '   AND p.ADDRESSES[0]:locality IS NOT NULL GROUP BY 1, 2 ORDER BY cnt DESC LIMIT ' || v_max::STRING || ')';
    ELSEIF (v_mode = 'category') THEN
        v_sql := 'SELECT ARRAY_AGG(OBJECT_CONSTRUCT(''basic_category'', basic_cat, ''poi_count'', cnt))' ||
                 '         WITHIN GROUP (ORDER BY cnt DESC) AS out_rows, SUM(cnt) AS cnt, NULL AS geometry FROM (' ||
                 '  SELECT p.BASIC_CATEGORY AS basic_cat, COUNT(*) AS cnt' ||
                 v_bounds ||
                 '   AND p.BASIC_CATEGORY IS NOT NULL GROUP BY 1 ORDER BY cnt DESC LIMIT ' || v_max::STRING || ')';
    ELSE
        -- list mode also emits a GeoJSON FeatureCollection of Point features so the
        -- inline chat map can plot the places (RouteMapInline deep-scans for GeoJSON).
        v_sql := 'SELECT ARRAY_AGG(OBJECT_CONSTRUCT(''name'', name, ''longitude'', lon, ''latitude'', lat,' ||
                 '   ''primary_category'', primary_cat, ''basic_category'', basic_cat, ''city'', city, ''state'', state))' ||
                 '         WITHIN GROUP (ORDER BY name) AS out_rows, COUNT(*) AS cnt,' ||
                 '       OBJECT_CONSTRUCT(''type'', ''FeatureCollection'', ''features'',' ||
                 '         COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(''type'', ''Feature'',' ||
                 '           ''geometry'', OBJECT_CONSTRUCT(''type'', ''Point'', ''coordinates'', ARRAY_CONSTRUCT(lon, lat)),' ||
                 '           ''properties'', OBJECT_CONSTRUCT(''name'', name, ''category'', basic_cat, ''city'', city))), ARRAY_CONSTRUCT())) AS geometry FROM (' ||
                 '  SELECT p.NAMES:primary::STRING AS name, ST_X(p.GEOMETRY) AS lon, ST_Y(p.GEOMETRY) AS lat,' ||
                 '         p.CATEGORIES:primary::STRING AS primary_cat, p.BASIC_CATEGORY AS basic_cat,' ||
                 '         p.ADDRESSES[0]:locality::STRING AS city, p.ADDRESSES[0]:region::STRING AS state' ||
                 v_bounds ||
                 '   AND p.NAMES:primary IS NOT NULL LIMIT ' || v_max::STRING || ')';
    END IF;

    res := (EXECUTE IMMEDIATE :v_sql USING (
        v_xmn, v_xmx, v_ymn, v_ymx,
        v_region, v_region, v_region,
        v_has_cat, v_cat_l, v_cat_l, v_cat_l, v_cat_l));
    LET dc CURSOR FOR res;
    OPEN dc;
    FETCH dc INTO v_rows, v_cnt, v_geometry;
    CLOSE dc;

    RETURN OBJECT_CONSTRUCT(
        'status', 'SUCCESS',
        'region', REGION,
        'mode', v_mode,
        'category', POI_CATEGORY,
        'bbox', OBJECT_CONSTRUCT('min_lon', v_xmn, 'min_lat', v_ymn, 'max_lon', v_xmx, 'max_lat', v_ymx),
        'boundary_refined', v_region_found,
        'count', COALESCE(v_cnt, 0),
        'rows', COALESCE(v_rows, ARRAY_CONSTRUCT()),
        'geometry', v_geometry);
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_OVERTURE_SEARCH failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_OVERTURE_SEARCH(VARCHAR, VARCHAR, VARCHAR, NUMBER, FLOAT, FLOAT, FLOAT, FLOAT) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- ============================================================================
-- TOOL_OVERTURE_ADDRESSES: Region/bbox-bounded Overture address density.
--   Answers "address count / coverage" questions over OVERTURE_MAPS__ADDRESSES.
--   Same cost-safe bounding contract as TOOL_OVERTURE_SEARCH (bbox prune +
--   NULL-safe ST_WITHIN(BOUNDARY) + hard LIMIT). GROUP_BY: 'city' (default;
--   address counts per city) or 'list' (sampled individual addresses).
-- ============================================================================
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_OVERTURE_ADDRESSES(
    REGION VARCHAR DEFAULT NULL,
    GROUP_BY VARCHAR DEFAULT NULL,
    MAX_RESULTS NUMBER DEFAULT 100,
    MIN_LON FLOAT DEFAULT NULL,
    MIN_LAT FLOAT DEFAULT NULL,
    MAX_LON FLOAT DEFAULT NULL,
    MAX_LAT FLOAT DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    v_region VARCHAR;
    v_xmn FLOAT;
    v_xmx FLOAT;
    v_ymn FLOAT;
    v_ymx FLOAT;
    v_region_found BOOLEAN DEFAULT FALSE;
    v_geometry VARIANT;
    v_mode VARCHAR;
    v_max NUMBER;
    v_bounds VARCHAR;
    v_sql VARCHAR;
    v_rows VARIANT;
    v_cnt NUMBER;
    res RESULTSET;
BEGIN
    v_region := NULLIF(TRIM(COALESCE(REGION, '')), '');

    IF (v_region IS NOT NULL) THEN
        res := (EXECUTE IMMEDIATE
            'SELECT ST_XMIN(BOUNDARY), ST_XMAX(BOUNDARY), ST_YMIN(BOUNDARY), ST_YMAX(BOUNDARY)
             FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
             WHERE BOUNDARY IS NOT NULL
               AND (UPPER(LOOKUP_NAME) = UPPER(?) OR UPPER(REGION_KEY) = UPPER(?))
             ORDER BY COALESCE(BOUNDARY_AREA_KM2, 1e15) ASC
             LIMIT 1'
            USING (v_region, v_region));
        LET rc CURSOR FOR res;
        OPEN rc;
        FETCH rc INTO v_xmn, v_xmx, v_ymn, v_ymx;
        CLOSE rc;
        v_region_found := (v_xmn IS NOT NULL);
    END IF;

    IF (NOT v_region_found) THEN
        IF (MIN_LON IS NOT NULL AND MIN_LAT IS NOT NULL AND MAX_LON IS NOT NULL AND MAX_LAT IS NOT NULL) THEN
            v_xmn := MIN_LON; v_xmx := MAX_LON; v_ymn := MIN_LAT; v_ymx := MAX_LAT;
            v_region := NULL;
        ELSE
            RETURN OBJECT_CONSTRUCT(
                'error', CASE
                    WHEN v_region IS NOT NULL THEN
                        'OVERTURE ADDRESS SEARCH FAILED: region "' || REGION || '" has no boundary in REGION_CATALOG. Provision the region, or pass an explicit bbox.'
                    ELSE
                        'OVERTURE ADDRESS SEARCH FAILED: provide either a provisioned region or a full bbox (min_lon/min_lat/max_lon/max_lat).'
                END,
                'error_code', 'OVERTURE_REGION_NOT_FOUND',
                'status', 'FAILED');
        END IF;
    END IF;

    v_mode := LOWER(NULLIF(TRIM(COALESCE(GROUP_BY, '')), ''));
    IF (v_mode IS NULL) THEN v_mode := 'city'; END IF;
    IF (v_mode NOT IN ('list', 'city')) THEN
        RETURN OBJECT_CONSTRUCT(
            'error', 'OVERTURE ADDRESS SEARCH FAILED: group_by must be one of list, city (got "' || GROUP_BY || '").',
            'error_code', 'OVERTURE_UNSUPPORTED_GROUP_BY',
            'status', 'FAILED');
    END IF;

    v_max := COALESCE(MAX_RESULTS, 100);
    IF (v_max < 1) THEN v_max := 1; END IF;
    IF (v_max > 500) THEN v_max := 500; END IF;

    -- 7 binds: xmn, xmx, ymn, ymx, region(IS NULL test), region, region.
    v_bounds :=
        ' FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS a' ||
        ' WHERE a.GEOMETRY IS NOT NULL' ||
        '   AND ST_X(a.GEOMETRY) BETWEEN ? AND ?' ||
        '   AND ST_Y(a.GEOMETRY) BETWEEN ? AND ?' ||
        '   AND ( ? IS NULL OR ST_WITHIN(a.GEOMETRY, (' ||
        '         SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG' ||
        '         WHERE BOUNDARY IS NOT NULL' ||
        '           AND (UPPER(LOOKUP_NAME) = UPPER(?) OR UPPER(REGION_KEY) = UPPER(?))' ||
        '         ORDER BY COALESCE(BOUNDARY_AREA_KM2, 1e15) ASC LIMIT 1)) )';

    IF (v_mode = 'list') THEN
        -- list mode also emits a GeoJSON FeatureCollection of Point features so the
        -- inline chat map can plot the addresses (RouteMapInline deep-scans for GeoJSON).
        v_sql := 'SELECT ARRAY_AGG(OBJECT_CONSTRUCT(''id'', id, ''longitude'', lon, ''latitude'', lat,' ||
                 '   ''city'', city, ''postcode'', postcode)) AS out_rows, COUNT(*) AS cnt,' ||
                 '       OBJECT_CONSTRUCT(''type'', ''FeatureCollection'', ''features'',' ||
                 '         COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(''type'', ''Feature'',' ||
                 '           ''geometry'', OBJECT_CONSTRUCT(''type'', ''Point'', ''coordinates'', ARRAY_CONSTRUCT(lon, lat)),' ||
                 '           ''properties'', OBJECT_CONSTRUCT(''city'', city, ''postcode'', postcode))), ARRAY_CONSTRUCT())) AS geometry FROM (' ||
                 '  SELECT a.ID AS id, ST_X(a.GEOMETRY) AS lon, ST_Y(a.GEOMETRY) AS lat,' ||
                 '         a.ADDRESS_LEVELS[1]:value::STRING AS city, a.POSTCODE::STRING AS postcode' ||
                 v_bounds ||
                 '   LIMIT ' || v_max::STRING || ')';
    ELSE
        v_sql := 'SELECT ARRAY_AGG(OBJECT_CONSTRUCT(''city'', city, ''address_count'', cnt))' ||
                 '         WITHIN GROUP (ORDER BY cnt DESC) AS out_rows, SUM(cnt) AS cnt, NULL AS geometry FROM (' ||
                 '  SELECT a.ADDRESS_LEVELS[1]:value::STRING AS city, COUNT(*) AS cnt' ||
                 v_bounds ||
                 '   AND a.ADDRESS_LEVELS[1]:value IS NOT NULL GROUP BY 1 ORDER BY cnt DESC LIMIT ' || v_max::STRING || ')';
    END IF;

    res := (EXECUTE IMMEDIATE :v_sql USING (
        v_xmn, v_xmx, v_ymn, v_ymx,
        v_region, v_region, v_region));
    LET dc CURSOR FOR res;
    OPEN dc;
    FETCH dc INTO v_rows, v_cnt, v_geometry;
    CLOSE dc;

    RETURN OBJECT_CONSTRUCT(
        'status', 'SUCCESS',
        'region', REGION,
        'mode', v_mode,
        'bbox', OBJECT_CONSTRUCT('min_lon', v_xmn, 'min_lat', v_ymn, 'max_lon', v_xmx, 'max_lat', v_ymx),
        'boundary_refined', v_region_found,
        'count', COALESCE(v_cnt, 0),
        'rows', COALESCE(v_rows, ARRAY_CONSTRUCT()),
        'geometry', v_geometry);
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_OVERTURE_ADDRESSES failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_OVERTURE_ADDRESSES(VARCHAR, VARCHAR, NUMBER, FLOAT, FLOAT, FLOAT, FLOAT) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- TOOL_ROUTE_OPTIMIZATION: Wraps ORS OPTIMIZATION with AI geocoding (Python)
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_ROUTE_OPTIMIZATION(
    DELIVERY_LOCATIONS VARCHAR,
    DEPOT_LOCATION VARCHAR,
    NUM_VEHICLES NUMBER,
    PROFILE VARCHAR DEFAULT 'driving-car',
    REGION VARCHAR DEFAULT 'SanFrancisco'
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'run'
AS
$$
import json
from snowflake.snowpark import Session

def _escape_sql_string(s: str) -> str:
    """Escape single quotes for safe SQL string interpolation."""
    return s.replace("'", "''")

# Suspended-engine detection: a suspended regional ORS/VROOM makes the gateway
# return an embedded error / thrown error naming an unresolvable service host.
# Mirrors SUSPEND_SIGNATURES in the SA app's lib/routing-suspend.ts so the chat
# layer can resume + show a friendly notice instead of a raw connection error.
def _ors_suspended(txt) -> bool:
    t = str(txt or '').lower()
    sigs = ['failed to resolve', 'nameresolutionerror', 'max retries exceeded',
            'name or service not known', 'matrix pre-compute failed',
            'matrix precompute failed', 'matrix_precompute_failed',
            'service_unreachable', 'connection refused', 'optimization_unavailable']
    return any(s in t for s in sigs)

def _vroom_svc(region) -> str:
    import re
    return 'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_' + re.sub(r'[^A-Z0-9_]', '', str(region).upper())

def run(session: Session, delivery_locations: str, depot_location: str, num_vehicles: int, profile: str, region: str) -> dict:
    try:
        # An explicit NULL region bind from the verb bypasses the SQL DEFAULT, so
        # coalesce here too. The provisioned default region is SanFrancisco.
        region = region or 'SanFrancisco'
        safe_delivery = _escape_sql_string(delivery_locations)
        delivery_query = f"""
        SELECT AI_COMPLETE(
            'claude-sonnet-4-5',
            'Extract all delivery locations and return coordinates. Description: {safe_delivery}',
            {{'temperature': 0, 'max_tokens': 3000}},
            {{'type': 'json', 'schema': {{'type': 'object', 'properties': {{'locations': {{'type': 'array', 'items': {{'type': 'object', 'properties': {{'name': {{'type': 'string'}}, 'longitude': {{'type': 'number'}}, 'latitude': {{'type': 'number'}}}}, 'required': ['name', 'longitude', 'latitude']}}}}}}}}}}
        ) AS result
        """
        delivery_result = session.sql(delivery_query).collect()[0]['RESULT']
        delivery_data = json.loads(delivery_result) if isinstance(delivery_result, str) else delivery_result

        if not delivery_data.get('locations'):
            return {'error': 'OPTIMIZATION FAILED: Geocoding returned no delivery locations. Could not parse locations from the description.', 'status': 'FAILED'}

        safe_depot = _escape_sql_string(depot_location)
        depot_query = f"""
        SELECT AI_COMPLETE(
            'claude-sonnet-4-5',
            'Extract the depot location coordinates. Description: {safe_depot}',
            {{'temperature': 0, 'max_tokens': 1000}},
            {{'type': 'json', 'schema': {{'type': 'object', 'properties': {{'name': {{'type': 'string'}}, 'longitude': {{'type': 'number'}}, 'latitude': {{'type': 'number'}}}}, 'required': ['name', 'longitude', 'latitude']}}}}
        ) AS result
        """
        depot_result = session.sql(depot_query).collect()[0]['RESULT']
        depot_data = json.loads(depot_result) if isinstance(depot_result, str) else depot_result

        if 'longitude' not in depot_data or 'latitude' not in depot_data:
            return {'error': 'OPTIMIZATION FAILED: Geocoding failed for the depot location. Could not parse coordinates.', 'status': 'FAILED'}

        jobs = []
        for i, loc in enumerate(delivery_data.get('locations', []), start=1):
            jobs.append({
                'id': i,
                'location': [loc['longitude'], loc['latitude']],
                'description': loc['name']
            })

        # Resolve the requested profile against the profiles actually built in
        # the target region (best-effort; ORS_STATUS failure -> [] -> rename-only
        # behavior). The SQL UDF is the single resolver + substitution detector.
        try:
            avail_raw = session.sql(
                "SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(?):profiles) AS K",
                params=[region],
            ).collect()[0]['K']
            available = json.loads(avail_raw) if isinstance(avail_raw, str) else (avail_raw or [])
        except Exception:
            available = []
        avail_json = json.dumps(available).replace("'", "''")
        safe_profile = _escape_sql_string(profile or '')
        res_raw = session.sql(
            f"SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE('{safe_profile}', PARSE_JSON('{avail_json}')::ARRAY) AS R"
        ).collect()[0]['R']
        res = json.loads(res_raw) if isinstance(res_raw, str) else (res_raw or {})
        used_profile = res.get('used') or 'driving-car'
        prof_fields = {
            'requested_profile': profile,
            'used_profile': used_profile,
            'profile_substituted': res.get('substituted'),
            'profile_note': res.get('note'),
        }

        vehicles = []
        for i in range(1, num_vehicles + 1):
            vehicles.append({
                'id': i,
                'profile': used_profile,
                'start': [depot_data['longitude'], depot_data['latitude']],
                'end': [depot_data['longitude'], depot_data['latitude']]
            })

        jobs_json = json.dumps(jobs).replace("'", "''")
        vehicles_json = json.dumps(vehicles).replace("'", "''")

        opt_query = f"""
        SELECT RESPONSE AS result FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
            OBJECT_CONSTRUCT('jobs', PARSE_JSON('{jobs_json}')::ARRAY, 'vehicles', PARSE_JSON('{vehicles_json}')::ARRAY)::VARIANT,
            '{region}'
        ))
        """
        _opt_rows = session.sql(opt_query).collect()
        if not _opt_rows:
            # The OPTIMIZATION TVF flattens resp:routes; a suspended/cold VROOM
            # returns an empty/error body -> 0 rows. Surface a typed reason so the
            # chat layer resumes the engine and shows a friendly notice (indexing
            # [0] here would otherwise throw a generic "list index out of range").
            return {
                'status': 'FAILED', 'region': region, 'reason': 'OPTIMIZATION_UNAVAILABLE',
                'vroom_service': _vroom_svc(region),
                'error': f'Route optimization service for {region} is not responding (it may be suspended or starting) or returned no routable result. Resume it and retry.'
            }
        opt_result = _opt_rows[0]['RESULT']
        opt_data = json.loads(opt_result) if isinstance(opt_result, str) else opt_result

        if 'error' in opt_data:
            if _ors_suspended(opt_data['error']):
                return {
                    'status': 'FAILED', 'region': region, 'reason': 'OPTIMIZATION_UNAVAILABLE',
                    'vroom_service': _vroom_svc(region),
                    'error': f'Route optimization service for {region} is not responding (it may be suspended or starting). Resume it and retry.'
                }
            return {
                'error': f"OPTIMIZATION FAILED: OpenRouteService returned an error: {opt_data['error']}",
                'deliveries_requested': delivery_data.get('locations', []),
                'depot_requested': depot_data,
                **prof_fields,
                'status': 'FAILED'
            }

        routes = opt_data.get('routes', [])
        if not routes:
            return {
                'error': 'OPTIMIZATION FAILED: OpenRouteService could not compute routes for the requested locations. This typically means the locations are OUTSIDE the loaded map region. The routing engine only has map data for a specific geographic area.',
                'deliveries_requested': delivery_data.get('locations', []),
                'depot_requested': depot_data,
                **prof_fields,
                'status': 'FAILED'
            }

        unassigned = opt_data.get('unassigned', [])
        if len(unassigned) == len(jobs):
            return {
                'error': 'OPTIMIZATION FAILED: None of the delivery locations could be routed. This typically means ALL locations are OUTSIDE the loaded map region.',
                'deliveries_requested': delivery_data.get('locations', []),
                'depot_requested': depot_data,
                **prof_fields,
                'status': 'FAILED'
            }

        return {
            'deliveries': delivery_data.get('locations', []),
            'depot': depot_data,
            'num_vehicles': num_vehicles,
            'routes': routes,
            'unassigned': unassigned,
            'summary': opt_data.get('summary', {}),
            **prof_fields,
            'status': 'SUCCESS'
        }

    except json.JSONDecodeError as e:
        return {'error': f'OPTIMIZATION FAILED: Failed to parse geocoding response as JSON: {str(e)}', 'status': 'FAILED'}
    except KeyError as e:
        return {'error': f'OPTIMIZATION FAILED: Missing expected field in geocoding response: {str(e)}', 'status': 'FAILED'}
    except Exception as e:
        if _ors_suspended(str(e)):
            return {
                'status': 'FAILED', 'region': region, 'reason': 'OPTIMIZATION_UNAVAILABLE',
                'vroom_service': _vroom_svc(region),
                'error': f'Route optimization service for {region} is not responding ({str(e)}). Resume it and retry.'
            }
        return {'error': f'OPTIMIZATION FAILED: {str(e)}', 'status': 'FAILED'}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_ROUTE_OPTIMIZATION(VARCHAR, VARCHAR, NUMBER, VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_NETWORK_OPTIMIZATION: Distribution-network routing plan (region-scoped,
-- domain-neutral). Sources key sites live from the active region's Overture POIs
-- (FLEET_INTELLIGENCE.CATCHMENT.POIS, constrained to the region BOUNDARY and
-- pre-filtered to road-network-routable points), derives a neutral handling tier
-- per site from its category, computes the depot as the POI centroid, and builds
-- a 3-vehicle VROOM payload. The active region comes from CATCHMENT.CONFIG. No
-- static demo tables - works for any provisioned region with Overture coverage.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_NETWORK_OPTIMIZATION(
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
// Neutral handling-tier labels derived from a POI's category (no industry terms).
var TIER_LABELS = { 1: 'Tier 1 - Priority', 2: 'Tier 2 - Restricted', 3: 'Tier 3 - Standard' };
function execScalar(sqlText, binds) {
    var rs = snowflake.createStatement({ sqlText: sqlText, binds: binds || [] }).execute();
    return rs.next() ? rs.getColumnValue(1) : null;
}
function execScalarPair(sqlText, binds) {
    var rs = snowflake.createStatement({ sqlText: sqlText, binds: binds || [] }).execute();
    return rs.next() ? [rs.getColumnValue(1), rs.getColumnValue(2)] : null;
}
function resolveActiveRegion() {
    var sqls = [
        "SELECT REGION FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1",
        "SELECT REGION FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE LIMIT 1"
    ];
    for (var i = 0; i < sqls.length; i++) {
        try { var v = execScalar(sqls[i]); if (v) return v; } catch(e) { /* next */ }
    }
    return 'SanFrancisco';
}
function resolveProfileFor(profile, region) {
    var available = [];
    try {
        var a = execScalar("SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(?):profiles)", [region]);
        available = a ? ((typeof a === 'string') ? JSON.parse(a) : a) : [];
    } catch(e) { available = []; }
    var res = {};
    try {
        var p = execScalar("SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(?, PARSE_JSON(?)::ARRAY)",
                           [profile, JSON.stringify(available)]);
        res = p ? ((typeof p === 'string') ? JSON.parse(p) : p) : {};
    } catch(e) { res = {}; }
    return res;
}
try {
    var region = resolveActiveRegion();

    var profRes = resolveProfileFor(PROFILE, region);
    var usedProfile = profRes.used || 'driving-car';
    var profSubstituted = (profRes.substituted === undefined) ? null : profRes.substituted;
    var profNote = (profRes.note === undefined) ? null : profRes.note;

    // Depot = centroid of the region's POIs (region-agnostic; no static depot).
    var depotLon = null, depotLat = null;
    try {
        var dRs = snowflake.createStatement({
            sqlText: "SELECT AVG(LONGITUDE) LO, AVG(LATITUDE) LA FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION = ?",
            binds: [region] }).execute();
        if (dRs.next()) {
            var lo = Number(dRs.getColumnValue("LO")); var la = Number(dRs.getColumnValue("LA"));
            if (!isNaN(lo) && !isNaN(la)) { depotLon = lo; depotLat = la; }
        }
    } catch(e) { /* depot stays null -> caught by guard */ }
    var depotName = region + ' Distribution Hub';

    // Keep only POIs that snap to the road network within the engine's snapping
    // Key sites = deterministic top-N live POIs for the active region that SNAP
    // to the road network. A single off-network point makes VROOM abort the whole
    // solve, so the routable filter (MATRIX snapped_distance <= 350m) runs in SQL.
    var siteStmt = snowflake.createStatement({
        sqlText:
            "WITH cand AS (" +
            "  SELECT p.POI_NAME, p.ADDRESS, p.LONGITUDE, p.LATITUDE, " +
            "         MOD(ABS(HASH(p.BASIC_CATEGORY)),3)+1 AS TIER, p.BASIC_CATEGORY, " +
            "         ROW_NUMBER() OVER (ORDER BY p.POI_ID) AS RN " +
            "  FROM FLEET_INTELLIGENCE.CATCHMENT.POIS p " +
            "  JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc ON rc.BOUNDARY IS NOT NULL " +
            "    AND (UPPER(rc.LOOKUP_NAME)=UPPER(?) OR UPPER(rc.REGION_KEY)=UPPER(?)) " +
            "  WHERE p.REGION = ? AND p.LONGITUDE IS NOT NULL AND p.LATITUDE IS NOT NULL " +
            "    AND ST_WITHIN(p.GEOMETRY, rc.BOUNDARY) " +
            "  ORDER BY p.POI_ID LIMIT 40), " +
            "a AS (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LONGITUDE,LATITUDE)) WITHIN GROUP (ORDER BY RN) AS C FROM cand), " +
            "snap AS (SELECT f.INDEX AS IDX, f.VALUE:snapped_distance::FLOAT AS SD " +
            "         FROM a, LATERAL FLATTEN(input => OPENROUTESERVICE_APP.CORE.MATRIX(?, C::ARRAY, ?):destinations) f) " +
            "SELECT c.POI_NAME, c.ADDRESS, c.LONGITUDE, c.LATITUDE, c.TIER, c.BASIC_CATEGORY " +
            "FROM cand c JOIN snap s ON s.IDX = c.RN - 1 " +
            "WHERE s.SD IS NOT NULL AND s.SD <= 350 ORDER BY c.RN LIMIT 8",
        binds: [region, region, region, usedProfile, region]
    });
    var siteRes = siteStmt.execute();
    var vroomJobs = [];
    var jobDetails = [];
    var jobId = 1;
    while (siteRes.next()) {
        var name = siteRes.getColumnValue(1);
        var address = siteRes.getColumnValue(2);
        var lon = siteRes.getColumnValue(3);
        var lat = siteRes.getColumnValue(4);
        var tier = siteRes.getColumnValue(5);
        var category = siteRes.getColumnValue(6);
        var tierLbl = TIER_LABELS[tier] || ('Tier ' + tier);
        vroomJobs.push({ id: jobId, location: [lon, lat], amount: [1], skills: [tier],
                         description: name + ' - ' + tierLbl });
        jobDetails.push({ job_id: jobId, site: name, name: name, address: address,
                          longitude: lon, latitude: lat, skill: tier, skill_label: tierLbl,
                          category: category });
        jobId++;
    }
    if (vroomJobs.length === 0 || depotLon === null) {
        return { error: 'No routable POI coverage for region ' + region + '. The analytic layer (CATCHMENT.POIS) has no road-network-routable places for this region.',
                 status: 'FAILED', region: region,
                 requested_profile: PROFILE, used_profile: usedProfile,
                 profile_substituted: profSubstituted, profile_note: profNote };
    }

    var vehicles = [
        { id: 1, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [vroomJobs.length], skills: [1],
          description: 'Tier 1 vehicle (priority handling)' },
        { id: 2, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [vroomJobs.length], skills: [2],
          description: 'Tier 2 vehicle (restricted handling)' },
        { id: 3, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [vroomJobs.length], skills: [3],
          description: 'Tier 3 vehicle (standard handling)' }
    ];

    var vroomPayload = JSON.stringify({ jobs: vroomJobs, vehicles: vehicles });
    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, region] });
    var optRes = optStmt.execute();
    if (!optRes.next()) {
        // Zero rows here usually means the region's VROOM/ORS engine is suspended
        // or cold-starting (a suspended engine makes the gateway return an
        // empty/error body). Surface a typed reason so the chat layer resumes it
        // and shows a friendly notice instead of a blank plan.
        return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
                 vroom_service: 'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_' + String(region || 'SanFrancisco').toUpperCase().replace(/[^A-Z0-9_]/g, ''),
                 error: 'Route optimization service for ' + region + ' is not responding (it may be suspended or starting) or returned no routable result. Resume it and retry.',
                 jobs: jobDetails, requested_profile: PROFILE, used_profile: usedProfile,
                 profile_substituted: profSubstituted, profile_note: profNote };
    }
    var rawResp = optRes.getColumnValue(1);
    var response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
    var geojsonRaw = optRes.getColumnValue(2);
    var geojson = geojsonRaw ? ((typeof geojsonRaw === 'string') ? JSON.parse(geojsonRaw) : geojsonRaw) : null;

    var vroomRoutes = response.routes || [];
    var routesWithGeometry = [];
    for (var r = 0; r < vroomRoutes.length; r++) {
        var route = vroomRoutes[r];
        routesWithGeometry.push({
            vehicle: route.vehicle, cost: route.cost,
            duration: route.duration, distance: route.distance,
            steps: route.steps || [], geometry: route.geometry || []
        });
    }
    var tier1 = jobDetails.filter(function(j) { return j.skill === 1; });
    var tier2 = jobDetails.filter(function(j) { return j.skill === 2; });
    var tier3 = jobDetails.filter(function(j) { return j.skill === 3; });

    // Neutral demand signal: regional POI + address coverage (best-effort).
    var totalPois = null, addressCount = null;
    try { totalPois = execScalar("SELECT COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION = ?", [region]); } catch(e) {}
    try { addressCount = execScalar("SELECT COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES WHERE REGION = ?", [region]); } catch(e) {}

    return {
        status: 'SUCCESS', num_vehicles: 3,
        total_jobs: vroomJobs.length, sites_served: jobDetails.length, region: region,
        requested_profile: PROFILE, used_profile: usedProfile,
        profile_substituted: profSubstituted, profile_note: profNote,
        jobs: jobDetails, vehicles: vehicles,
        routes: routesWithGeometry, unassigned: response.unassigned || [],
        depot: { longitude: depotLon, latitude: depotLat, name: depotName },
        geometry: geojson,
        tier_summary: {
            tier_1_stops: tier1.length,
            tier_2_stops: tier2.length,
            tier_3_stops: tier3.length
        },
        demand_basis: {
            region: region,
            total_pois: totalPois,
            address_count: addressCount
        }
    };
} catch(err) {
    var _m = err && err.message ? err.message : String(err);
    if (/failed to resolve|nameresolutionerror|max retries exceeded|name or service not known|matrix pre-?compute failed|matrix_precompute_failed|service_unreachable|connection refused|optimization_unavailable/i.test(_m)) {
        return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
                 vroom_service: 'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_' + String(region || 'SanFrancisco').toUpperCase().replace(/[^A-Z0-9_]/g, ''),
                 error: 'Route optimization service for ' + region + ' is not responding (' + _m + '). Resume it and retry.' };
    }
    return { error: _m, status: 'FAILED' };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_NETWORK_OPTIMIZATION(VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_DELIVERY_OPTIMIZATION: Region-scoped, domain-neutral delivery plan.
-- Sources ~30 delivery stops live from the active region's Overture POIs
-- (CATCHMENT.POIS, BOUNDARY-constrained + routable-filtered), assigns a neutral
-- handling tier per stop from its category, computes the depot as the POI
-- centroid, and runs a 3-vehicle VROOM solve. Active region from CATCHMENT.CONFIG.
-- No static demo tables.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DELIVERY_OPTIMIZATION(
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
// Neutral handling-tier labels derived from a POI's category (no industry terms).
var TIER_LABELS = { 1: 'Tier 1 - Priority', 2: 'Tier 2 - Restricted', 3: 'Tier 3 - Standard' };
function execScalarPair(sqlText, binds) {
    var st = snowflake.createStatement({ sqlText: sqlText, binds: binds || [] });
    var rs = st.execute();
    return rs.next() ? [rs.getColumnValue(1), rs.getColumnValue(2)] : null;
}
function resolveActiveRegion() {
    // Active region from the neutral catchment config; fall back to the active
    // dataset, then the provisioned default. No hardcoded coords anywhere.
    var sqls = [
        "SELECT REGION FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1",
        "SELECT REGION FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE LIMIT 1"
    ];
    for (var i = 0; i < sqls.length; i++) {
        try {
            var rs = snowflake.createStatement({ sqlText: sqls[i] }).execute();
            if (rs.next()) { var r = rs.getColumnValue(1); if (r) return r; }
        } catch(e) { /* try next */ }
    }
    return 'SanFrancisco';
}
function resolveProfileFor(profile, region) {
    // Best-effort: resolve the requested profile against the profiles actually
    // built in the region. ORS_STATUS failure -> [] -> rename-only behavior.
    var available = [];
    try {
        var avRs = snowflake.createStatement({
            sqlText: "SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(?):profiles)", binds: [region]
        }).execute();
        if (avRs.next()) { var a = avRs.getColumnValue(1); available = a ? ((typeof a === 'string') ? JSON.parse(a) : a) : []; }
    } catch(e) { available = []; }
    var res = {};
    try {
        var prRs = snowflake.createStatement({
            sqlText: "SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(?, PARSE_JSON(?)::ARRAY)",
            binds: [profile, JSON.stringify(available)]
        }).execute();
        if (prRs.next()) { var p = prRs.getColumnValue(1); res = p ? ((typeof p === 'string') ? JSON.parse(p) : p) : {}; }
    } catch(e) { res = {}; }
    return res;
}
try {
    var region = resolveActiveRegion();

    var profRes = resolveProfileFor(PROFILE, region);
    var usedProfile = profRes.used || 'driving-car';
    var profSubstituted = (profRes.substituted === undefined) ? null : profRes.substituted;
    var profNote = (profRes.note === undefined) ? null : profRes.note;

    // Depot = centroid of the region's POIs (region-agnostic; no static depot).
    var depotLon = null, depotLat = null;
    try {
        var dRs = snowflake.createStatement({
            sqlText: "SELECT AVG(LONGITUDE) LO, AVG(LATITUDE) LA FROM FLEET_INTELLIGENCE.CATCHMENT.POIS WHERE REGION = ?",
            binds: [region] }).execute();
        if (dRs.next()) {
            var lo = Number(dRs.getColumnValue("LO")); var la = Number(dRs.getColumnValue("LA"));
            if (!isNaN(lo) && !isNaN(la)) { depotLon = lo; depotLat = la; }
        }
    } catch(e) { /* depot stays null -> caught by guard */ }
    var depotName = region + ' Distribution Hub';

    // Delivery stops = deterministic top-N live POIs for the active region that
    // SNAP to the road network. A single off-network point makes VROOM abort the
    // whole solve, so the routable filter (MATRIX snapped_distance <= 350m) runs
    // in SQL: candidates -> MATRIX destinations -> FLATTEN -> keep snappable.
    var jobsStmt = snowflake.createStatement({
        sqlText:
            "WITH cand AS (" +
            "  SELECT p.POI_NAME, p.ADDRESS, p.LONGITUDE, p.LATITUDE, " +
            "         MOD(ABS(HASH(p.BASIC_CATEGORY)),3)+1 AS TIER, p.BASIC_CATEGORY, " +
            "         ROW_NUMBER() OVER (ORDER BY p.POI_ID) AS RN " +
            "  FROM FLEET_INTELLIGENCE.CATCHMENT.POIS p " +
            "  JOIN OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc ON rc.BOUNDARY IS NOT NULL " +
            "    AND (UPPER(rc.LOOKUP_NAME)=UPPER(?) OR UPPER(rc.REGION_KEY)=UPPER(?)) " +
            "  WHERE p.REGION = ? AND p.LONGITUDE IS NOT NULL AND p.LATITUDE IS NOT NULL " +
            "    AND ST_WITHIN(p.GEOMETRY, rc.BOUNDARY) " +
            "  ORDER BY p.POI_ID LIMIT 80), " +
            "a AS (SELECT ARRAY_AGG(ARRAY_CONSTRUCT(LONGITUDE,LATITUDE)) WITHIN GROUP (ORDER BY RN) AS C FROM cand), " +
            "snap AS (SELECT f.INDEX AS IDX, f.VALUE:snapped_distance::FLOAT AS SD " +
            "         FROM a, LATERAL FLATTEN(input => OPENROUTESERVICE_APP.CORE.MATRIX(?, C::ARRAY, ?):destinations) f) " +
            "SELECT c.POI_NAME, c.ADDRESS, c.LONGITUDE, c.LATITUDE, c.TIER, c.BASIC_CATEGORY " +
            "FROM cand c JOIN snap s ON s.IDX = c.RN - 1 " +
            "WHERE s.SD IS NOT NULL AND s.SD <= 350 ORDER BY c.RN LIMIT 30",
        binds: [region, region, region, usedProfile, region]
    });
    var jobsRes = jobsStmt.execute();
    var vroomJobs = [];
    var jobMeta = [];
    var jid = 1;
    while (jobsRes.next()) {
        var name = jobsRes.getColumnValue(1);
        var address = jobsRes.getColumnValue(2);
        var lon = jobsRes.getColumnValue(3);
        var lat = jobsRes.getColumnValue(4);
        var tier = jobsRes.getColumnValue(5);
        var category = jobsRes.getColumnValue(6);
        var tierLbl = TIER_LABELS[tier] || ('Tier ' + tier);
        vroomJobs.push({ id: jid, location: [lon, lat], amount: [1], skills: [tier], description: name });
        jobMeta.push({ name: name, address: address, longitude: lon, latitude: lat, skill: tier, skill_label: tierLbl, category: category });
        jid++;
    }
    if (vroomJobs.length === 0 || depotLon === null) {
        return { error: 'No routable POI coverage for region ' + region + '. The analytic layer (CATCHMENT.POIS) has no road-network-routable places for this region.',
                 status: 'FAILED', region: region,
                 requested_profile: PROFILE, used_profile: usedProfile,
                 profile_substituted: profSubstituted, profile_note: profNote };
    }
    var cap = vroomJobs.length;
    var vehicles = [
        { id: 1, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [cap], skills: [1],
          description: 'Tier 1 vehicle (priority handling)' },
        { id: 2, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [cap], skills: [2],
          description: 'Tier 2 vehicle (restricted handling)' },
        { id: 3, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [cap], skills: [3],
          description: 'Tier 3 vehicle (standard handling)' }
    ];
    var vroomPayload = JSON.stringify({ jobs: vroomJobs, vehicles: vehicles });
    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, region] });
    var optRes = optStmt.execute();
    if (!optRes.next()) {
        // Suspended/cold engine returns an empty/error body -> typed reason so
        // the chat layer resumes it and shows a friendly notice.
        return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
                 vroom_service: 'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_' + String(region || 'SanFrancisco').toUpperCase().replace(/[^A-Z0-9_]/g, ''),
                 error: 'Route optimization service for ' + region + ' is not responding (it may be suspended or starting) or returned no routable result. Resume it and retry.',
                 requested_profile: PROFILE, used_profile: usedProfile,
                 profile_substituted: profSubstituted, profile_note: profNote };
    }
    var rawResp = optRes.getColumnValue(1);
    var response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
    var geojsonRaw = optRes.getColumnValue(2);
    var geojson = geojsonRaw ? ((typeof geojsonRaw === 'string') ? JSON.parse(geojsonRaw) : geojsonRaw) : null;
    return {
        status: 'SUCCESS', num_vehicles: 3, region: region,
        requested_profile: PROFILE, used_profile: usedProfile,
        profile_substituted: profSubstituted, profile_note: profNote,
        jobs: jobMeta, vehicles: vehicles,
        routes: response.routes || [], unassigned: response.unassigned || [],
        summary: response.summary || {},
        depot: { longitude: depotLon, latitude: depotLat, name: depotName },
        geometry: geojson
    };
} catch(err) {
    var _m = err && err.message ? err.message : String(err);
    if (/failed to resolve|nameresolutionerror|max retries exceeded|name or service not known|matrix pre-?compute failed|matrix_precompute_failed|service_unreachable|connection refused|optimization_unavailable/i.test(_m)) {
        return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
                 vroom_service: 'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_' + String(region || 'SanFrancisco').toUpperCase().replace(/[^A-Z0-9_]/g, ''),
                 error: 'Route optimization service for ' + region + ' is not responding (' + _m + '). Resume it and retry.' };
    }
    return { error: _m, status: 'FAILED' };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DELIVERY_OPTIMIZATION(VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_CATCHMENT: Area profile within a drive-time catchment of a site.
-- Geocodes the site, draws the drive-time isochrone, then profiles the live
-- Overture POIs (CATCHMENT.POIS) and addresses (CATCHMENT.REGIONAL_ADDRESSES)
-- within it - a neutral activity/coverage signal (no demographics). Active
-- region from CATCHMENT.CONFIG.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_CATCHMENT(
    SITE_DESCRIPTION VARCHAR,
    RANGE_MINUTES    FLOAT DEFAULT 10,
    PROFILE          VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
function execScalar(sqlText, binds) {
    var rs = snowflake.createStatement({ sqlText: sqlText, binds: binds || [] }).execute();
    return rs.next() ? rs.getColumnValue(1) : null;
}
function resolveActiveRegion() {
    var sqls = [
        "SELECT REGION FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1",
        "SELECT REGION FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE LIMIT 1"
    ];
    for (var i = 0; i < sqls.length; i++) {
        try { var v = execScalar(sqls[i]); if (v) return v; } catch(e) { /* next */ }
    }
    return 'SanFrancisco';
}
function resolveProfileFor(profile, region) {
    var available = [];
    try {
        var a = execScalar("SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(?):profiles)", [region]);
        available = a ? ((typeof a === 'string') ? JSON.parse(a) : a) : [];
    } catch(e) { available = []; }
    var res = {};
    try {
        var p = execScalar("SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(?, PARSE_JSON(?)::ARRAY)",
                           [profile, JSON.stringify(available)]);
        res = p ? ((typeof p === 'string') ? JSON.parse(p) : p) : {};
    } catch(e) { res = {}; }
    return res;
}
try {
    var region = resolveActiveRegion();

    var profRes = resolveProfileFor(PROFILE, region);
    var usedProfile = profRes.used || 'driving-car';
    var profSubstituted = (profRes.substituted === undefined) ? null : profRes.substituted;
    var profNote = (profRes.note === undefined) ? null : profRes.note;

    var geoPrompt = 'Return ONLY a JSON object with the latitude and longitude of this location'
        + (region ? (' in ' + region) : '') + '. Location: ';
    var geocodeSQL = "SELECT AI_COMPLETE(" +
        "'claude-sonnet-4-5'," +
        "CONCAT(?, ?)," +
        "{'temperature': 0, 'max_tokens': 100}," +
        "{'type': 'json', 'schema': {'type': 'object', 'properties': {" +
            "'latitude': {'type': 'number'}, 'longitude': {'type': 'number'}, 'name': {'type': 'string'}" +
        "}, 'required': ['latitude', 'longitude', 'name']}}" +
        ") AS result";
    var geocodeStmt = snowflake.createStatement({ sqlText: geocodeSQL, binds: [geoPrompt, SITE_DESCRIPTION] });
    var geocodeRes = geocodeStmt.execute();
    geocodeRes.next();
    var rawGeo = geocodeRes.getColumnValue(1);
    var loc = (typeof rawGeo === 'string') ? JSON.parse(rawGeo) : rawGeo;
    if (!loc || !loc.latitude || !loc.longitude) {
        return { error: 'Could not geocode site location', status: 'FAILED',
                 requested_profile: PROFILE, used_profile: usedProfile,
                 profile_substituted: profSubstituted, profile_note: profNote };
    }
    var isoSQL = "SELECT ST_ASGEOJSON(d.GEOJSON) AS GEOJSON_STR, " +
                 "d.RESPONSE:features[0]:properties:area::FLOAT AS AREA_M2 " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(?, ?, ?, ?::NUMBER, ?)) d LIMIT 1";
    var isoStmt = snowflake.createStatement({
        sqlText: isoSQL,
        binds: [usedProfile, loc.longitude, loc.latitude, RANGE_MINUTES, region]
    });
    var isoRes = isoStmt.execute();
    if (!isoRes.next()) {
        // A suspended/cold regional ORS returns no isochrone -> typed reason so
        // the chat layer resumes it and shows a friendly notice.
        return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
                 ors_service: 'OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' + String(region || 'SanFrancisco').toUpperCase().replace(/[^A-Z0-9_]/g, ''),
                 error: 'The routing engine for ' + region + ' is not responding (it may be suspended or starting). Resume it and retry.',
                 requested_profile: PROFILE, used_profile: usedProfile,
                 profile_substituted: profSubstituted, profile_note: profNote };
    }
    var isoGeoRaw = isoRes.getColumnValue(1);
    var areaM2 = isoRes.getColumnValue(2) || 0;
    var areaKm2 = Math.round(areaM2 / 1000000 * 100) / 100;
    var isoGeojson = isoGeoRaw ? ((typeof isoGeoRaw === 'string') ? JSON.parse(isoGeoRaw) : isoGeoRaw) : null;
    if (!isoGeojson) {
        return { error: 'Isochrone geometry is null', status: 'FAILED',
                 requested_profile: PROFILE, used_profile: usedProfile,
                 profile_substituted: profSubstituted, profile_note: profNote };
    }
    var isoGeojsonStr = JSON.stringify(isoGeojson).replace(/'/g, "''");

    // Profile the catchment from live Overture data: sample reachable POIs (for
    // the map) + count POIs/addresses within the isochrone (neutral activity
    // proxy; no demographics). Region-scoped, domain-neutral by construction.
    var poiStmt = snowflake.createStatement({
        sqlText: "SELECT POI_NAME, BASIC_CATEGORY, LONGITUDE, LATITUDE " +
                 "FROM FLEET_INTELLIGENCE.CATCHMENT.POIS " +
                 "WHERE REGION = ? AND ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('" + isoGeojsonStr + "')) " +
                 "ORDER BY POI_ID LIMIT 200",
        binds: [region]
    });
    var poiRes = poiStmt.execute();
    var populationPoints = [];
    while (poiRes.next()) {
        populationPoints.push({
            name: poiRes.getColumnValue(1),
            category: poiRes.getColumnValue(2),
            longitude: poiRes.getColumnValue(3),
            latitude: poiRes.getColumnValue(4)
        });
    }

    // Accurate totals + top categories over ALL POIs in the catchment.
    var poisInCatchment = 0, addressesInCatchment = null;
    try {
        poisInCatchment = execScalar(
            "SELECT COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.POIS " +
            "WHERE REGION = ? AND ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('" + isoGeojsonStr + "'))", [region]) || 0;
    } catch(e) { poisInCatchment = populationPoints.length; }
    try {
        addressesInCatchment = execScalar(
            "SELECT COUNT(*) FROM FLEET_INTELLIGENCE.CATCHMENT.REGIONAL_ADDRESSES " +
            "WHERE REGION = ? AND ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('" + isoGeojsonStr + "'))", [region]);
    } catch(e) { addressesInCatchment = null; }

    var topCategories = [];
    try {
        var catStmt = snowflake.createStatement({
            sqlText: "SELECT BASIC_CATEGORY, COUNT(*) C FROM FLEET_INTELLIGENCE.CATCHMENT.POIS " +
                     "WHERE REGION = ? AND ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('" + isoGeojsonStr + "')) " +
                     "GROUP BY BASIC_CATEGORY ORDER BY C DESC LIMIT 8",
            binds: [region]
        });
        var catRes = catStmt.execute();
        while (catRes.next()) {
            topCategories.push({ category: catRes.getColumnValue(1), count: catRes.getColumnValue(2) });
        }
    } catch(e) { /* leave empty */ }

    if (populationPoints.length === 0) {
        return {
            status: 'SUCCESS', region: region,
            site: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
            center: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
            range_minutes: RANGE_MINUTES, geometry: isoGeojson, area_km2: areaKm2,
            requested_profile: PROFILE, used_profile: usedProfile,
            profile_substituted: profSubstituted, profile_note: profNote,
            message: 'No POIs found within the catchment. Try increasing range_minutes.',
            population_points: [], summary: { pois_in_catchment: 0, addresses_in_catchment: addressesInCatchment, top_categories: [], area_km2: areaKm2 }
        };
    }
    return {
        status: 'SUCCESS', region: region,
        site: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
        center: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
        range_minutes: RANGE_MINUTES, geometry: isoGeojson,
        area_km2: Math.round(areaKm2 * 100) / 100,
        requested_profile: PROFILE, used_profile: usedProfile,
        profile_substituted: profSubstituted, profile_note: profNote,
        population_points: populationPoints,
        summary: {
            pois_in_catchment: poisInCatchment,
            pois_shown: populationPoints.length,
            addresses_in_catchment: addressesInCatchment,
            top_categories: topCategories,
            area_km2: Math.round(areaKm2 * 100) / 100
        }
    };
} catch(err) {
    var _m = err && err.message ? err.message : String(err);
    if (/failed to resolve|nameresolutionerror|max retries exceeded|name or service not known|matrix pre-?compute failed|matrix_precompute_failed|service_unreachable|connection refused|optimization_unavailable/i.test(_m)) {
        return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
                 ors_service: 'OPENROUTESERVICE_APP.CORE.ORS_SERVICE_' + String(region || 'SanFrancisco').toUpperCase().replace(/[^A-Z0-9_]/g, ''),
                 error: 'The routing engine for ' + region + ' is not responding (' + _m + '). Resume it and retry.' };
    }
    return { error: _m, status: 'FAILED' };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_CATCHMENT(VARCHAR, FLOAT, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_EVAC_SEED: region-generic Emergency Response participant seeder.
-- Builds the drive-time isochrone UNION over the active region's health-anchor
-- care centers (FLEET_APP.EMERGENCY_RESPONSE.VW_CARE_CENTERS), then FILTERS the
-- raw 50km Overture-address sample generated by Data Studio
-- (FLEET_APP.EMERGENCY_RESPONSE.VW_PARTICIPANTS / DIM_PARTICIPANTS) to those that
-- fall inside the union, keeps only road-network-routable points (MATRIX
-- snapped_distance <= 350m - one off-network point aborts the VROOM solve), and
-- tags each with the county FEMA risk for the chosen hazard (FACT_HAZARD_ZONES
-- point-in-county). No CA/CO/PA lock, no ZIP share, no CSV.
-- Returns { union_geojson, participants[], region }.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_EVAC_SEED(
    REGION VARCHAR DEFAULT NULL,
    HAZARD_TYPE VARCHAR DEFAULT 'WILDFIRE',
    RANGE_MINUTES FLOAT DEFAULT 15,
    TARGET_COUNT FLOAT DEFAULT 60
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
function resolveActiveRegion() {
    if (REGION) return REGION;
    var sqls = [
        "SELECT REGION FROM FLEET_INTELLIGENCE.CATCHMENT.CONFIG LIMIT 1",
        "SELECT REGION FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE LIMIT 1"
    ];
    for (var i = 0; i < sqls.length; i++) {
        try { var rs = snowflake.createStatement({ sqlText: sqls[i] }).execute();
              if (rs.next()) { var r = rs.getColumnValue(1); if (r) return r; } } catch(e) {}
    }
    return 'SanFrancisco';
}
try {
    var region = resolveActiveRegion();
    var hz = String(HAZARD_TYPE || 'WILDFIRE').toUpperCase();
    if (hz !== 'WILDFIRE' && hz !== 'FLOOD' && hz !== 'COMPOSITE') hz = 'WILDFIRE';
    var mins = Math.max(1, Math.min(60, Math.floor(Number(RANGE_MINUTES) || 15)));
    var target = Math.max(1, Math.min(500, Math.floor(Number(TARGET_COUNT) || 60)));

    // Profile follows the active dataset's vehicle_type (ebike->cycling, hgv->
    // driving-hgv, ...) via RESOLVE_PROFILE, which canonicalizes the vehicle_type
    // and falls back to a built profile when the requested graph is not available
    // (e.g. only driving-car is built today, so ebike -> driving-car until the
    // cycling graph is built). Returns an OBJECT; we want .used.
    var profile = 'driving-car';
    try {
        var prs = snowflake.createStatement({ sqlText:
          "SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(" +
          "  (SELECT VEHICLE_TYPE FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE LIMIT 1)," +
          "  (SELECT ARRAY_AGG(f.KEY) FROM LATERAL FLATTEN(input => OPENROUTESERVICE_APP.CORE.ORS_STATUS(?):profiles) f)" +
          "):used::STRING", binds: [region] }).execute();
        if (prs.next()) { var p = prs.getColumnValue(1); if (p) profile = p; }
    } catch(eProf) { profile = 'driving-car'; }

    // Step 1: materialize the per-center isochrones into a temp table, fetched in
    // BATCHES via the multi-location ISOCHRONES endpoint (_ISOCHRONES_RAW takes a
    // locations array; engine + gateway caps are >= CHUNK after the v2 limit bump
    // to 50). 10 centers -> 1 call instead of 10.
    // Rationale (measured): a single ORS instance on a small node is slow/unstable
    // per request (~14s under load); minimizing round-trips keeps the whole seed
    // well under the app's 80s statement timeout + 90s SPCS ingress. Each batch is
    // in try/catch so a failed batch is skipped, not fatal. Also avoids the ~140s
    // spherical ST_UNION_AGG entirely (membership = inside ANY isochrone, Step 2).
    snowflake.execute({ sqlText:
      "CREATE OR REPLACE TEMPORARY TABLE FLEET_INTELLIGENCE.ROUTING_TOOLS.TMP_EVAC_ISO (g GEOGRAPHY)" });
    var crs = snowflake.createStatement({ sqlText:
      "SELECT LON, LAT FROM TABLE(FLEET_APP.EMERGENCY_RESPONSE.F_VW_CARE_CENTERS_SCOPED(?, CAST(NULL AS VARCHAR))) " +
      "WHERE LON IS NOT NULL AND LAT IS NOT NULL LIMIT 25", binds: [region] }).execute();
    var centers = [];
    while (crs.next()) { centers.push([crs.getColumnValue(1), crs.getColumnValue(2)]); }
    var CHUNK = 10; // locations per isochrone call; must be <= the region's isochrones_maximum_locations (default 50)
    var insSql =
      "INSERT INTO FLEET_INTELLIGENCE.ROUTING_TOOLS.TMP_EVAC_ISO " +
      "SELECT TO_GEOGRAPHY(f.value:geometry) " +
      "FROM TABLE(FLATTEN(input => OPENROUTESERVICE_APP.CORE._ISOCHRONES_RAW('" + profile + "', " +
      "  OBJECT_CONSTRUCT('locations', PARSE_JSON(?), 'range', ARRAY_CONSTRUCT(" + (mins * 60) + "), 'range_type', 'time'), ?):features)) f " +
      "WHERE f.value:geometry IS NOT NULL AND ST_NPOINTS(TO_GEOGRAPHY(f.value:geometry)) > 0";
    // Insert one batch; fall back to per-center calls when the batch yields NO
    // rows. An over-cap request does NOT throw -- _ISOCHRONES_RAW returns HTTP 200
    // with an embedded {error:{code:3004,...}} and features=NULL, so FLATTEN(NULL)
    // inserts 0 rows silently. Therefore the fallback must trigger on a 0-row
    // insert (not just a thrown exception), which also covers a region whose
    // effective isochrones_maximum_locations was lowered below CHUNK via the
    // Routing Limits panel. Returns the number of rows actually inserted.
    function insertBatch(batch) {
        try { var st = snowflake.createStatement({ sqlText: insSql,
                  binds: [JSON.stringify(batch), region] });
              st.execute(); return st.getNumRowsInserted(); }
        catch(eIso) { return 0; }
    }
    for (var start = 0; start < centers.length; start += CHUNK) {
        var batch = centers.slice(start, start + CHUNK);
        if (insertBatch(batch) === 0 && batch.length > 1) {
            for (var k = 0; k < batch.length; k++) { insertBatch([batch[k]]); }
        }
    }
    var nrs = snowflake.createStatement({ sqlText:
      "SELECT COUNT(*) FROM FLEET_INTELLIGENCE.ROUTING_TOOLS.TMP_EVAC_ISO" }).execute();
    nrs.next();
    var nIso = Number(nrs.getColumnValue(1) || 0);
    if (nIso === 0) {
        return { status: 'FAILED', region: region,
                 error: 'No care-center isochrone coverage for region ' + region +
                        ' (the routing engine may be warming up, or no care centers exist). ' +
                        'Generate Emergency Response data (hazard + anchors + participants) in Data Studio and ensure ORS is running, then retry.' };
    }

    // Step 2: filter the raw participant sample to those inside ANY isochrone
    // (JOIN + DISTINCT), then tag each participant with BOTH the wildfire and flood
    // risk of the hazard zone it sits in (spatial join) so the UI can recolor dots
    // to match the hexagon layer when the hazard toggle flips -- without re-seeding.
    // The map "reachable area" is a TRUE dissolve: ST_UNION_AGG over simplified
    // isochrones (measured ~sub-second for 10 polygons) -> one clean union outline
    // instead of overlapping per-center polygons.
    // No live MATRIX snap: participants are real Overture residential-building
    // points (already on-network), the snap was a fragile extra ORS call that
    // over-filtered to zero, and evac_solve snaps/validates routability anyway.
    var sql =
      "WITH iso AS (SELECT g FROM FLEET_INTELLIGENCE.ROUTING_TOOLS.TMP_EVAC_ISO)," +
      " raw AS (SELECT PARTICIPANT_ID, LON, LAT, LOC AS PT, ADDRESS " +
      "    FROM TABLE(FLEET_APP.EMERGENCY_RESPONSE.F_VW_PARTICIPANTS_SCOPED(?, CAST(NULL AS VARCHAR))) " +
      "    WHERE LOC IS NOT NULL AND LON IS NOT NULL AND LAT IS NOT NULL)," +
      " inside AS (SELECT DISTINCT r.PARTICIPANT_ID, r.LON, r.LAT, r.PT, r.ADDRESS " +
      "    FROM raw r JOIN iso i ON ST_WITHIN(r.PT, i.g))," +
      " samp AS (SELECT PARTICIPANT_ID, LON, LAT, PT, ADDRESS, ROW_NUMBER() OVER (ORDER BY RANDOM()) AS RN FROM inside LIMIT " + target + ")," +
      " risk AS (SELECT COALESCE(s.PARTICIPANT_ID, 'P'||s.RN) AS PID, s.LON, s.LAT, s.ADDRESS, " +
      "    MAX(IFF(h.HAZARD_TYPE='WILDFIRE', h.RISK_LEVEL, NULL))  AS WF_LVL, " +
      "    MAX(IFF(h.HAZARD_TYPE='WILDFIRE', h.RISK_RATING, NULL)) AS WF_LBL, " +
      "    MAX(IFF(h.HAZARD_TYPE='FLOOD',    h.RISK_LEVEL, NULL))  AS FL_LVL, " +
      "    MAX(IFF(h.HAZARD_TYPE='FLOOD',    h.RISK_RATING, NULL)) AS FL_LBL, " +
      "    ANY_VALUE(h.COUNTY) AS CNTY " +
      "    FROM samp s " +
      "    LEFT JOIN SYNTHETIC_DATASETS.UNIFIED.V_FACT_HAZARD_ZONES_CURRENT h " +
      "      ON h.REGION = ? AND h.HAZARD_TYPE IN ('WILDFIRE','FLOOD') AND ST_WITHIN(s.PT, h.GEOM) " +
      "    GROUP BY 1, 2, 3, 4) " +
      "SELECT (SELECT ST_ASGEOJSON(ST_UNION_AGG(ST_SIMPLIFY(g, 150)))::STRING FROM iso) AS UNION_GEOJSON, " +
      "  (SELECT ARRAY_AGG(OBJECT_CONSTRUCT('pid',PID::STRING,'lon',LON,'lat',LAT,'address',ADDRESS::STRING," +
      "     'county',CNTY::STRING,'wf_lvl',COALESCE(WF_LVL,0),'wf_lbl',COALESCE(WF_LBL,'No Rating')," +
      "     'fl_lvl',COALESCE(FL_LVL,0),'fl_lbl',COALESCE(FL_LBL,'No Rating'))) FROM risk) AS PARTICIPANTS";
    var rs = snowflake.createStatement({ sqlText: sql, binds: [region, region] }).execute();
    rs.next();
    var ug = rs.getColumnValue(1);
    var parts = rs.getColumnValue(2);
    parts = parts ? ((typeof parts === 'string') ? JSON.parse(parts) : parts) : [];

    if (!parts || parts.length === 0) {
        // Distinguish "no participant data exists for this region" (needs a Data
        // Studio run) from "data exists but none fall inside the isochrone"
        // (needs more travel time) so the message is actionable.
        var rawN = 0;
        try {
            var rc = snowflake.createStatement({ sqlText:
              "SELECT COUNT(*) FROM TABLE(FLEET_APP.EMERGENCY_RESPONSE.F_VW_PARTICIPANTS_SCOPED(?, CAST(NULL AS VARCHAR)))",
              binds: [region] }).execute();
            rc.next();
            rawN = Number(rc.getColumnValue(1) || 0);
        } catch(e) { rawN = 0; }
        var emsg = (rawN === 0)
          ? 'No participant data has been generated for region ' + region +
            '. Re-run Emergency Response data generation in Data Studio for this region, then retry.'
          : 'No participants fall inside the ' + mins + '-min isochrone area. ' +
            'Increase travel time, or regenerate Data Studio data with participants closer to the care centers.';
        return { status: 'FAILED', region: region, hazard_type: hz, range_minutes: mins,
                 union_geojson: ug ? ((typeof ug==='string')?JSON.parse(ug):ug) : null,
                 participants: [], isochrone_count: nIso, raw_participant_count: rawN,
                 error: emsg };
    }
    return {
        status: 'SUCCESS', region: region, hazard_type: hz, range_minutes: mins,
        profile: profile, isochrone_count: nIso,
        union_geojson: ug ? ((typeof ug === 'string') ? JSON.parse(ug) : ug) : null,
        participants: parts, participant_count: parts.length
    };
} catch(err) {
    return { status: 'FAILED', error: err.message };
}
$$;
ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_EVAC_SEED(VARCHAR, VARCHAR, FLOAT, FLOAT) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_EVAC_SOLVE: thin owner's-rights wrapper over ORS OPTIMIZATION for the
-- evacuation VRP. The multi-depot / multi-trip pickup challenge is built
-- client-side (each van -> up to maxTrips virtual vehicles, each participant a
-- pickup:[1] job) and passed as JSON. Returns the routes + geometry.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_EVAC_SOLVE(
    CHALLENGE VARCHAR,
    REGION VARCHAR DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
try {
    var region = REGION;
    if (!region) {
        try { var rr = snowflake.createStatement({
            sqlText: "SELECT REGION FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE LIMIT 1" }).execute();
            if (rr.next()) region = rr.getColumnValue(1); } catch(e) {}
        if (!region) region = 'SanFrancisco';
    }
    // Fully-qualified per-region VROOM service (naming: VROOM_SERVICE_<UPPER key>,
    // spaces/punctuation stripped, e.g. SanFrancisco -> VROOM_SERVICE_SANFRANCISCO).
    // Returned in the FAILED payload so the wizard can resume the right service
    // without re-deriving the name client-side.
    var vroomSvc = 'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_' +
                   String(region).toUpperCase().replace(/[^A-Z0-9_]/g, '');
    // OPTIMIZATION flattens resp:routes -> one row per vehicle, each with that
    // vehicle's GEOJSON LineString. RESPONSE (full VROOM JSON: routes/unassigned/
    // summary) is identical on every row. Aggregate ALL per-vehicle geometries
    // into one FeatureCollection (tagged with the vehicle id) so the UI draws
    // every trip's route -- the old LIMIT 1 dropped all but the first vehicle.
    var sql = "SELECT o.VEHICLE AS VID, o.RESPONSE AS RESP, ST_ASGEOJSON(o.GEOJSON) AS GJ " +
              "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o";
    var rs = snowflake.createStatement({ sqlText: sql, binds: [CHALLENGE, region] }).execute();
    var response = null;
    var features = [];
    var rowCount = 0;
    while (rs.next()) {
        rowCount++;
        if (response === null) {
            var rawResp = rs.getColumnValue(2);
            response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
        }
        var vid = rs.getColumnValue(1);
        var gj = rs.getColumnValue(3);
        if (gj) {
            var geom = (typeof gj === 'string') ? JSON.parse(gj) : gj;
            if (geom) features.push({ type: 'Feature', geometry: geom, properties: { vehicle: vid } });
        }
    }
    if (rowCount === 0) {
        // Zero rows almost always means the region's VROOM optimization service
        // is suspended or still cold-starting (a suspended VROOM makes the gateway
        // return an empty/error body). Surface a typed reason + the service name so
        // the wizard can resume it and retry, instead of blaming participant
        // routability. If VROOM is confirmed RUNNING and this still returns 0, the
        // caller re-reports it as a genuine routability failure.
        return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
                 vroom_service: vroomSvc,
                 error: 'Route optimization service for ' + region + ' is not responding (it may be suspended or starting). Resume it and retry.' };
    }
    if (response === null) response = {};
    return {
        status: 'SUCCESS', region: region,
        routes: response.routes || [], unassigned: response.unassigned || [],
        summary: response.summary || {},
        geometry: { type: 'FeatureCollection', features: features }
    };
} catch(err) {
    // A thrown error here (gateway unreachable, service resolution failure) is
    // also almost always a suspended/starting VROOM. Return the same typed reason
    // so the wizard resume+retry path handles it uniformly.
    return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
             vroom_service: vroomSvc,
             error: 'Route optimization service for ' + region + ' is not responding (' +
                    (err && err.message ? err.message : 'unknown error') + '). Resume it and retry.' };
}
$$;
ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_EVAC_SOLVE(VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":1},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_VRP_SOLVE: generic, use-case-agnostic owner's-rights wrapper over
-- OPTIMIZATION. Solves ANY prepared VROOM challenge (vehicles[] + jobs[]/
-- shipments[]) on a region graph and returns routes / unassigned / summary +
-- an aggregated FeatureCollection of every vehicle's route geometry. The caller
-- builds the challenge client-side (backload matching, evacuation, delivery
-- planning, etc.), so this proc names no use case. Body is identical in shape to
-- TOOL_EVAC_SOLVE; kept as a separate generic entry point so audit + agent tool
-- semantics are use-case-neutral.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_VRP_SOLVE(
    CHALLENGE VARCHAR,
    REGION VARCHAR DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
try {
    var region = REGION;
    if (!region) {
        try { var rr = snowflake.createStatement({
            sqlText: "SELECT REGION FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE LIMIT 1" }).execute();
            if (rr.next()) region = rr.getColumnValue(1); } catch(e) {}
        if (!region) region = 'SanFrancisco';
    }
    var vroomSvc = 'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_' +
                   String(region).toUpperCase().replace(/[^A-Z0-9_]/g, '');
    var sql = "SELECT o.VEHICLE AS VID, o.RESPONSE AS RESP, ST_ASGEOJSON(o.GEOJSON) AS GJ " +
              "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o";
    var rs = snowflake.createStatement({ sqlText: sql, binds: [CHALLENGE, region] }).execute();
    var response = null;
    var features = [];
    var rowCount = 0;
    while (rs.next()) {
        rowCount++;
        if (response === null) {
            var rawResp = rs.getColumnValue(2);
            response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
        }
        var vid = rs.getColumnValue(1);
        var gj = rs.getColumnValue(3);
        if (gj) {
            var geom = (typeof gj === 'string') ? JSON.parse(gj) : gj;
            if (geom) features.push({ type: 'Feature', geometry: geom, properties: { vehicle: vid } });
        }
    }
    if (rowCount === 0) {
        return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
                 vroom_service: vroomSvc,
                 error: 'Route optimization service for ' + region + ' is not responding (it may be suspended or starting). Resume it and retry.' };
    }
    if (response === null) response = {};
    return {
        status: 'SUCCESS', region: region,
        routes: response.routes || [], unassigned: response.unassigned || [],
        summary: response.summary || {},
        geometry: { type: 'FeatureCollection', features: features }
    };
} catch(err) {
    return { status: 'FAILED', region: region, reason: 'OPTIMIZATION_UNAVAILABLE',
             vroom_service: vroomSvc,
             error: 'Route optimization service for ' + region + ' is not responding (' +
                    (err && err.message ? err.message : 'unknown error') + '). Resume it and retry.' };
}
$$;
ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_VRP_SOLVE(VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_SAP_INTROSPECT: read-only SAP + telematics table discovery.
-- Live, in-app version of sap-fleet-connector/scripts/introspect_sap.sql. Given
-- a landed SAP database (and optionally a telematics database), scans their
-- INFORMATION_SCHEMA and returns which SAP fleet objects are present, the CDC
-- metadata-column fingerprint, and the candidate telematics device/ts/lat/lon
-- columns - so a user can see which tables can be bound into the FLEET_APP
-- contract. Pure SELECTs (creates nothing). EXECUTE AS OWNER: the proc owner
-- must have USAGE on the scanned databases (the mock demo schema and, for a
-- customer, the co-located SAP/telematics inbound DBs). The DB names are
-- validated as plain identifiers before being inlined (INFORMATION_SCHEMA is
-- per-database and cannot be bound), so there is no SQL-injection surface.
-- Returns { status, sap_objects[], cdc_fingerprint[], telematics_columns[],
--           suggested:{cdc_tool, join_strategy_hint}, next_step }.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_SAP_INTROSPECT(
    P_SAP_DB         VARCHAR,
    P_TELEMATICS_DB  VARCHAR DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
function validIdent(x) {
    return typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/.test(x);
}
function rows(sqlText) {
    var out = [];
    var st = snowflake.createStatement({ sqlText: sqlText });
    var rs = st.execute();
    var n = st.getColumnCount();
    while (rs.next()) {
        var o = {};
        for (var i = 1; i <= n; i++) { o[st.getColumnName(i)] = rs.getColumnValue(i); }
        out.push(o);
    }
    return out;
}
try {
    if (!validIdent(P_SAP_DB)) {
        return { status: 'FAILED',
                 error: 'Invalid SAP database name. Provide a single database identifier (letters, digits, _ , $).' };
    }
    // NOTE: this file is deployed via `snow sql -f`, whose client templating
    // strips one '&' from '&&' (logical AND becomes bitwise AND). That is
    // harmless when both operands are booleans (true & false still yields the
    // right truthiness), but NOT for string/number operands. So every AND below
    // is written with boolean-typed operands only.
    var telDb = null;
    if (P_TELEMATICS_DB !== null && P_TELEMATICS_DB !== undefined && String(P_TELEMATICS_DB).length > 0) {
        telDb = String(P_TELEMATICS_DB);
    }
    if (telDb !== null && !validIdent(telDb)) {
        return { status: 'FAILED',
                 error: 'Invalid telematics database name. Provide a single database identifier or omit it.' };
    }
    var sapDb = P_SAP_DB.replace(/"/g, '');

    // 1. SAP fleet objects present (raw tables OR CDS views).
    var sapObjects = rows(
        "SELECT table_schema AS TABLE_SCHEMA, table_name AS TABLE_NAME, row_count AS ROW_COUNT, bytes AS BYTES, " +
        "CASE WHEN table_name ILIKE 'I/_%' ESCAPE '/' OR table_name ILIKE 'C/_%' ESCAPE '/' THEN 'cds_view' " +
        "     WHEN table_name ILIKE 'Z%' THEN 'custom_cds_or_table' ELSE 'raw_table' END AS EXPOSURE_FORM " +
        "FROM \"" + sapDb + "\".INFORMATION_SCHEMA.TABLES " +
        "WHERE UPPER(table_name) REGEXP '.*(EQUI|IFLOT|IMRG|QMEL|AUFK|AFIH|AFRU|LIKP|LIPS|VBAK|VBAP|MSEG|MKPF|BSEG|/SCMTMS/).*' " +
        "ORDER BY table_schema, table_name");

    // 2. CDC tool fingerprint: which metadata columns exist on the SAP tables?
    var cdc = rows(
        "SELECT table_schema AS TABLE_SCHEMA, table_name AS TABLE_NAME, column_name AS COLUMN_NAME " +
        "FROM \"" + sapDb + "\".INFORMATION_SCHEMA.COLUMNS " +
        "WHERE UPPER(column_name) IN " +
        "('MANDT','HEADER__CHANGE_OPER','HEADER__TIMESTAMP','ODQ_CHANGEMODE','ODQ_ENTITYCNTR'," +
        "'_FIVETRAN_SYNCED','_FIVETRAN_DELETED','LASTCHANGEDATETIME','PSA_CDC_OPERATION') " +
        "AND table_schema <> 'INFORMATION_SCHEMA' " +
        "ORDER BY table_schema, table_name, column_name");

    // 3. Telematics fact shape (only when a telematics DB is supplied).
    var tel = [];
    if (telDb !== null) {
        var telDbClean = telDb.replace(/"/g, '');
        tel = rows(
            "SELECT table_schema AS TABLE_SCHEMA, table_name AS TABLE_NAME, column_name AS COLUMN_NAME, data_type AS DATA_TYPE " +
            "FROM \"" + telDbClean + "\".INFORMATION_SCHEMA.COLUMNS " +
            "WHERE UPPER(column_name) REGEXP '.*(SERIAL|VIN|UNIT|DEVICE|MMSI|IMO|TS|TIME|TIMESTAMP|LAT|LON|LNG|SPEED|HEADING|COURSE|ODOMETER).*' " +
            "AND table_schema <> 'INFORMATION_SCHEMA' " +
            "ORDER BY table_schema, table_name, ordinal_position");
    }

    // Derive a CDC-tool suggestion from the metadata columns found.
    var cols = {};
    for (var i = 0; i < cdc.length; i++) { cols[String(cdc[i].COLUMN_NAME).toUpperCase()] = true; }
    var cdcTool = 'unknown';
    if (cols['HEADER__CHANGE_OPER'] || cols['HEADER__TIMESTAMP']) cdcTool = 'qlik';
    else if (cols['ODQ_CHANGEMODE'] || cols['ODQ_ENTITYCNTR']) cdcTool = 'odp';
    else if (cols['_FIVETRAN_SYNCED'] || cols['_FIVETRAN_DELETED']) cdcTool = 'fivetran';
    else if (cols['LASTCHANGEDATETIME']) cdcTool = 'slt_raw';
    else if (cols['MANDT']) cdcTool = 'slt_raw';

    // Derive a join-strategy hint from what is present.
    var names = {};
    for (var j = 0; j < sapObjects.length; j++) { names[String(sapObjects[j].TABLE_NAME).toUpperCase()] = true; }
    var hasEqui = false; for (var k in names) { if (k.indexOf('EQUI') >= 0) hasEqui = true; }
    var telCols = tel.map(function (r) { return String(r.COLUMN_NAME).toUpperCase(); });
    var telHasSerial = telCols.some(function (c) { return c.indexOf('SERIAL') >= 0; });
    var telHasVin    = telCols.some(function (c) { return c.indexOf('VIN') >= 0; });
    var telHasMmsi   = telCols.some(function (c) { return c.indexOf('MMSI') >= 0 || c.indexOf('IMO') >= 0; });
    var hint;
    if (telHasMmsi) hint = 'marine';
    else if (!hasEqui) hint = 'vin_external (no EQUI found; bind VIN to an external asset master)';
    else if (hasEqui && telHasSerial) hint = 'native_serial (EQUI present and telematics carries a serial)';
    else if (hasEqui && telHasVin) hint = 'vin_2hop (EQUI present; telematics identifies device/VIN)';
    else hint = 'native_serial (default; confirm the telematics join key)';

    return {
        status: 'SUCCESS',
        sap_db: P_SAP_DB,
        telematics_db: telDb,
        sap_objects: sapObjects,
        cdc_fingerprint: cdc,
        telematics_columns: tel,
        suggested: { cdc_tool: cdcTool, join_strategy_hint: hint },
        next_step: 'Review the objects, CDC fingerprint, and telematics columns, then set sap-mapping.yaml (sap_schema, telematics_table, cdc.tool, cdc.client/MANDT, join.strategy, region) before binding.'
    };
} catch (err) {
    return { status: 'FAILED', error: err.message };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_SAP_INTROSPECT(VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-sap-fleet-connector","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_BACKLOAD_SOLVE: internal-first backload matching, end to end.
--
-- The single implementation of what the Backload Matching / Backload Proposals
-- cockpit does: read the region's idle vehicles and open loads, build a VROOM
-- challenge per optimizer strategy, solve it live on the region's road graph,
-- parse the routes into (vehicle, load) proposals, score every pair on seven
-- dimensions, and rank them. Both the app (via /api/tool) and the agent (via the
-- backload_solve verb) call THIS proc, so there is one copy of the maths rather
-- than two that drift.
--
-- Strategies (P_STRATEGY):
--   baseline  quick scan, nearest eligible load by great-circle. No solve.
--   vrp       per-load VRP - one load per vehicle, road distances.
--   fleet     fleet-wide 1:1 assignment, road distances.
--   bpmp      profit-max backhaul - consolidates up to BPMP_MAX_STOPS loads,
--             priority derived from revenue rather than internal-first.
--   ensemble  all four, fused: one row per (vehicle, load) pair, keeping the
--             cheapest variant and recording how many strategies agreed.
--
-- Region scoping is NOT optional here. VW_TRAILERS_GEO and VW_LOADS do not
-- project REGION (their region-bearing sources do), so reading them directly
-- mixes every loaded region into one pool - measured on tib85385 as 191 vehicles
-- and 5,632 loads across all regions against 100 and 5,300 for San Francisco.
-- A cross-region pair is not merely noise: it proposes a backload the vehicle
-- physically cannot reach, and it scores well because the empty leg is computed
-- from coordinates that are perfectly valid in isolation. Both feeds are
-- therefore filtered through the FLEET_APP contract views, which do carry REGION.
--
-- Live routing per Tenet 9: the solve calls ROUTING_PLATFORM.CONTRACT.
-- _DISPATCH_OPTIMIZATION (the neutral seam, RAW scalar form) at request time.
-- Nothing is precomputed, and the engine is never named. The RAW form is used
-- rather than the OPTIMIZATION table function because the TVF's LATERAL FLATTEN
-- over resp:routes yields ZERO ROWS when a solve returns no routes or a
-- structured error, which is indistinguishable from "no backload exists".
--
-- Returns { status, region, vehicle_type, strategy, counts, proposals[], totals }
-- on success, or { status:'FAILED', reason, ... } with a typed reason:
--   OPTIMIZATION_UNAVAILABLE  the region's routing services are suspended or
--                             still cold-starting. Resume and retry.
--   NO_FEED                   no vehicles or no loads for this region.
--   DATA_NOT_PROVISIONED      the cockpit views do not exist for this dataset.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_BACKLOAD_SOLVE(
    P_STRATEGY     VARCHAR DEFAULT NULL,
    P_MAX_VEHICLES FLOAT   DEFAULT NULL,
    P_MAX_LOADS    FLOAT   DEFAULT NULL,
    P_REGION       VARCHAR DEFAULT NULL,
    P_LIMIT        FLOAT   DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
var region = P_REGION;
var vroomSvc = null;

function q(sql, binds) {
    return snowflake.createStatement({ sqlText: sql, binds: binds || [] }).execute();
}
function rowsOf(sql, binds, cols) {
    var rs = q(sql, binds);
    var out = [];
    while (rs.next()) {
        var o = {};
        for (var i = 0; i < cols.length; i++) o[cols[i]] = rs.getColumnValue(i + 1);
        out.push(o);
    }
    return out;
}
var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
var finite = function (v) { return v !== null && v !== undefined && isFinite(Number(v)); };
var okPt = function (lon, lat) { return isFinite(lon) && isFinite(lat) && !(lon === 0 && lat === 0); };
function clamp(v, lo, hi) {
    if (lo === undefined) lo = 0;
    if (hi === undefined) hi = 100;
    return Math.max(lo, Math.min(hi, v));
}
function haversineKm(lon1, lat1, lon2, lat2) {
    var R = 6371, toRad = function (x) { return (x * Math.PI) / 180; };
    var dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    var a = Math.pow(Math.sin(dLat / 2), 2)
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function greatCircleKm(lon1, lat1, lon2, lat2) {
    if (!finite(lon1) || !finite(lat1) || !finite(lon2) || !finite(lat2)) return null;
    return Math.round(haversineKm(Number(lon1), Number(lat1), Number(lon2), Number(lat2)) * 10) / 10;
}
function percentile(vals, p) {
    if (!vals.length) return 0;
    var arr = vals.slice().sort(function (a, b) { return a - b; });
    var idx = clamp(p, 0, 1) * (arr.length - 1);
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return arr[lo];
    return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}
// Coordinate identity at ~11 m, matching the epsilon VROOM echoes its failing
// location with. Used to shear an unroutable point out of a retry.
function coordKey(lon, lat) { return Number(lon).toFixed(4) + ',' + Number(lat).toFixed(4); }
function locMatches(loc, lon, lat) {
    return loc && loc.length === 2
        && Math.abs(Number(loc[0]) - lon) < 1e-4 && Math.abs(Number(loc[1]) - lat) < 1e-4;
}
function toGrade(s) {
    if (s === null || !isFinite(s)) return null;
    if (s >= 90) return 'A';
    if (s >= 80) return 'B+';
    if (s >= 70) return 'B';
    if (s >= 60) return 'C+';
    if (s >= 50) return 'C';
    if (s >= 40) return 'D';
    return 'F';
}
function familyOf(basis) {
    var b = String(basis || '').toLowerCase();
    if (b.indexOf('vrp') === 0) return 'vrp';
    if (b.indexOf('fleet') === 0) return 'fleet';
    if (b.indexOf('bpmp') === 0) return 'bpmp';
    return 'baseline';
}

var DIMENSIONS = ['costEff', 'revenue', 'margin', 'feasibility', 'utilization', 'consolidation', 'urgency'];
// Balanced preset - the same default the cockpit's weight sliders start from.
var WEIGHTS = { costEff: 0.12, revenue: 0.13, margin: 0.20, feasibility: 0.18,
                utilization: 0.15, consolidation: 0.10, urgency: 0.12 };
var COST_SCALE = 100;
var MAX_UNROUTABLE_RETRIES = 16;

try {
    // ---------------------------------------------------------------- region
    if (!region) {
        try {
            var cr = q("SELECT REGION FROM FLEET_APP.BACKLOAD_MATCHING.VW_CONFIG LIMIT 1");
            if (cr.next()) region = cr.getColumnValue(1);
        } catch (e) { /* fall through */ }
    }
    if (!region) {
        try {
            var dr = q("SELECT REGION FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE LIMIT 1");
            if (dr.next()) region = dr.getColumnValue(1);
        } catch (e) { /* fall through */ }
    }
    if (!region) region = 'SanFrancisco';
    vroomSvc = 'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_'
             + String(region).toUpperCase().replace(/[^A-Z0-9_]/g, '');

    var strategy = String(P_STRATEGY || 'ensemble').toLowerCase();
    var VALID = ['ensemble', 'baseline', 'vrp', 'fleet', 'bpmp'];
    if (VALID.indexOf(strategy) < 0) {
        return { status: 'FAILED', reason: 'BAD_STRATEGY', region: region,
                 error: 'strategy must be one of ' + VALID.join(', ') + ' (got ' + strategy + ')' };
    }
    // Upper clamps live HERE, not in the verb's arg schema: the framework's
    // t.number() carries no bounds, so an agent asking for 100000 vehicles would
    // otherwise reach the feed SQL. Both caps are concatenated into that SQL
    // (LIMIT cannot be a bind), so integer-and-bounded is also the injection
    // guarantee.
    var maxVehicles = finite(P_MAX_VEHICLES) && Number(P_MAX_VEHICLES) > 0 ? Math.min(200,  Math.floor(Number(P_MAX_VEHICLES))) : 20;
    var maxLoads    = finite(P_MAX_LOADS)    && Number(P_MAX_LOADS)    > 0 ? Math.min(1000, Math.floor(Number(P_MAX_LOADS)))    : 120;
    var outLimit    = finite(P_LIMIT)        && Number(P_LIMIT)        > 0 ? Math.min(200,  Math.floor(Number(P_LIMIT)))        : 25;
    // Math.floor'd above because LIMIT cannot be a bind in Snowflake, so these two
    // are string-concatenated into the feed SQL. Integer-only, hence injection-safe.

    // ------------------------------------------------------------ feed reads
    var vehicleType = 'hgv';
    try {
        var vr = q("SELECT VEHICLE_TYPE FROM FLEET_APP.BACKLOAD_MATCHING.VW_CONFIG LIMIT 1");
        if (vr.next()) vehicleType = String(vr.getColumnValue(1) || 'hgv');
    } catch (e) { /* default */ }

    // COST_PER_KM, not COST_EUR_PER_KM. The cockpit's VehicleClass interface
    // declares the latter and reads the view with SELECT *, so its per-km cost is
    // ALWAYS undefined and falls back to 0.85 - which happens to equal the hgv
    // rate, hiding the bug, while a van (0.55) or ebike (0.08) run is costed as a
    // truck. Deliberately NOT wrapped in try/catch: a renamed column must fail
    // loudly here rather than degrade to "class profile missing".
    var clsRows = rowsOf(
        "SELECT ORS_PROFILE, PAYLOAD_KG_TYP, COST_PER_KM, LABEL_NOUN "
      + "FROM FLEET_APP.BACKLOAD_MATCHING.VW_VEHICLE_CLASS WHERE VEHICLE_TYPE = ? LIMIT 1",
        [vehicleType], ['ORS_PROFILE', 'PAYLOAD_KG_TYP', 'COST_PER_KM', 'LABEL_NOUN']);
    var cls = clsRows.length ? clsRows[0] : null;
    if (!cls) {
        return { status: 'FAILED', reason: 'DATA_NOT_PROVISIONED', region: region,
                 error: 'No vehicle class profile for vehicle type ' + vehicleType
                      + '. The backload layer is provisioned by the admin app boot from an active dataset.' };
    }
    var profile = String(cls.ORS_PROFILE || 'driving-hgv');
    var classCapacityKg = num(cls.PAYLOAD_KG_TYP) || 1000;
    var effPerKm = num(cls.COST_PER_KM) || 0.85;

    var params = {};
    try {
        var pr = rowsOf("SELECT PARAM_KEY, PARAM_VALUE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.MATCH_PARAMS",
                        [], ['PARAM_KEY', 'PARAM_VALUE']);
        for (var pi = 0; pi < pr.length; pi++) params[String(pr[pi].PARAM_KEY)] = pr[pi].PARAM_VALUE;
    } catch (e) { /* defaults below */ }
    function param(key, dflt) {
        var v = Number(params[key]);
        return isFinite(v) ? v : dflt;
    }
    var costEmpty  = param('COST_PER_EMPTY_KM', 1.2);
    var revLoaded  = param('REVENUE_PER_LOADED_KM', 1.10);
    var maxEmptyKm = Math.max(1, param('MAX_EMPTY_KM', 100));
    var maxStops   = Math.max(2, param('BPMP_MAX_STOPS', 4));
    var IDEAL_SLACK_HRS = 24;

    // Region-scoped feeds. Deterministic ORDER BY so the same request returns the
    // same subset when the caps bite - the cockpit relied on the view's natural
    // order, which makes a capped run irreproducible.
    var trailers, loads, eligible;
    try {
        trailers = rowsOf(
            "SELECT g.TRAILER_ID, g.OPERATING_COUNTRY, g.EMPTY_CITY, g.EMPTY_LON, g.EMPTY_LAT, "
          + "       g.EMPTY_FROM_TS, g.NEXT_START_LON, g.NEXT_START_LAT, g.MAX_PAYLOAD_KG, g.HAZMAT_CERT "
          + "FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS_GEO g "
          + "WHERE g.TRAILER_ID IN ("
          + "  SELECT TRAILER_ID FROM FLEET_APP.BACKLOAD_MATCHING.VW_TRAILERS WHERE REGION = ?) "
          + "ORDER BY g.EMPTY_FROM_TS NULLS LAST, g.TRAILER_ID "
          + "LIMIT " + maxVehicles,
            [region],
            ['TRAILER_ID', 'OPERATING_COUNTRY', 'EMPTY_CITY', 'EMPTY_LON', 'EMPTY_LAT',
             'EMPTY_FROM_TS', 'NEXT_START_LON', 'NEXT_START_LAT', 'MAX_PAYLOAD_KG', 'HAZMAT_CERT']);
        // The region-scoped id set MUST be a CTE joined in, not an IN (...) with a
        // UNION ALL inside it: Snowflake rejects that with "Unsupported subquery
        // type cannot be evaluated".
        loads = rowsOf(
            "WITH scoped AS ("
          + "  SELECT ID AS LOAD_ID FROM FLEET_APP.BACKLOAD_MATCHING.VW_INTERNAL_VOLUMES WHERE REGION = ? "
          + "  UNION ALL "
          + "  SELECT OFFER_ID AS LOAD_ID FROM FLEET_APP.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS WHERE REGION = ?) "
          + "SELECT l.LOAD_ID, l.IS_INTERNAL, l.SOURCE, l.PICKUP_CITY, l.PICKUP_LON, l.PICKUP_LAT, "
          + "       l.DELIVERY_CITY, l.DELIVERY_LON, l.DELIVERY_LAT, l.REQUESTED_PICKUP_TS, "
          + "       l.WEIGHT_KG, l.PRODUCT, l.HAZMAT, l.PRICE_USD, l.APPROX_DISTANCE_KM "
          + "FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_LOADS l "
          + "JOIN scoped s ON s.LOAD_ID = l.LOAD_ID "
          + "ORDER BY l.IS_INTERNAL DESC, l.REQUESTED_PICKUP_TS NULLS LAST, l.LOAD_ID "
          + "LIMIT " + maxLoads,
            [region, region],
            ['LOAD_ID', 'IS_INTERNAL', 'SOURCE', 'PICKUP_CITY', 'PICKUP_LON', 'PICKUP_LAT',
             'DELIVERY_CITY', 'DELIVERY_LON', 'DELIVERY_LAT', 'REQUESTED_PICKUP_TS',
             'WEIGHT_KG', 'PRODUCT', 'HAZMAT', 'PRICE_USD', 'APPROX_DISTANCE_KM']);
        eligible = rowsOf(
            "SELECT TRAILER_ID, LOAD_ID, DIST_CHECK, TIME_CHECK, HORIZON_CHECK, CAP_CHECK, HAZMAT_CHECK "
          + "FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_CANDIDATES_SCORED WHERE ELIGIBLE = TRUE",
            [], ['TRAILER_ID', 'LOAD_ID', 'DIST_CHECK', 'TIME_CHECK', 'HORIZON_CHECK', 'CAP_CHECK', 'HAZMAT_CHECK']);
    } catch (e) {
        var m = e && e.message ? String(e.message) : 'unknown error';
        if (/does not exist or not authorized/i.test(m)) {
            return { status: 'FAILED', reason: 'DATA_NOT_PROVISIONED', region: region,
                     error: 'The backload cockpit views are not provisioned for the active dataset. '
                          + 'The admin app recreates them at boot from a generated dataset.' };
        }
        throw e;
    }
    if (!trailers.length || !loads.length) {
        return { status: 'FAILED', reason: 'NO_FEED', region: region, vehicle_type: vehicleType,
                 vehicles: trailers.length, loads: loads.length,
                 error: 'No idle vehicles or no open loads for region ' + region + '.' };
    }

    var eligibleSet = {}, chipsByPair = {};
    for (var ei = 0; ei < eligible.length; ei++) {
        var ec = eligible[ei];
        var ekey = String(ec.TRAILER_ID) + '::' + String(ec.LOAD_ID);
        eligibleSet[ekey] = true;
        chipsByPair[ekey] = { distance: ec.DIST_CHECK === true, pickup_time: ec.TIME_CHECK === true,
                              horizon: ec.HORIZON_CHECK === true, capacity: ec.CAP_CHECK === true,
                              hazmat: ec.HAZMAT_CHECK === true };
    }
    var eligibleCount = Object.keys(eligibleSet).length;

    // ------------------------------------------------ challenge construction
    // A shipment is TWO VROOM tasks (pickup + delivery), so max_tasks is the
    // per-vehicle LOAD count doubled. Passing the load count straight through
    // makes the 'vrp' family (1 load) unable to admit any shipment at all, and
    // silently caps 'bpmp' at 2 loads instead of BPMP_MAX_STOPS - both return
    // plausible-looking results, so the loss never surfaces.
    function buildChallenge(fam, badKeys) {
        var maxLoadsPerVehicle = (fam === 'bpmp') ? maxStops : 1;
        var isBad = function (lon, lat) { return badKeys ? badKeys[coordKey(lon, lat)] === true : false; };
        var idToTrailer = {}, vehicles = [];
        for (var i = 0; i < trailers.length; i++) {
            var t = trailers[i];
            if (isBad(num(t.EMPTY_LON), num(t.EMPTY_LAT))) continue;
            if (isBad(num(t.NEXT_START_LON), num(t.NEXT_START_LAT))) continue;
            var vid = vehicles.length + 1;
            idToTrailer[vid] = t;
            vehicles.push({
                id: vid, profile: profile,
                start: [num(t.EMPTY_LON), num(t.EMPTY_LAT)],
                end: [num(t.NEXT_START_LON), num(t.NEXT_START_LAT)],
                capacity: [num(t.MAX_PAYLOAD_KG) || classCapacityKg],
                skills: t.HAZMAT_CERT ? [1, 2, 3] : [1, 2],
                max_tasks: maxLoadsPerVehicle * 2,
                costs: { fixed: 140 * COST_SCALE, per_km: Math.round(effPerKm * COST_SCALE) }
            });
        }
        var idToLoad = {}, shipments = [], nextId = 1000;
        for (var j = 0; j < loads.length; j++) {
            var l = loads[j];
            if (isBad(num(l.PICKUP_LON), num(l.PICKUP_LAT))) continue;
            if (isBad(num(l.DELIVERY_LON), num(l.DELIVERY_LAT))) continue;
            var lid = nextId++;
            idToLoad[lid] = l;
            var kg = Math.min(num(l.WEIGHT_KG), classCapacityKg);
            var priority = l.IS_INTERNAL ? 90 : 10;
            if (fam === 'bpmp') {
                var rev = (l.PRICE_USD !== null && l.PRICE_USD !== undefined)
                        ? num(l.PRICE_USD) : num(l.APPROX_DISTANCE_KM) * 1.1;
                priority = Math.max(1, Math.min(100, Math.round(rev / 25)));
            }
            var skills = l.HAZMAT ? (l.IS_INTERNAL ? [1, 3] : [2, 3]) : (l.IS_INTERNAL ? [1] : [2]);
            shipments.push({
                pickup:   { id: lid, location: [num(l.PICKUP_LON),   num(l.PICKUP_LAT)],   service: 1800 },
                delivery: { id: lid, location: [num(l.DELIVERY_LON), num(l.DELIVERY_LAT)], service: 600 },
                amount: [kg], skills: skills, priority: priority
            });
        }
        // g:false - do NOT request per-route road geometry. On a continental
        // region the geometry for many long routes pushes the response past the
        // external-function 20MB cap (Snowflake 100335) and the whole solve is
        // lost. The solve is unaffected (VROOM sources its matrix from the
        // routing engine internally); a caller that needs a drawn line fetches
        // DIRECTIONS for the one selected pair.
        return { vehicles: vehicles, shipments: shipments, idToTrailer: idToTrailer, idToLoad: idToLoad };
    }

    // -------------------------------------------------------------- the solve
    // VROOM code 3 aborts the ENTIRE solve when a single location cannot be
    // routed (a point snapped onto a disconnected road component), and it names
    // only ONE offending coordinate per attempt. Shear that point and re-solve;
    // the cap stops a pathological dataset looping forever. On cap-exhaust this
    // yields nothing for the family rather than failing the whole request, so
    // one bad family cannot take its siblings down.
    var suspendedSeen = null;
    function solveOnce(vehicles, shipments) {
        var challenge = JSON.stringify({ vehicles: vehicles, shipments: shipments, options: { g: false } });
        var rs = q("SELECT ROUTING_PLATFORM.CONTRACT._DISPATCH_OPTIMIZATION(PARSE_JSON(?), ?, NULL) AS RESP",
                   [challenge, region]);
        var raw = rs.next() ? rs.getColumnValue(1) : null;
        if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { /* leave */ } }
        return raw;
    }
    function solveWithShear(vehicles, shipments) {
        var workV = vehicles, workS = shipments, dropped = {}, excluded = 0;
        for (var attempt = 0; attempt <= MAX_UNROUTABLE_RETRIES; attempt++) {
            if (!workV.length || !workS.length) return { result: null, excluded: excluded };
            var res = solveOnce(workV, workS);
            if (!res) return { result: null, excluded: excluded };
            if (!res.error) return { result: res, excluded: excluded };
            var msg = (typeof res.message === 'string') ? res.message : String(res.error);
            // A suspended engine reaches us as a DNS/connection failure inside the
            // gateway. Record it so the caller gets a resume-able reason instead
            // of an empty plan that reads as "no backload exists".
            if (/Name or service not known|Temporary failure in name resolution|connection refused|circuit_open|service_unreachable/i.test(msg)) {
                suspendedSeen = msg;
                return { result: null, excluded: excluded };
            }
            var mm = /location\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/i.exec(msg);
            if (!mm) return { result: null, excluded: excluded };
            var bad = { lon: Number(mm[1]), lat: Number(mm[2]) };
            var bk = coordKey(bad.lon, bad.lat);
            if (dropped[bk]) return { result: null, excluded: excluded };
            dropped[bk] = true;
            var nv = [], ns = [];
            for (var vi = 0; vi < workV.length; vi++) {
                var v = workV[vi];
                if (!locMatches(v.start, bad.lon, bad.lat) && !locMatches(v.end, bad.lon, bad.lat)) nv.push(v);
            }
            for (var si = 0; si < workS.length; si++) {
                var s = workS[si];
                if (!locMatches(s.pickup.location, bad.lon, bad.lat)
                 && !locMatches(s.delivery.location, bad.lon, bad.lat)) ns.push(s);
            }
            excluded += (workV.length - nv.length) + (workS.length - ns.length);
            workV = nv; workS = ns;
        }
        return { result: null, excluded: excluded };
    }

    // ------------------------------------------------------- parse into rows
    function parseSolve(resp, fam, idToTrailer, idToLoad) {
        var basis = fam === 'vrp' ? 'vrp_road' : fam === 'fleet' ? 'fleet_vrp' : fam === 'bpmp' ? 'bpmp' : 'great_circle';
        var routes = (resp && resp.routes && resp.routes.length) ? resp.routes : [];
        var out = [];
        for (var ri = 0; ri < routes.length; ri++) {
            var route = routes[ri];
            var t = idToTrailer[Number(route.vehicle)];
            if (!t) continue;
            var steps = route.steps && route.steps.length ? route.steps : [];
            var seq = 0;
            for (var si2 = 0; si2 < steps.length; si2++) {
                if (steps[si2].type !== 'pickup') continue;
                var l = idToLoad[Number(steps[si2].id)];
                if (!l) continue;
                seq += 1;
                var emptyKm  = haversineKm(num(t.EMPTY_LON), num(t.EMPTY_LAT), num(l.PICKUP_LON), num(l.PICKUP_LAT));
                var loadedKm = haversineKm(num(l.PICKUP_LON), num(l.PICKUP_LAT), num(l.DELIVERY_LON), num(l.DELIVERY_LAT));
                var nextKm   = haversineKm(num(l.DELIVERY_LON), num(l.DELIVERY_LAT), num(t.NEXT_START_LON), num(t.NEXT_START_LAT));
                var baseKm   = haversineKm(num(t.EMPTY_LON), num(t.EMPTY_LAT), num(t.NEXT_START_LON), num(t.NEXT_START_LAT));
                var totalKm  = emptyKm + loadedKm + nextKm;
                out.push({
                    PROPOSAL_ID: fam + ':' + t.TRAILER_ID + ':' + l.LOAD_ID,
                    TRAILER_ID: t.TRAILER_ID, LOAD_ID: l.LOAD_ID, DISTANCE_BASIS: basis,
                    EMPTY_KM: emptyKm, LOADED_KM: loadedKm,
                    DETOUR_KM: Math.max(0, totalKm - loadedKm - baseKm), TOTAL_KM: totalKm,
                    PICKUP_SLACK_HRS: null, FEASIBLE: true, STOP_SEQ: (fam === 'bpmp' ? seq : null),
                    PICKUP_LON: num(l.PICKUP_LON), PICKUP_LAT: num(l.PICKUP_LAT),
                    DELIVERY_LON: num(l.DELIVERY_LON), DELIVERY_LAT: num(l.DELIVERY_LAT),
                    PICKUP_CITY: l.PICKUP_CITY, PICKUP_COUNTRY: t.OPERATING_COUNTRY,
                    DELIVERY_CITY: l.DELIVERY_CITY, EMPTY_CITY: t.EMPTY_CITY,
                    IS_INTERNAL: l.IS_INTERNAL === true, SOURCE: l.SOURCE
                });
            }
        }
        return out;
    }
    // Quick scan: nearest ELIGIBLE load per vehicle by great-circle. No solve, so
    // it is the one family that still answers when the engine is down.
    function baselineProposals() {
        var out = [];
        for (var i = 0; i < trailers.length; i++) {
            var t = trailers[i], best = null;
            for (var j = 0; j < loads.length; j++) {
                var l = loads[j];
                if (eligibleCount && !eligibleSet[String(t.TRAILER_ID) + '::' + String(l.LOAD_ID)]) continue;
                var km = haversineKm(num(t.EMPTY_LON), num(t.EMPTY_LAT), num(l.PICKUP_LON), num(l.PICKUP_LAT));
                if (!best || km < best.km) best = { l: l, km: km };
            }
            if (!best) continue;
            var bl = best.l;
            var loadedKm = haversineKm(num(bl.PICKUP_LON), num(bl.PICKUP_LAT), num(bl.DELIVERY_LON), num(bl.DELIVERY_LAT));
            out.push({
                PROPOSAL_ID: 'baseline:' + t.TRAILER_ID + ':' + bl.LOAD_ID,
                TRAILER_ID: t.TRAILER_ID, LOAD_ID: bl.LOAD_ID, DISTANCE_BASIS: 'great_circle',
                EMPTY_KM: best.km, LOADED_KM: loadedKm, DETOUR_KM: null, TOTAL_KM: best.km + loadedKm,
                PICKUP_SLACK_HRS: null, FEASIBLE: true, STOP_SEQ: null,
                PICKUP_LON: num(bl.PICKUP_LON), PICKUP_LAT: num(bl.PICKUP_LAT),
                DELIVERY_LON: num(bl.DELIVERY_LON), DELIVERY_LAT: num(bl.DELIVERY_LAT),
                PICKUP_CITY: bl.PICKUP_CITY, PICKUP_COUNTRY: t.OPERATING_COUNTRY,
                DELIVERY_CITY: bl.DELIVERY_CITY, EMPTY_CITY: t.EMPTY_CITY,
                IS_INTERNAL: bl.IS_INTERNAL === true, SOURCE: bl.SOURCE
            });
        }
        return out;
    }

    // -------------------------------------------------------------- run them
    var families = (strategy === 'ensemble') ? ['baseline', 'vrp', 'fleet', 'bpmp'] : [strategy];
    var all = [], excludedTotal = 0, familiesRun = [];
    for (var fi = 0; fi < families.length; fi++) {
        var fam = families[fi];
        if (fam === 'baseline') {
            var bp = baselineProposals();
            if (bp.length) { familiesRun.push(fam); all = all.concat(bp); }
            continue;
        }
        var built = buildChallenge(fam, null);
        if (!built.vehicles.length || !built.shipments.length) continue;
        var solved = solveWithShear(built.vehicles, built.shipments);
        excludedTotal = Math.max(excludedTotal, solved.excluded);
        var parsed = parseSolve(solved.result, fam, built.idToTrailer, built.idToLoad);
        if (parsed.length) { familiesRun.push(fam); all = all.concat(parsed); }
    }
    if (!all.length) {
        if (suspendedSeen) {
            return { status: 'FAILED', reason: 'OPTIMIZATION_UNAVAILABLE', region: region,
                     vroom_service: vroomSvc,
                     error: 'Route optimization for ' + region + ' is not responding (it may be suspended '
                          + 'or starting). Resume it and retry. Detail: ' + suspendedSeen };
        }
        return { status: 'SUCCESS', region: region, vehicle_type: vehicleType, strategy: strategy,
                 counts: { vehicles: trailers.length, loads: loads.length, eligible_pairs: eligibleCount,
                           proposals: 0, vehicles_matched: 0, excluded_unroutable: excludedTotal },
                 proposals: [], totals: {},
                 note: 'No proposals were produced. Every candidate pair was either ineligible or unroutable.' };
    }

    // ------------------------------------------------------------- scoring
    // De-duplicate to one pair per (vehicle, load), keeping the cheapest variant,
    // and record how many strategies independently picked it. Identical maths to
    // the cockpit's ensemble so a graded answer from the agent matches the screen.
    var rowCost = function (r) {
        if (finite(r.DETOUR_KM)) return Number(r.DETOUR_KM);
        if (finite(r.EMPTY_KM)) return Number(r.EMPTY_KM);
        return Infinity;
    };
    var nowMs = Date.now();
    var idleHrsByTrailer = {}, idleValues = [];
    for (var ti = 0; ti < trailers.length; ti++) {
        var tt = trailers[ti];
        if (!tt.EMPTY_FROM_TS) continue;
        var ms = Date.parse(String(tt.EMPTY_FROM_TS));
        if (!isFinite(ms)) continue;
        var hrs = Math.max(0, (nowMs - ms) / 3600000);
        idleHrsByTrailer[tt.TRAILER_ID] = hrs;
        idleValues.push(hrs);
    }
    idleValues.sort(function (a, b) { return a - b; });
    function idlePercentile(hrs) {
        if (!idleValues.length) return 50;
        var countLe = 0;
        for (var k = 0; k < idleValues.length; k++) { if (idleValues[k] <= hrs) countLe++; else break; }
        return clamp((countLe / idleValues.length) * 100);
    }
    // Consolidation is a VEHICLE property (how many stops its tour reached), so it
    // is keyed by vehicle and only the bpmp family produces it.
    var trailerStops = {};
    for (var ai = 0; ai < all.length; ai++) {
        var ar = all[ai];
        if (familyOf(ar.DISTANCE_BASIS) === 'bpmp' && finite(ar.STOP_SEQ)) {
            trailerStops[ar.TRAILER_ID] = Math.max(trailerStops[ar.TRAILER_ID] || 0, Number(ar.STOP_SEQ));
        }
    }
    var bestLoadForTrailer = {}, bestTrailerForLoad = {};
    var bestCostFamTrailer = {}, bestCostFamLoad = {};
    var famsPerTrailer = {}, famsPerLoad = {};
    for (var bi = 0; bi < all.length; bi++) {
        var br = all[bi], bfam = familyOf(br.DISTANCE_BASIS), bc = rowCost(br);
        if (!famsPerTrailer[br.TRAILER_ID]) famsPerTrailer[br.TRAILER_ID] = {};
        famsPerTrailer[br.TRAILER_ID][bfam] = true;
        if (!famsPerLoad[br.LOAD_ID]) famsPerLoad[br.LOAD_ID] = {};
        famsPerLoad[br.LOAD_ID][bfam] = true;
        var tkey = bfam + '::' + br.TRAILER_ID;
        if (!(tkey in bestCostFamTrailer) || bc < bestCostFamTrailer[tkey]) {
            bestCostFamTrailer[tkey] = bc;
            bestLoadForTrailer[tkey] = br.LOAD_ID;
        }
        var lkey = bfam + '::' + br.LOAD_ID;
        if (!(lkey in bestCostFamLoad) || bc < bestCostFamLoad[lkey]) {
            bestCostFamLoad[lkey] = bc;
            bestTrailerForLoad[lkey] = br.TRAILER_ID;
        }
    }
    var groups = {};
    for (var gi = 0; gi < all.length; gi++) {
        var gr = all[gi], gkey = gr.TRAILER_ID + '::' + gr.LOAD_ID;
        if (!groups[gkey]) groups[gkey] = [];
        groups[gkey].push(gr);
    }
    var pairs = [];
    var gkeys = Object.keys(groups);
    for (var ki = 0; ki < gkeys.length; ki++) {
        var rows = groups[gkeys[ki]];
        var best = rows[0];
        for (var ri2 = 1; ri2 < rows.length; ri2++) if (rowCost(rows[ri2]) < rowCost(best)) best = rows[ri2];
        var famSet = {};
        for (var ri3 = 0; ri3 < rows.length; ri3++) famSet[familyOf(rows[ri3].DISTANCE_BASIS)] = true;
        var famList = Object.keys(famSet);
        var pick = function (sel, mode) {
            var vals = [];
            for (var x = 0; x < rows.length; x++) { var v = sel(rows[x]); if (finite(v)) vals.push(Number(v)); }
            if (!vals.length) return null;
            return mode === 'max' ? Math.max.apply(null, vals) : Math.min.apply(null, vals);
        };
        var emptyKm  = pick(function (r) { return r.EMPTY_KM; }, 'min');
        var loadedKm = pick(function (r) { return r.LOADED_KM; }, 'max');
        var detourKm = pick(function (r) { return r.DETOUR_KM; }, 'min');
        var totalKm  = pick(function (r) { return r.TOTAL_KM; }, 'min');
        var slack    = pick(function (r) { return r.PICKUP_SLACK_HRS; }, 'max');
        var anyTrue = false, anyFalse = false;
        for (var ri4 = 0; ri4 < rows.length; ri4++) {
            if (rows[ri4].FEASIBLE === true) anyTrue = true;
            if (rows[ri4].FEASIBLE === false) anyFalse = true;
        }
        var feasible = anyTrue ? true : (anyFalse ? false : null);
        var tCons = 0, tConsOf = 0, lCons = 0, lConsOf = 0;
        var tf = famsPerTrailer[best.TRAILER_ID] || {};
        var tfk = Object.keys(tf); tConsOf = tfk.length;
        for (var c1 = 0; c1 < tfk.length; c1++) if (bestLoadForTrailer[tfk[c1] + '::' + best.TRAILER_ID] === best.LOAD_ID) tCons++;
        var lf = famsPerLoad[best.LOAD_ID] || {};
        var lfk = Object.keys(lf); lConsOf = lfk.length;
        for (var c2 = 0; c2 < lfk.length; c2++) if (bestTrailerForLoad[lfk[c2] + '::' + best.LOAD_ID] === best.TRAILER_ID) lCons++;
        var loadedKmEst = greatCircleKm(best.PICKUP_LON, best.PICKUP_LAT, best.DELIVERY_LON, best.DELIVERY_LAT);
        pairs.push({
            key: gkeys[ki], trailerId: best.TRAILER_ID, loadId: best.LOAD_ID,
            bestSource: familyOf(best.DISTANCE_BASIS), agreement: famList.length, families: famList,
            trailerConsensus: tCons, trailerConsensusOf: tConsOf,
            loadConsensus: lCons, loadConsensusOf: lConsOf,
            emptyKm: emptyKm, loadedKm: loadedKm, loadedKmEst: loadedKmEst,
            detourKm: detourKm, totalKm: totalKm, pickupSlackHrs: slack,
            maxStopSeq: (best.TRAILER_ID in trailerStops) ? trailerStops[best.TRAILER_ID] : null,
            idleHours: (best.TRAILER_ID in idleHrsByTrailer) ? idleHrsByTrailer[best.TRAILER_ID] : null,
            feasible: feasible, isInternal: best.IS_INTERNAL === true, source: best.SOURCE,
            pickupCity: best.PICKUP_CITY, pickupCountry: best.PICKUP_COUNTRY,
            deliveryCity: best.DELIVERY_CITY, emptyCity: best.EMPTY_CITY,
            pickupLon: best.PICKUP_LON, pickupLat: best.PICKUP_LAT,
            deliveryLon: best.DELIVERY_LON, deliveryLat: best.DELIVERY_LAT,
            scores: {}, grades: {}
        });
    }
    var econLoaded = function (p) {
        return finite(p.loadedKm) ? Number(p.loadedKm) : (finite(p.loadedKmEst) ? Number(p.loadedKmEst) : null);
    };
    var econMargin = function (p) {
        var L = econLoaded(p);
        if (L === null) return null;
        return finite(p.emptyKm) ? L * revLoaded - Number(p.emptyKm) * costEmpty : L * revLoaded;
    };
    var revenues = [], margins = [];
    for (var pi2 = 0; pi2 < pairs.length; pi2++) {
        var L2 = econLoaded(pairs[pi2]);
        if (L2 !== null) revenues.push(L2 * revLoaded);
        var m2 = econMargin(pairs[pi2]);
        if (m2 !== null) margins.push(m2);
    }
    var revP90 = percentile(revenues, 0.90);
    var marginMin = margins.length ? Math.min.apply(null, margins) : 0;
    var marginMax = margins.length ? Math.max.apply(null, margins) : 0;
    for (var pi3 = 0; pi3 < pairs.length; pi3++) {
        var p = pairs[pi3];
        p.scores.costEff = finite(p.emptyKm) ? clamp(100 - (Number(p.emptyKm) / maxEmptyKm) * 100) : null;
        var eL = econLoaded(p);
        var rev2 = (eL !== null) ? eL * revLoaded : null;
        p.scores.revenue = (rev2 !== null && revP90 > 0) ? clamp((rev2 / revP90) * 100) : null;
        var mg = econMargin(p);
        p.scores.margin = (mg !== null && marginMax > marginMin)
            ? clamp(((mg - marginMin) / (marginMax - marginMin)) * 100)
            : (mg !== null ? 60 : null);
        if (p.feasible === false) p.scores.feasibility = 0;
        else if (finite(p.pickupSlackHrs)) p.scores.feasibility = clamp((Number(p.pickupSlackHrs) / IDEAL_SLACK_HRS) * 100);
        else p.scores.feasibility = (p.feasible === true) ? 70 : null;
        p.scores.utilization = (eL !== null && finite(p.emptyKm) && (eL + Number(p.emptyKm)) > 0)
            ? clamp((eL / (eL + Number(p.emptyKm))) * 100) : null;
        if (finite(p.maxStopSeq)) {
            var st = Number(p.maxStopSeq);
            p.scores.consolidation = (st <= 1) ? 50 : clamp((st / maxStops) * 100);
        } else p.scores.consolidation = null;
        p.scores.urgency = finite(p.idleHours) ? idlePercentile(Number(p.idleHours)) : null;
        for (var di = 0; di < DIMENSIONS.length; di++) p.grades[DIMENSIONS[di]] = toGrade(p.scores[DIMENSIONS[di]]);
        // Composite. Weights are relative and renormalized per pair, so a pair
        // missing a dimension is not penalised for the absence.
        var wSum = 0, acc = 0;
        for (var dj = 0; dj < DIMENSIONS.length; dj++) {
            var d = DIMENSIONS[dj], sc = p.scores[d], w = Math.max(0, Number(WEIGHTS[d]) || 0);
            if (sc === null || w === 0) continue;
            acc += sc * w; wSum += w;
        }
        p.composite = wSum > 0 ? acc / wSum : 0;
        p.grade = toGrade(p.composite) || 'F';
    }
    pairs.sort(function (a, b) {
        return (b.composite - a.composite)
            || (b.agreement - a.agreement)
            || ((a.emptyKm === null ? Infinity : a.emptyKm) - (b.emptyKm === null ? Infinity : b.emptyKm));
    });

    // One entry per vehicle: its best-scoring pair. This is the dispatcher's
    // answer ("what should this vehicle do"), and the per-vehicle totals below
    // must be computed from it - summing every graded pair would count the same
    // vehicle many times.
    var bestByTrailer = {}, perVehicle = [];
    for (var qi = 0; qi < pairs.length; qi++) {
        var pp = pairs[qi];
        if (bestByTrailer[pp.trailerId]) continue;
        bestByTrailer[pp.trailerId] = pp;
        perVehicle.push(pp);
    }
    var totalEmpty = 0, totalMargin = 0, internalMatched = 0, compositeSum = 0;
    for (var vi2 = 0; vi2 < perVehicle.length; vi2++) {
        var pv = perVehicle[vi2];
        totalEmpty += finite(pv.emptyKm) ? Number(pv.emptyKm) : 0;
        var mv = econMargin(pv);
        totalMargin += (mv === null) ? 0 : mv;
        if (pv.isInternal) internalMatched++;
        compositeSum += pv.composite;
    }

    var outRows = [];
    for (var oi = 0; oi < Math.min(outLimit, perVehicle.length); oi++) {
        var o = perVehicle[oi];
        outRows.push({
            vehicle_id: o.trailerId, load_id: o.loadId,
            grade: o.grade, composite: Math.round(o.composite * 10) / 10,
            best_strategy: o.bestSource, strategies_agreeing: o.agreement, strategies: o.families,
            is_internal: o.isInternal, source: o.source,
            empty_km: (o.emptyKm === null) ? null : Math.round(o.emptyKm * 10) / 10,
            loaded_km: (econLoaded(o) === null) ? null : Math.round(econLoaded(o) * 10) / 10,
            detour_km: (o.detourKm === null) ? null : Math.round(o.detourKm * 10) / 10,
            margin_usd: (econMargin(o) === null) ? null : Math.round(econMargin(o)),
            idle_hours: (o.idleHours === null) ? null : Math.round(o.idleHours * 10) / 10,
            stops: o.maxStopSeq,
            empty_city: o.emptyCity, pickup_city: o.pickupCity, delivery_city: o.deliveryCity,
            pickup_lon: o.pickupLon, pickup_lat: o.pickupLat,
            delivery_lon: o.deliveryLon, delivery_lat: o.deliveryLat,
            scores: o.scores,
            constraints: chipsByPair[o.trailerId + '::' + o.loadId] || null
        });
    }

    return {
        status: 'SUCCESS', region: region, vehicle_type: vehicleType, strategy: strategy,
        label_noun: cls.LABEL_NOUN || 'vehicle',
        strategies_run: familiesRun,
        counts: {
            vehicles: trailers.length, loads: loads.length, eligible_pairs: eligibleCount,
            graded_pairs: pairs.length, vehicles_matched: perVehicle.length,
            proposals_returned: outRows.length, excluded_unroutable: excludedTotal
        },
        totals: {
            internal_matched: internalMatched,
            total_empty_km: Math.round(totalEmpty),
            total_margin_usd: Math.round(totalMargin),
            avg_composite: perVehicle.length ? Math.round(compositeSum / perVehicle.length) : null
        },
        weights: WEIGHTS,
        proposals: outRows,
        // A partially-degraded run is still a SUCCESS, but the caller must be able
        // to say so rather than presenting a thinner plan as complete.
        degraded: suspendedSeen ? 'Some strategies could not solve: the routing engine was unreachable.' : null
    };
} catch (err) {
    var em = (err && err.message) ? String(err.message) : 'unknown error';
    if (/Name or service not known|Temporary failure in name resolution|connection refused|circuit_open|service_unreachable/i.test(em)) {
        return { status: 'FAILED', reason: 'OPTIMIZATION_UNAVAILABLE', region: region,
                 vroom_service: vroomSvc,
                 error: 'Route optimization for ' + region + ' is not responding (' + em + '). Resume it and retry.' };
    }
    return { status: 'FAILED', reason: 'ERROR', region: region, error: em };
}
$$;
ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_BACKLOAD_SOLVE(VARCHAR, FLOAT, FLOAT, VARCHAR, FLOAT) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_BACKLOAD_CHAIN_SOLVE: two-hop (chained) return planning.
--
-- The case single-hop matching structurally cannot answer: a vehicle empties a
-- long way from where it must get back to, and NO single load makes the return.
-- A chain does it in two hops - carry load A part of the way, then load B the
-- rest. This is the same computation the Triangle Proposals cockpit performs, so
-- app and agent share one implementation.
--
-- Three things make a chain actionable rather than merely clever, and all three
-- are load-bearing here:
--
--  1. INTERNAL-FIRST CASCADE. Own loads are exhausted before an outside exchange
--     is consulted. The ladder is explicit (rung 1 own/own .. rung 4
--     external/external) and stops at the LOWEST rung producing an eligible
--     chain at or above the acceptance score, so the answer can say "no
--     internal-only chain existed" instead of quietly returning an external one.
--     Note the counter-intuitive consequence, which must be reported rather than
--     hidden: if NO rung clears the mark the cascade cut is not applied at all,
--     so RAISING the acceptance score can return MORE chains, not fewer.
--
--  2. LIVE ROAD COST. VW_TRIANGLES enumerates and prunes chain skeletons in SQL
--     on great-circle distance; every leg of every surviving chain is then priced
--     by ONE live MATRIX_TABULAR call (Tenet 9 - routing output is never cached
--     into a table). Grading and the cascade are applied ONLY on road figures,
--     because stopping the cascade on a straight-line estimate would commit to a
--     rung on data the road network may contradict. cost_basis='great_circle'
--     skips the call and deliberately returns ungraded skeletons.
--
--  3. A STATUS-QUO BASELINE. Every chain is reported against what the planner
--     would otherwise do: run empty to the target. The chain's empty distance
--     MUST therefore include the residual run from the hop-2 delivery to the
--     target (TOTAL_EMPTY_WITH_RESIDUAL_KM), because the baseline is a COMPLETE
--     run home. Comparing a complete baseline against the two-leg subtotal
--     overstated every saving on this page - one chain read as 173 km better
--     while actually running 44 km further. TOTAL_EMPTY_KM stays the two-leg
--     subtotal because the constraint checks are calibrated against it.
--
-- Region scoping: VW_TRIANGLES does not project REGION, so chains are filtered
-- by the region's own vehicles via the FLEET_APP contract. Without this a chain
-- can be proposed for a vehicle on another continent.
--
-- Returns { status, region, cost_basis, cascade, acceptance_score, counts,
--           totals, chains[] } or { status:'FAILED', reason, error }.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_BACKLOAD_CHAIN_SOLVE(
    P_REGION           VARCHAR DEFAULT NULL,
    P_COST_BASIS       VARCHAR DEFAULT NULL,
    P_ACCEPTANCE_SCORE FLOAT   DEFAULT NULL,
    P_MAX_PER_VEHICLE  FLOAT   DEFAULT NULL,
    P_LIMIT            FLOAT   DEFAULT NULL
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
var region = P_REGION;

function q(sql, binds) {
    return snowflake.createStatement({ sqlText: sql, binds: binds || [] }).execute();
}
var num = function (v) { var n = Number(v); return isFinite(n) ? n : 0; };
var finite = function (v) { return v !== null && v !== undefined && isFinite(Number(v)); };
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function toGrade(s) {
    if (s >= 90) return 'A';
    if (s >= 80) return 'B+';
    if (s >= 70) return 'B';
    if (s >= 60) return 'C+';
    if (s >= 50) return 'C';
    if (s >= 40) return 'D';
    return 'F';
}
// Upstream POI names arrive wrapped in literal double quotes (every row of
// DIM_POIS.NAME), and the load pool falls back to the bare words Origin /
// Destination whenever a trip endpoint was never a POI - the majority of rows.
// Reported verbatim a chain reads "Origin -> Destination", so unwrap the quotes
// and fall back to the coordinate, which at least locates the stop.
var PLACEHOLDERS = { 'origin': 1, 'destination': 1, 'drop-off': 1, 'dropoff': 1, 'unknown': 1, 'depot': 1 };
function place(s, lon, lat) {
    var t = s ? String(s).trim() : '';
    if (t.length >= 2 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') t = t.slice(1, -1).trim();
    if (t && !PLACEHOLDERS[t.toLowerCase()]) return t;
    if (isFinite(lon) && isFinite(lat) && !(lon === 0 && lat === 0)) {
        return 'near ' + Number(lat).toFixed(2) + ', ' + Number(lon).toFixed(2);
    }
    return t || 'unknown';
}
var RUNG_LABEL = { 1: 'Own loads only', 2: 'Own load, then external',
                   3: 'External, then own load', 4: 'External on both hops' };
var RUNG_NOTE = { 1: 'Both hops came from our own waiting loads.',
                  2: 'No own load completed the return, so the second hop is external.',
                  3: 'No own load started the return, so the first hop is external.',
                  4: 'No own load fitted either hop; both come from outside.' };
// The gateway guards locations per matrix call and the engine caps the resulting
// route count. This ceiling sits far below both; a chain contributes at most 6
// points, so it admits ~25 chains per costing run.
var MAX_MATRIX_POINTS = 150;

try {
    if (!region) {
        try {
            var cr = q("SELECT REGION FROM FLEET_APP.BACKLOAD_MATCHING.VW_CONFIG LIMIT 1");
            if (cr.next()) region = cr.getColumnValue(1);
        } catch (e) { /* fall through */ }
    }
    if (!region) {
        try {
            var dr = q("SELECT REGION FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS WHERE IS_ACTIVE = TRUE LIMIT 1");
            if (dr.next()) region = dr.getColumnValue(1);
        } catch (e) { /* fall through */ }
    }
    if (!region) region = 'SanFrancisco';

    var costBasis = String(P_COST_BASIS || 'road').toLowerCase();
    if (costBasis !== 'road' && costBasis !== 'great_circle') {
        return { status: 'FAILED', reason: 'BAD_COST_BASIS', region: region,
                 error: "cost_basis must be 'road' or 'great_circle' (got " + costBasis + ")" };
    }
    var maxPerVehicle = finite(P_MAX_PER_VEHICLE) && Number(P_MAX_PER_VEHICLE) > 0
        ? Math.min(20, Math.floor(Number(P_MAX_PER_VEHICLE))) : null;
    var outLimit = finite(P_LIMIT) && Number(P_LIMIT) > 0 ? Math.min(200, Math.floor(Number(P_LIMIT))) : 25;

    // --------------------------------------------------------- class + params
    var vehicleType = 'hgv', profile = 'driving-car';
    try {
        var vr = q("SELECT VEHICLE_TYPE FROM FLEET_APP.BACKLOAD_MATCHING.VW_CONFIG LIMIT 1");
        if (vr.next()) vehicleType = String(vr.getColumnValue(1) || 'hgv');
    } catch (e) { /* default */ }
    var pr = q("SELECT ORS_PROFILE FROM FLEET_APP.BACKLOAD_MATCHING.VW_VEHICLE_CLASS WHERE VEHICLE_TYPE = ? LIMIT 1",
               [vehicleType]);
    if (pr.next()) profile = String(pr.getColumnValue(1) || 'driving-car');

    var params = {};
    try {
        var prm = q("SELECT PARAM_KEY, PARAM_VALUE FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.MATCH_PARAMS");
        while (prm.next()) params[String(prm.getColumnValue(1))] = prm.getColumnValue(2);
    } catch (e) { /* defaults below */ }
    function param(key, dflt) {
        var v = Number(params[key]);
        return isFinite(v) ? v : dflt;
    }
    var targetRadiusKm  = param('TARGET_RADIUS_KM', 250);
    var maxTotalEmptyKm = param('TRIANGLE_MAX_TOTAL_EMPTY_KM', 250);
    var maxLeg1DetourKm = param('TRIANGLE_MAX_LEG1_DETOUR_KM', 400);
    if (maxPerVehicle === null) maxPerVehicle = Math.max(1, param('MAX_TRIANGLES_PER_TRAILER', 5));
    var threshold = finite(P_ACCEPTANCE_SCORE) ? Math.max(0, Math.min(100, Number(P_ACCEPTANCE_SCORE)))
                                               : param('CASCADE_GRADE_THRESHOLD', 70);

    // ----------------------------------------------------------- chain feed
    var chains = [];
    try {
        var cs = q(
            "SELECT t.* FROM FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRIANGLES t "
          + "WHERE t.TRAILER_ID IN ("
          + "  SELECT TRAILER_ID FROM FLEET_APP.BACKLOAD_MATCHING.VW_TRAILERS WHERE REGION = ?) "
          + "ORDER BY t.TRAILER_ID, t.CASCADE_RUNG, t.NET_BENEFIT_USD DESC", [region]);
        var cols = cs.getColumnCount();
        var names = [];
        for (var ci = 1; ci <= cols; ci++) names.push(cs.getColumnName(ci));
        while (cs.next()) {
            var row = {};
            for (var cj = 0; cj < names.length; cj++) row[names[cj]] = cs.getColumnValue(cj + 1);
            chains.push(row);
        }
    } catch (e) {
        var em0 = e && e.message ? String(e.message) : 'unknown error';
        if (/does not exist or not authorized/i.test(em0)) {
            return { status: 'FAILED', reason: 'DATA_NOT_PROVISIONED', region: region,
                     error: 'The chain layer (VW_TRIANGLES) is not provisioned for the active dataset.' };
        }
        throw e;
    }
    if (!chains.length) {
        // Not an error, and specifically not "no data". Chains are a LONG-HAUL
        // pattern: in a metro region every load already delivers inside the
        // target radius, so a direct return exists and no chain is needed.
        return { status: 'SUCCESS', region: region, cost_basis: costBasis, chains: [],
                 counts: { skeletons: 0, graded: 0, returned: 0 },
                 note: 'No chain is needed for ' + region + ': every load already delivers within the '
                     + 'target radius, so a direct single-hop return exists. Chains are a long-haul '
                     + 'pattern - a wide-area region shows them.' };
    }

    // Rates. A rate of 0 would silently zero the economics, so take the first
    // STRICTLY POSITIVE of: match params, the rate the view itself costed with,
    // the documented default.
    function rate(a, b, dflt) {
        if (isFinite(a) && a > 0) return a;
        if (isFinite(b) && b > 0) return b;
        return dflt;
    }
    var costPerEmptyKm = rate(Number(params['COST_PER_EMPTY_KM']), num(chains[0].COST_PER_EMPTY_KM), 1.2);
    var revPerLoadedKm = rate(Number(params['REVENUE_PER_LOADED_KM']), num(chains[0].REV_PER_LOADED_KM), 1.1);

    function chainKey(c) { return c.TRAILER_ID + '::' + c.LEG1_LOAD_ID + '::' + c.LEG2_LOAD_ID; }

    // ------------------------------------------------------- live road costing
    // ONE matrix call over every distinct point in the candidate set; each leg is
    // then a lookup. The same matrix yields the baseline (empty straight to
    // target) AND the residual run, so the comparison is road-against-road rather
    // than one road figure against one straight line.
    // MATRIX_TABULAR takes (profile, ORIGIN coords, DESTINATION coords, region)
    // and derives sources/destinations from the two arrays' LENGTHS, so a square
    // matrix means passing the same list twice. Distances come back in metres.
    var roadByKey = {}, deferred = 0, costed = 0;
    if (costBasis === 'road') {
        var idx = {}, pts = [], mapped = [];
        var add = function (lon, lat) {
            var k = Number(lon).toFixed(5) + ',' + Number(lat).toFixed(5);
            if (k in idx) return idx[k];
            var i = pts.length;
            pts.push([Number(lon), Number(lat)]);
            idx[k] = i;
            return i;
        };
        for (var mi = 0; mi < chains.length; mi++) {
            var mc = chains[mi];
            // A chain contributes at most 6 points; stop BEFORE overshooting.
            // Truncating the matrix instead would return short rows and silently
            // mis-cost the legs that fell off the end.
            if (pts.length + 6 > MAX_MATRIX_POINTS) { deferred += 1; continue; }
            mapped.push({
                c: mc,
                iEmpty: add(num(mc.EMPTY_LON), num(mc.EMPTY_LAT)),
                iP1: add(num(mc.LEG1_PICKUP_LON), num(mc.LEG1_PICKUP_LAT)),
                iD1: add(num(mc.LEG1_DELIVERY_LON), num(mc.LEG1_DELIVERY_LAT)),
                iP2: add(num(mc.LEG2_PICKUP_LON), num(mc.LEG2_PICKUP_LAT)),
                iD2: add(num(mc.LEG2_DELIVERY_LON), num(mc.LEG2_DELIVERY_LAT)),
                iTgt: add(num(mc.TARGET_LON), num(mc.TARGET_LAT))
            });
        }
        var parts = [];
        for (var pi = 0; pi < pts.length; pi++) parts.push('ARRAY_CONSTRUCT(' + pts[pi][0] + ', ' + pts[pi][1] + ')');
        var coords = 'ARRAY_CONSTRUCT(' + parts.join(', ') + ')';
        var dist = null;
        try {
            var ms = q("SELECT TO_VARCHAR(M:distances) AS D FROM (SELECT "
                     + "OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(?, " + coords + ", " + coords + ", ?) AS M)",
                       [profile, region]);
            var draw = ms.next() ? ms.getColumnValue(1) : null;
            if (draw) { try { dist = JSON.parse(draw); } catch (e) { dist = null; } }
        } catch (e) {
            var em1 = e && e.message ? String(e.message) : 'unknown error';
            return { status: 'FAILED', reason: 'OPTIMIZATION_UNAVAILABLE', region: region,
                     error: 'The routing engine could not price the chain legs for ' + region
                          + ' (' + em1 + '). It may be suspended or starting - resume it and retry, '
                          + "or pass cost_basis='great_circle' for ungraded straight-line skeletons." };
        }
        if (!dist || !dist.length || !dist[0] || !dist[0].length) {
            return { status: 'FAILED', reason: 'OPTIMIZATION_UNAVAILABLE', region: region,
                     error: 'The routing engine returned no distance matrix, so chain legs cannot be '
                          + 'priced on the road network. Check that the region services are running, '
                          + "or pass cost_basis='great_circle' for ungraded straight-line skeletons." };
        }
        var km = function (a, b) {
            var v = (dist[a] && dist[a][b] !== undefined) ? dist[a][b] : null;
            return (typeof v === 'number' && isFinite(v)) ? v / 1000 : null;
        };
        for (var xi = 0; xi < mapped.length; xi++) {
            var mp = mapped[xi];
            roadByKey[chainKey(mp.c)] = {
                e1: km(mp.iEmpty, mp.iP1), loaded1: km(mp.iP1, mp.iD1),
                e2: km(mp.iD1, mp.iP2), loaded2: km(mp.iP2, mp.iD2),
                residual: km(mp.iD2, mp.iTgt), baseline: km(mp.iEmpty, mp.iTgt)
            };
        }
        costed = mapped.length;
    }

    // ------------------------------------------------------------- grade them
    var graded = [];
    for (var gi = 0; gi < chains.length; gi++) {
        var c = chains[gi];
        var r = roadByKey[chainKey(c)] || null;
        var roadE1 = r ? r.e1 : null, roadL1 = r ? r.loaded1 : null;
        var roadE2 = r ? r.e2 : null, roadL2 = r ? r.loaded2 : null;
        var roadRes = r ? r.residual : null;
        var roadEmpty = (roadE1 !== null && roadE2 !== null && roadRes !== null) ? roadE1 + roadE2 + roadRes : null;
        var roadLoaded = (roadL1 !== null && roadL2 !== null) ? roadL1 + roadL2 : null;

        // Residual-INCLUSIVE, because the baseline is a complete run home.
        var emptyKm = (roadEmpty !== null) ? roadEmpty : num(c.TOTAL_EMPTY_WITH_RESIDUAL_KM);
        var loadedKm = (roadLoaded !== null) ? roadLoaded : num(c.TOTAL_LOADED_KM);
        var residualKm = (roadRes !== null) ? roadRes : num(c.FINAL_GAP_KM);
        var baselineEmptyKm = (r && r.baseline !== null) ? r.baseline : num(c.TARGET_GAP_KM);

        var netUsd = loadedKm * revPerLoadedKm - emptyKm * costPerEmptyKm;
        // The status quo earns nothing and still burns the empty run home.
        var baselineNetUsd = -baselineEmptyKm * costPerEmptyKm;

        // TOTAL_EMPTY_CHECK is defined on the TWO-LEG subtotal, which is what
        // MAX_TOTAL_EMPTY_KM was calibrated against. Keep it that way, or the
        // chips re-prune against a figure they were never set for.
        var twoLegEmpty = (roadE1 !== null && roadE2 !== null) ? roadE1 + roadE2 : num(c.TOTAL_EMPTY_KM);
        var totalEmptyOk = twoLegEmpty <= maxTotalEmptyKm;
        var leg1DetourOk = ((roadE1 !== null) ? roadE1 : num(c.LEG1_EMPTY_KM)) <= maxLeg1DetourKm;
        var targetOk = residualKm <= targetRadiusKm;
        // Hop ordering is structural (enforced by the join), so it cannot be
        // relaxed here - carry the view's verdict through unchanged.
        var sequenceOk = c.SEQUENCE_CHECK === true;
        var eligible = totalEmptyOk && leg1DetourOk && targetOk && sequenceOk;

        var util = loadedKm / Math.max(1, loadedKm + emptyKm);
        var saved = baselineEmptyKm > 0 ? clamp01((baselineEmptyKm - emptyKm) / baselineEmptyKm) : 0;
        var closed = clamp01((num(c.TARGET_GAP_KM) - residualKm) / Math.max(1, num(c.TARGET_GAP_KM)));
        var score = Math.max(0, Math.min(100, 100 * (0.45 * util + 0.35 * closed + 0.20 * saved)));

        graded.push({
            c: c, key: chainKey(c), rung: num(c.CASCADE_RUNG),
            emptyKm: emptyKm, loadedKm: loadedKm, residualKm: residualKm,
            twoLegEmptyKm: twoLegEmpty,
            baselineEmptyKm: baselineEmptyKm, emptySavedKm: baselineEmptyKm - emptyKm,
            netUsd: netUsd, baselineNetUsd: baselineNetUsd, beatsBaseline: netUsd > baselineNetUsd,
            totalEmptyOk: totalEmptyOk, leg1DetourOk: leg1DetourOk,
            targetOk: targetOk, sequenceOk: sequenceOk, eligible: eligible,
            score: score, grade: (costBasis === 'road') ? toGrade(score) : null,
            costedOnRoad: r !== null
        });
    }

    // ----------------------------------------------------------- the cascade
    // Applied ONLY on road figures: stopping the ladder on a straight-line
    // estimate would commit to a rung the road network may contradict.
    var rungReached = null;
    if (costBasis === 'road') {
        for (var rr = 1; rr <= 4; rr++) {
            for (var ri2 = 0; ri2 < graded.length; ri2++) {
                if (graded[ri2].eligible && graded[ri2].rung === rr && graded[ri2].score >= threshold) {
                    rungReached = rr; break;
                }
            }
            if (rungReached !== null) break;
        }
    }
    var shown = [];
    for (var si = 0; si < graded.length; si++) {
        if (rungReached !== null && graded[si].rung > rungReached) continue;
        shown.push(graded[si]);
    }
    shown.sort(function (a, b) {
        return String(a.c.TRAILER_ID).localeCompare(String(b.c.TRAILER_ID))
            || (a.rung - b.rung) || (b.score - a.score) || (b.netUsd - a.netUsd);
    });
    // Per-vehicle cap applies to the RANKED chains, so lowering it keeps each
    // vehicle's best rather than an arbitrary slice.
    var seen = {}, capped = [];
    for (var ki = 0; ki < shown.length; ki++) {
        var vid = String(shown[ki].c.TRAILER_ID);
        var n = (seen[vid] || 0) + 1;
        seen[vid] = n;
        if (n <= maxPerVehicle) capped.push(shown[ki]);
    }

    var out = [], beats = 0, savingEmpty = 0, sumSaved = 0, sumNet = 0;
    for (var oi = 0; oi < capped.length; oi++) {
        var g = capped[oi], gc = g.c;
        if (g.beatsBaseline) beats++;
        if (g.emptySavedKm > 0) savingEmpty++;
        sumSaved += g.emptySavedKm;
        sumNet += g.netUsd;
        if (out.length >= outLimit) continue;
        out.push({
            vehicle_id: gc.TRAILER_ID,
            cascade_rung: g.rung, cascade_rung_label: RUNG_LABEL[g.rung] || null,
            grade: g.grade, score: Math.round(g.score * 10) / 10,
            eligible: g.eligible, costed_on_road: g.costedOnRoad,
            availability_basis: gc.AVAILABILITY_BASIS,
            from: place(gc.EMPTY_CITY, num(gc.EMPTY_LON), num(gc.EMPTY_LAT)),
            target: place(gc.TARGET_LABEL, num(gc.TARGET_LON), num(gc.TARGET_LAT)),
            target_gap_km: Math.round(num(gc.TARGET_GAP_KM)),
            hop1: {
                load_id: gc.LEG1_LOAD_ID, is_internal: gc.LEG1_IS_INTERNAL === true,
                source: gc.LEG1_SOURCE_SYSTEM,
                pickup: place(gc.LEG1_PICKUP_CITY, num(gc.LEG1_PICKUP_LON), num(gc.LEG1_PICKUP_LAT)),
                delivery: place(gc.LEG1_DELIVERY_CITY, num(gc.LEG1_DELIVERY_LON), num(gc.LEG1_DELIVERY_LAT)),
                empty_km: Math.round(num(gc.LEG1_EMPTY_KM)), loaded_km: Math.round(num(gc.LEG1_LOADED_KM))
            },
            hop2: {
                load_id: gc.LEG2_LOAD_ID, is_internal: gc.LEG2_IS_INTERNAL === true,
                source: gc.LEG2_SOURCE_SYSTEM,
                pickup: place(gc.LEG2_PICKUP_CITY, num(gc.LEG2_PICKUP_LON), num(gc.LEG2_PICKUP_LAT)),
                delivery: place(gc.LEG2_DELIVERY_CITY, num(gc.LEG2_DELIVERY_LON), num(gc.LEG2_DELIVERY_LAT)),
                empty_km: Math.round(num(gc.LEG2_EMPTY_KM)), loaded_km: Math.round(num(gc.LEG2_LOADED_KM))
            },
            // empty_km is residual-inclusive and is the figure comparable with
            // baseline_empty_km. two_leg_empty_km is the subtotal the constraint
            // checks use; never compare THAT with the baseline.
            empty_km: Math.round(g.emptyKm), two_leg_empty_km: Math.round(g.twoLegEmptyKm),
            loaded_km: Math.round(g.loadedKm), residual_km: Math.round(g.residualKm),
            baseline_empty_km: Math.round(g.baselineEmptyKm),
            empty_saved_km: Math.round(g.emptySavedKm),
            net_usd: Math.round(g.netUsd), baseline_net_usd: Math.round(g.baselineNetUsd),
            beats_baseline: g.beatsBaseline,
            constraints: { total_empty: g.totalEmptyOk, leg1_detour: g.leg1DetourOk,
                           target: g.targetOk, sequence: g.sequenceOk }
        });
    }

    var cascadeNote;
    if (costBasis !== 'road') {
        cascadeNote = 'Not applied: chains are still on straight-line estimates. Re-run with '
                    + "cost_basis='road' to grade them and apply the internal-first cascade.";
    } else if (rungReached === null) {
        cascadeNote = 'No rung reached the acceptance score of ' + threshold + ', so the cascade cut was '
                    + 'NOT applied and every rung is returned as a near miss. Raising the score can '
                    + 'therefore return MORE chains, not fewer.';
    } else {
        cascadeNote = 'Stopped at rung ' + rungReached + ' (' + RUNG_LABEL[rungReached] + '). '
                    + RUNG_NOTE[rungReached];
    }

    return {
        status: 'SUCCESS', region: region, vehicle_type: vehicleType, profile: profile,
        cost_basis: costBasis, acceptance_score: threshold,
        cascade: { rung_reached: rungReached, label: rungReached ? RUNG_LABEL[rungReached] : null,
                   note: cascadeNote },
        counts: { skeletons: chains.length, graded: graded.length, after_cascade: shown.length,
                  after_per_vehicle_cap: capped.length, returned: out.length,
                  costed_on_road: costed, deferred_over_matrix_limit: deferred },
        totals: { chains_beating_baseline: beats, chains_saving_empty_km: savingEmpty,
                  total_empty_saved_km: Math.round(sumSaved), total_net_usd: Math.round(sumNet) },
        economics: { cost_per_empty_km: costPerEmptyKm, revenue_per_loaded_km: revPerLoadedKm },
        envelope: { target_radius_km: targetRadiusKm, max_total_empty_km: maxTotalEmptyKm,
                    max_leg1_detour_km: maxLeg1DetourKm, max_per_vehicle: maxPerVehicle },
        chains: out
    };
} catch (err) {
    var em = (err && err.message) ? String(err.message) : 'unknown error';
    return { status: 'FAILED', reason: 'ERROR', region: region, error: em };
}
$$;
ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_BACKLOAD_CHAIN_SOLVE(VARCHAR, VARCHAR, FLOAT, FLOAT, FLOAT) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Validation
SELECT 'TOOL_DIRECTIONS' AS OBJECT, 'PROCEDURE' AS TYPE FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_DIRECTIONS'
UNION ALL SELECT 'TOOL_ISOCHRONE', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_ISOCHRONE'
UNION ALL SELECT 'TOOL_POI_IN_ISOCHRONE', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_POI_IN_ISOCHRONE'
UNION ALL SELECT 'TOOL_ROUTE_OPTIMIZATION', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_ROUTE_OPTIMIZATION'
UNION ALL SELECT 'TOOL_NETWORK_OPTIMIZATION', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_NETWORK_OPTIMIZATION'
UNION ALL SELECT 'TOOL_DELIVERY_OPTIMIZATION', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_DELIVERY_OPTIMIZATION'
UNION ALL SELECT 'TOOL_CATCHMENT', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_CATCHMENT'
UNION ALL SELECT 'TOOL_SAP_INTROSPECT', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_SAP_INTROSPECT'
UNION ALL SELECT 'TOOL_BACKLOAD_SOLVE', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_BACKLOAD_SOLVE'
UNION ALL SELECT 'TOOL_BACKLOAD_CHAIN_SOLVE', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_BACKLOAD_CHAIN_SOLVE';
