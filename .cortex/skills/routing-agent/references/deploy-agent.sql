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
        opt_result = session.sql(opt_query).collect()[0]['RESULT']
        opt_data = json.loads(opt_result) if isinstance(opt_result, str) else opt_result

        if 'error' in opt_data:
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
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED', jobs: jobDetails, region: region,
                 requested_profile: PROFILE, used_profile: usedProfile,
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
    return { error: err.message, status: 'FAILED' };
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
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED', region: region,
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
    return { error: err.message, status: 'FAILED' };
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
        return { error: 'Isochrone returned no results for this location', status: 'FAILED',
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
    return { error: err.message, status: 'FAILED' };
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
        return { status: 'FAILED', region: region, error: 'OPTIMIZATION returned no results (check participant routability / region graph).' };
    }
    if (response === null) response = {};
    return {
        status: 'SUCCESS', region: region,
        routes: response.routes || [], unassigned: response.unassigned || [],
        summary: response.summary || {},
        geometry: { type: 'FeatureCollection', features: features }
    };
} catch(err) {
    return { status: 'FAILED', error: err.message };
}
$$;
ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_EVAC_SOLVE(VARCHAR, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-emergency-response","version":{"major":2,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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

-- Validation
SELECT 'TOOL_DIRECTIONS' AS OBJECT, 'PROCEDURE' AS TYPE FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_DIRECTIONS'
UNION ALL SELECT 'TOOL_ISOCHRONE', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_ISOCHRONE'
UNION ALL SELECT 'TOOL_POI_IN_ISOCHRONE', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_POI_IN_ISOCHRONE'
UNION ALL SELECT 'TOOL_ROUTE_OPTIMIZATION', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_ROUTE_OPTIMIZATION'
UNION ALL SELECT 'TOOL_NETWORK_OPTIMIZATION', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_NETWORK_OPTIMIZATION'
UNION ALL SELECT 'TOOL_DELIVERY_OPTIMIZATION', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_DELIVERY_OPTIMIZATION'
UNION ALL SELECT 'TOOL_CATCHMENT', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_CATCHMENT'
UNION ALL SELECT 'TOOL_SAP_INTROSPECT', 'PROCEDURE' FROM FLEET_INTELLIGENCE.INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_SAP_INTROSPECT';
