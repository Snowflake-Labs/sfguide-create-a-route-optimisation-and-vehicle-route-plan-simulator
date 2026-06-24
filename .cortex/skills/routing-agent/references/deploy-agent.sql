/*
 * deploy-agent.sql — Routing TOOL_* procedures
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
-- built profile, else driving-car, else the first available — and the agent
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
    REGION VARCHAR DEFAULT 'California'
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
-- TOOL_NETWORK_OPTIMIZATION: Distribution-network delivery plan (config-driven demo).
-- Reads DEMO_KEY_SITES, DEMO_AREA_DEMOGRAPHICS, DEMO_DEMAND_CATALOG and the
-- depot/region from DEMO_DEPOT (created by setup-agent-playground). Builds a
-- 3-vehicle VROOM payload and returns the optimized routes with
-- demand-signal-derived item demand. The proc compiles lazily, so it can be
-- created BEFORE the data tables exist — but it will only execute correctly
-- once setup-agent-playground has been run.
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_NETWORK_OPTIMIZATION(
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
try {
    var depotLon = -122.3946;
    var depotLat = 37.7941;
    var depotName = 'Central Supply Depot';
    var region = 'SanFrancisco';
    try {
        var depotStmt = snowflake.createStatement({
            sqlText: "SELECT LONGITUDE, LATITUDE, NAME, REGION " +
                     "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEPOT ORDER BY DEPOT_ID LIMIT 1"
        });
        var depotRes = depotStmt.execute();
        if (depotRes.next()) {
            depotLon = depotRes.getColumnValue(1); depotLat = depotRes.getColumnValue(2);
            depotName = depotRes.getColumnValue(3); region = depotRes.getColumnValue(4);
        }
    } catch(e) { /* fall back to defaults */ }

    // Resolve the requested profile against the profiles actually built in the
    // region (best-effort; ORS_STATUS failure -> [] -> rename-only behavior).
    // The 2-arg SQL UDF is the single resolver + substitution detector.
    var available = [];
    try {
        var avStmt = snowflake.createStatement({
            sqlText: "SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(?):profiles)",
            binds: [region]
        });
        var avRes = avStmt.execute();
        if (avRes.next()) {
            var avRaw = avRes.getColumnValue(1);
            available = avRaw ? ((typeof avRaw === 'string') ? JSON.parse(avRaw) : avRaw) : [];
        }
    } catch(e) { available = []; }
    var profRes = {};
    try {
        var prStmt = snowflake.createStatement({
            sqlText: "SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(?, PARSE_JSON(?)::ARRAY)",
            binds: [PROFILE, JSON.stringify(available)]
        });
        var prRes = prStmt.execute();
        if (prRes.next()) {
            var prRaw = prRes.getColumnValue(1);
            profRes = prRaw ? ((typeof prRaw === 'string') ? JSON.parse(prRaw) : prRaw) : {};
        }
    } catch(e) { profRes = {}; }
    var usedProfile = profRes.used || 'driving-car';
    var profSubstituted = (profRes.substituted === undefined) ? null : profRes.substituted;
    var profNote = (profRes.note === undefined) ? null : profRes.note;

    var siteStmt = snowflake.createStatement({
        sqlText: "SELECT SITE_ID, NAME, ADDRESS, LONGITUDE, LATITUDE, PRIORITY " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_KEY_SITES ORDER BY PRIORITY"
    });
    var siteRes = siteStmt.execute();
    var sites = [];
    while (siteRes.next()) {
        sites.push({
            id: siteRes.getColumnValue(1),
            name: siteRes.getColumnValue(2),
            address: siteRes.getColumnValue(3),
            longitude: siteRes.getColumnValue(4),
            latitude: siteRes.getColumnValue(5),
            priority: siteRes.getColumnValue(6)
        });
    }

    var itemStmt = snowflake.createStatement({
        sqlText: "SELECT ITEM_ID, SEGMENT, ITEM_NAME, ITEM_CATEGORY, DELIVERY_SKILL, " +
                 "SKILL_LABEL, UNITS_PER_1000, PRIORITY " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEMAND_CATALOG ORDER BY PRIORITY"
    });
    var itemRes = itemStmt.execute();
    var catalog = [];
    while (itemRes.next()) {
        catalog.push({
            item_id: itemRes.getColumnValue(1),
            segment: itemRes.getColumnValue(2),
            item_name: itemRes.getColumnValue(3),
            item_category: itemRes.getColumnValue(4),
            delivery_skill: itemRes.getColumnValue(5),
            skill_label: itemRes.getColumnValue(6),
            units_per_1000: itemRes.getColumnValue(7),
            priority: itemRes.getColumnValue(8)
        });
    }

    var demoStmt = snowflake.createStatement({
        sqlText: "SELECT NEIGHBORHOOD, TOTAL_POPULATION, DIABETES_PCT, HYPERTENSION_PCT, " +
                 "CARDIOVASCULAR_PCT, RESPIRATORY_PCT, MOBILITY_ISSUES_PCT " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_AREA_DEMOGRAPHICS"
    });
    var demoRes = demoStmt.execute();
    var seg1 = 0, seg2 = 0, seg3 = 0, seg4 = 0, seg5 = 0, totalPop = 0;
    while (demoRes.next()) {
        var pop = demoRes.getColumnValue(2);
        totalPop += pop;
        seg1 += demoRes.getColumnValue(3) * pop / 100;
        seg2 += demoRes.getColumnValue(4) * pop / 100;
        seg3 += demoRes.getColumnValue(5) * pop / 100;
        seg4 += demoRes.getColumnValue(6) * pop / 100;
        seg5 += demoRes.getColumnValue(7) * pop / 100;
    }

    var priorityWeights = { 1: 0.25, 2: 0.15, 3: 0.10 };
    var vroomJobs = [];
    var jobDetails = [];
    var jobId = 1;

    for (var p = 0; p < sites.length; p++) {
        var site = sites[p];
        var weight = priorityWeights[site.priority] || 0.10;
        var primarySkill = (p % 3) + 1;

        var segments = {
            'DIABETES': seg1 * weight,
            'HYPERTENSION': seg2 * weight,
            'CARDIOVASCULAR': seg3 * weight,
            'RESPIRATORY': seg4 * weight,
            'MOBILITY': seg5 * weight
        };

        var siteOrders = [];
        for (var d = 0; d < catalog.length; d++) {
            var item = catalog[d];
            if (item.delivery_skill !== primarySkill) continue;
            var segPop = segments[item.segment] || 0;
            var units = Math.round(segPop / 1000 * item.units_per_1000);
            if (units > 0) {
                siteOrders.push({
                    item_name: item.item_name, item_category: item.item_category,
                    skill: item.delivery_skill, skill_label: item.skill_label,
                    units: units, priority: item.priority
                });
            }
        }
        siteOrders.sort(function(a, b) { return a.priority - b.priority || b.units - a.units; });
        var topOrders = siteOrders.slice(0, 5);

        if (topOrders.length > 0) {
            var itemNames = topOrders.map(function(o2) { return o2.item_name; });
            var totalUnits = 0;
            for (var t = 0; t < topOrders.length; t++) totalUnits += topOrders[t].units;

            vroomJobs.push({
                id: jobId,
                location: [site.longitude, site.latitude],
                amount: [1], skills: [primarySkill],
                description: site.name + ' - ' + topOrders[0].skill_label + ': ' + itemNames.join(', ')
            });
            jobDetails.push({
                job_id: jobId, site: site.name, name: site.name, address: site.address,
                longitude: site.longitude, latitude: site.latitude,
                skill: primarySkill, skill_label: topOrders[0].skill_label,
                items: itemNames, total_units: totalUnits
            });
            jobId++;
        }
    }

    var vehicles = [
        { id: 1, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [vroomJobs.length], skills: [1],
          description: 'Cold Chain Vehicle (Refrigerated goods)' },
        { id: 2, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [vroomJobs.length], skills: [2],
          description: 'Restricted / Controlled Goods Vehicle' },
        { id: 3, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [vroomJobs.length], skills: [3],
          description: 'Standard Delivery Vehicle' }
    ];

    var vroomPayload = JSON.stringify({ jobs: vroomJobs, vehicles: vehicles });
    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, region] });
    var optRes = optStmt.execute();
    if (!optRes.next()) {
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED', jobs: jobDetails,
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
    var skill1Jobs = jobDetails.filter(function(j) { return j.skill === 1; });
    var skill2Jobs = jobDetails.filter(function(j) { return j.skill === 2; });
    var skill3Jobs = jobDetails.filter(function(j) { return j.skill === 3; });

    return {
        status: 'SUCCESS', num_vehicles: 3,
        total_jobs: vroomJobs.length, sites_served: sites.length,
        requested_profile: PROFILE, used_profile: usedProfile,
        profile_substituted: profSubstituted, profile_note: profNote,
        jobs: jobDetails, vehicles: vehicles,
        routes: routesWithGeometry, unassigned: response.unassigned || [],
        depot: { longitude: depotLon, latitude: depotLat, name: depotName },
        geometry: geojson,
        demand_summary: {
            cold_chain_stops: skill1Jobs.length,
            restricted_stops: skill2Jobs.length,
            standard_stops: skill3Jobs.length,
            cold_chain_items: skill1Jobs.map(function(j) { return j.items; }).reduce(function(a, b) { return a.concat(b); }, []),
            restricted_items: skill2Jobs.map(function(j) { return j.items; }).reduce(function(a, b) { return a.concat(b); }, []),
            standard_items: skill3Jobs.map(function(j) { return j.items; }).reduce(function(a, b) { return a.concat(b); }, [])
        },
        demand_basis: {
            total_population: totalPop,
            segment_1_demand: Math.round(seg1),
            segment_2_demand: Math.round(seg2),
            segment_3_demand: Math.round(seg3),
            segment_4_demand: Math.round(seg4),
            segment_5_demand: Math.round(seg5)
        }
    };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_NETWORK_OPTIMIZATION(VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

----------------------------------------------------------------------
-- TOOL_DELIVERY_OPTIMIZATION: Pre-geocoded fleet delivery demo.
-- 30 stops with 3 skill-tier vehicles (cold chain, restricted, standard).
-- Reads DEMO_DELIVERY_STOPS and depot/region from DEMO_DEPOT
-- (created by setup-agent-playground).
----------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_DELIVERY_OPTIMIZATION(
    PROFILE VARCHAR DEFAULT 'driving-car'
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
EXECUTE AS OWNER
AS
$$
try {
    var depotLon = -122.3946;
    var depotLat =  37.7941;
    var depotName = 'Central Supply Depot';
    var region = 'SanFrancisco';
    try {
        var depotStmt = snowflake.createStatement({
            sqlText: "SELECT LONGITUDE, LATITUDE, NAME, REGION " +
                     "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEPOT ORDER BY DEPOT_ID LIMIT 1"
        });
        var depotRes = depotStmt.execute();
        if (depotRes.next()) {
            depotLon = depotRes.getColumnValue(1); depotLat = depotRes.getColumnValue(2);
            depotName = depotRes.getColumnValue(3); region = depotRes.getColumnValue(4);
        }
    } catch(e) { /* fall back to defaults */ }

    // Resolve the requested profile against the profiles actually built in the
    // region (best-effort; ORS_STATUS failure -> [] -> rename-only behavior).
    var available = [];
    try {
        var avStmt = snowflake.createStatement({
            sqlText: "SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(?):profiles)",
            binds: [region]
        });
        var avRes = avStmt.execute();
        if (avRes.next()) {
            var avRaw = avRes.getColumnValue(1);
            available = avRaw ? ((typeof avRaw === 'string') ? JSON.parse(avRaw) : avRaw) : [];
        }
    } catch(e) { available = []; }
    var profRes = {};
    try {
        var prStmt = snowflake.createStatement({
            sqlText: "SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(?, PARSE_JSON(?)::ARRAY)",
            binds: [PROFILE, JSON.stringify(available)]
        });
        var prRes = prStmt.execute();
        if (prRes.next()) {
            var prRaw = prRes.getColumnValue(1);
            profRes = prRaw ? ((typeof prRaw === 'string') ? JSON.parse(prRaw) : prRaw) : {};
        }
    } catch(e) { profRes = {}; }
    var usedProfile = profRes.used || 'driving-car';
    var profSubstituted = (profRes.substituted === undefined) ? null : profRes.substituted;
    var profNote = (profRes.note === undefined) ? null : profRes.note;

    var jobsStmt = snowflake.createStatement({
        sqlText: "SELECT JOB_ID, NAME, ADDRESS, LONGITUDE, LATITUDE, SKILL, SKILL_LABEL, AMOUNT " +
                 "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DELIVERY_STOPS ORDER BY JOB_ID"
    });
    var jobsRes = jobsStmt.execute();
    var vroomJobs = [];
    var jobMeta = [];
    while (jobsRes.next()) {
        var id = jobsRes.getColumnValue(1);
        var name = jobsRes.getColumnValue(2);
        var address = jobsRes.getColumnValue(3);
        var lon = jobsRes.getColumnValue(4);
        var lat = jobsRes.getColumnValue(5);
        var skill = jobsRes.getColumnValue(6);
        var skillLbl = jobsRes.getColumnValue(7);
        var amount = jobsRes.getColumnValue(8);
        vroomJobs.push({ id: id, location: [lon, lat], amount: [amount], skills: [skill], description: name });
        jobMeta.push({ name: name, address: address, longitude: lon, latitude: lat, skill: skill, skill_label: skillLbl });
    }
    if (vroomJobs.length === 0) {
        return { error: 'No jobs found in DEMO_DELIVERY_STOPS table. Run setup-agent-playground first.', status: 'FAILED',
                 requested_profile: PROFILE, used_profile: usedProfile,
                 profile_substituted: profSubstituted, profile_note: profNote };
    }
    var vehicles = [
        { id: 1, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [12], skills: [1],
          description: 'Cold Chain Vehicle (Refrigerated)' },
        { id: 2, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [12], skills: [2],
          description: 'Restricted / Controlled Goods Vehicle' },
        { id: 3, start: [depotLon, depotLat], end: [depotLon, depotLat],
          profile: usedProfile, capacity: [12], skills: [3],
          description: 'Standard Delivery Vehicle' }
    ];
    var vroomPayload = JSON.stringify({ jobs: vroomJobs, vehicles: vehicles });
    var optSQL = "SELECT o.RESPONSE, ST_ASGEOJSON(o.GEOJSON) AS GEOJSON " +
                 "FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON(?), ?)) o LIMIT 1";
    var optStmt = snowflake.createStatement({ sqlText: optSQL, binds: [vroomPayload, region] });
    var optRes = optStmt.execute();
    if (!optRes.next()) {
        return { error: 'OPTIMIZATION returned no results', status: 'FAILED',
                 requested_profile: PROFILE, used_profile: usedProfile,
                 profile_substituted: profSubstituted, profile_note: profNote };
    }
    var rawResp = optRes.getColumnValue(1);
    var response = (typeof rawResp === 'string') ? JSON.parse(rawResp || '{}') : (rawResp || {});
    var geojsonRaw = optRes.getColumnValue(2);
    var geojson = geojsonRaw ? ((typeof geojsonRaw === 'string') ? JSON.parse(geojsonRaw) : geojsonRaw) : null;
    return {
        status: 'SUCCESS', num_vehicles: 3,
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
-- Reads DEMO_AREA_DEMOGRAPHICS and the active region from DEMO_DEPOT.
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
try {
    var region = 'SanFrancisco';
    try {
        var depotStmt = snowflake.createStatement({
            sqlText: "SELECT REGION FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_DEPOT ORDER BY DEPOT_ID LIMIT 1"
        });
        var depotRes = depotStmt.execute();
        if (depotRes.next()) { region = depotRes.getColumnValue(1) || region; }
    } catch(e) { /* fall back to default region */ }

    // Resolve the requested profile against the profiles actually built in the
    // default region (best-effort; ORS_STATUS failure -> [] -> rename-only
    // behavior), mirroring the geocoding tools. The 2-arg SQL UDF is the single
    // resolver + substitution detector.
    var available = [];
    try {
        var avStmt = snowflake.createStatement({
            sqlText: "SELECT OBJECT_KEYS(OPENROUTESERVICE_APP.CORE.ORS_STATUS(NULL):profiles)"
        });
        var avRes = avStmt.execute();
        if (avRes.next()) {
            var avRaw = avRes.getColumnValue(1);
            available = avRaw ? ((typeof avRaw === 'string') ? JSON.parse(avRaw) : avRaw) : [];
        }
    } catch(e) { available = []; }
    var profRes = {};
    try {
        var prStmt = snowflake.createStatement({
            sqlText: "SELECT FLEET_INTELLIGENCE.ROUTING_TOOLS.RESOLVE_PROFILE(?, PARSE_JSON(?)::ARRAY)",
            binds: [PROFILE, JSON.stringify(available)]
        });
        var prRes = prStmt.execute();
        if (prRes.next()) {
            var prRaw = prRes.getColumnValue(1);
            profRes = prRaw ? ((typeof prRaw === 'string') ? JSON.parse(prRaw) : prRaw) : {};
        }
    } catch(e) { profRes = {}; }
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
        return { error: 'Could not geocode site location', status: 'FAILED' };
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
        return { error: 'Isochrone returned no results for this location', status: 'FAILED' };
    }
    var isoGeoRaw = isoRes.getColumnValue(1);
    var areaM2 = isoRes.getColumnValue(2) || 0;
    var areaKm2 = Math.round(areaM2 / 1000000 * 100) / 100;
    var isoGeojson = isoGeoRaw ? ((typeof isoGeoRaw === 'string') ? JSON.parse(isoGeoRaw) : isoGeoRaw) : null;
    if (!isoGeojson) {
        return { error: 'Isochrone geometry is null', status: 'FAILED' };
    }
    var isoGeojsonStr = JSON.stringify(isoGeojson).replace(/'/g, "''");
    var demoSQL = "SELECT DEMO_ID, NEIGHBORHOOD, LATITUDE, LONGITUDE, TOTAL_POPULATION, " +
                  "PCT_ELDERLY, PCT_CHILDREN, DIABETES_PCT, HYPERTENSION_PCT, " +
                  "CARDIOVASCULAR_PCT, RESPIRATORY_PCT, MOBILITY_ISSUES_PCT, " +
                  "INCOME_BRACKET, CAR_OWNERSHIP_PCT, TRANSIT_ACCESS " +
                  "FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.DEMO_AREA_DEMOGRAPHICS " +
                  "WHERE ST_WITHIN(" +
                  "  TO_GEOGRAPHY(OBJECT_CONSTRUCT('type','Point','coordinates',ARRAY_CONSTRUCT(LONGITUDE::FLOAT,LATITUDE::FLOAT)))," +
                  "  TO_GEOGRAPHY('" + isoGeojsonStr + "')" +
                  ") ORDER BY TOTAL_POPULATION DESC";
    var demoStmt = snowflake.createStatement({ sqlText: demoSQL });
    var demoRes = demoStmt.execute();
    var neighbourhoods = [];
    var totalPop = 0, totalDiabetes = 0, totalHypertension = 0;
    var totalCardio = 0, totalRespiratory = 0, totalMobility = 0;
    var totalElderly = 0, totalChildren = 0, totalLowCar = 0;
    var lowIncome = 0, medIncome = 0, highIncome = 0;
    while (demoRes.next()) {
        var pop = demoRes.getColumnValue(5);
        var diab = demoRes.getColumnValue(8);
        var hyp = demoRes.getColumnValue(9);
        var card = demoRes.getColumnValue(10);
        var resp = demoRes.getColumnValue(11);
        var mob = demoRes.getColumnValue(12);
        var inc = demoRes.getColumnValue(13);
        var car = demoRes.getColumnValue(14);
        var eld = demoRes.getColumnValue(6);
        var chi = demoRes.getColumnValue(7);
        var riskScore = Math.min(100, Math.round(diab * 1.5 + hyp * 0.8 + card * 1.2 + mob * 0.9));
        neighbourhoods.push({
            id: demoRes.getColumnValue(1), neighborhood: demoRes.getColumnValue(2),
            latitude: demoRes.getColumnValue(3), longitude: demoRes.getColumnValue(4),
            population: pop, pct_elderly: eld, pct_children: chi,
            diabetes_pct: diab, hypertension_pct: hyp, cardiovascular_pct: card,
            respiratory_pct: resp, mobility_issues_pct: mob,
            income_bracket: inc, car_ownership_pct: car,
            transit_access: demoRes.getColumnValue(15), risk_score: riskScore
        });
        totalPop += pop;
        totalDiabetes += diab * pop;
        totalHypertension += hyp * pop;
        totalCardio += card * pop;
        totalRespiratory += resp * pop;
        totalMobility += mob * pop;
        totalElderly += eld * pop;
        totalChildren += chi * pop;
        totalLowCar += (100 - car) * pop;
        if (inc === 'LOW') lowIncome += pop;
        else if (inc === 'MEDIUM') medIncome += pop;
        else highIncome += pop;
    }
    if (neighbourhoods.length === 0) {
        return {
            status: 'SUCCESS',
            site: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
            center: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
            range_minutes: RANGE_MINUTES, geometry: isoGeojson, area_km2: areaKm2,
            requested_profile: PROFILE, used_profile: usedProfile,
            profile_substituted: profSubstituted, profile_note: profNote,
            message: 'No area data found within catchment. Try increasing range_minutes or run setup-agent-playground.',
            population_points: [], summary: {}
        };
    }
    var avgDiab = Math.round(totalDiabetes / totalPop * 10) / 10;
    var avgHyp = Math.round(totalHypertension / totalPop * 10) / 10;
    var avgCard = Math.round(totalCardio / totalPop * 10) / 10;
    var avgResp = Math.round(totalRespiratory / totalPop * 10) / 10;
    var avgMob = Math.round(totalMobility / totalPop * 10) / 10;
    var avgEld = Math.round(totalElderly / totalPop * 10) / 10;
    var avgChi = Math.round(totalChildren / totalPop * 10) / 10;
    var pctNoCar = Math.round(totalLowCar / totalPop * 10) / 10;
    var highRisk = neighbourhoods.filter(function(n) { return n.risk_score >= 55; });
    return {
        status: 'SUCCESS',
        site: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
        center: { name: loc.name, longitude: loc.longitude, latitude: loc.latitude },
        range_minutes: RANGE_MINUTES, geometry: isoGeojson,
        area_km2: Math.round(areaKm2 * 100) / 100,
        requested_profile: PROFILE, used_profile: usedProfile,
        profile_substituted: profSubstituted, profile_note: profNote,
        population_points: neighbourhoods,
        summary: {
            catchment_population: totalPop,
            neighbourhoods_covered: neighbourhoods.length,
            high_risk_neighbourhoods: highRisk.length,
            avg_diabetes_pct: avgDiab, avg_hypertension_pct: avgHyp,
            avg_cardiovascular_pct: avgCard, avg_respiratory_pct: avgResp,
            avg_mobility_issues_pct: avgMob, pct_elderly: avgEld, pct_children: avgChi,
            pct_without_car: pctNoCar,
            income_low_pct: Math.round(lowIncome / totalPop * 1000) / 10,
            income_medium_pct: Math.round(medIncome / totalPop * 1000) / 10,
            income_high_pct: Math.round(highIncome / totalPop * 1000) / 10,
            top_morbidity: avgDiab > avgHyp ? 'Diabetes' : 'Hypertension',
            accessibility_note: pctNoCar > 40 ? 'HIGH dependency on the site — majority of population has no car' :
                                pctNoCar > 25 ? 'MODERATE car-free population — good transit access needed' :
                                'Most residents have car access to the site'
        }
    };
} catch(err) {
    return { error: err.message, status: 'FAILED' };
}
$$;

ALTER PROCEDURE FLEET_INTELLIGENCE.ROUTING_TOOLS.TOOL_CATCHMENT(VARCHAR, FLOAT, VARCHAR) SET COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-deploy-snowflake-intelligence-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Validation
SELECT 'TOOL_DIRECTIONS' AS OBJECT, 'PROCEDURE' AS TYPE FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_DIRECTIONS'
UNION ALL SELECT 'TOOL_ISOCHRONE', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_ISOCHRONE'
UNION ALL SELECT 'TOOL_POI_IN_ISOCHRONE', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_POI_IN_ISOCHRONE'
UNION ALL SELECT 'TOOL_ROUTE_OPTIMIZATION', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_ROUTE_OPTIMIZATION'
UNION ALL SELECT 'TOOL_NETWORK_OPTIMIZATION', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_NETWORK_OPTIMIZATION'
UNION ALL SELECT 'TOOL_DELIVERY_OPTIMIZATION', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_DELIVERY_OPTIMIZATION'
UNION ALL SELECT 'TOOL_CATCHMENT', 'PROCEDURE' FROM INFORMATION_SCHEMA.PROCEDURES WHERE PROCEDURE_SCHEMA = 'ROUTING_TOOLS' AND PROCEDURE_NAME = 'TOOL_CATCHMENT';
