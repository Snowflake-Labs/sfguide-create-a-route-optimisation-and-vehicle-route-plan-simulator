-- OpenStreetMap Generator Native App Setup
-- Uses grant_callback pattern from sfguide for external access integration

-- Create application role and schema
CREATE APPLICATION ROLE IF NOT EXISTS app_public;
CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_public;

-- ============================================================================
-- EXTERNAL ACCESS INTEGRATION CALLBACKS (Required by manifest.yml)
-- ============================================================================
CREATE OR REPLACE PROCEDURE core.register_single_callback(ref_name STRING, operation STRING, ref_or_alias STRING)
RETURNS STRING
LANGUAGE SQL
AS 
$$
BEGIN
  CASE (operation)
    WHEN 'ADD' THEN
      SELECT SYSTEM$SET_REFERENCE(:ref_name, :ref_or_alias);
    WHEN 'REMOVE' THEN
      SELECT SYSTEM$REMOVE_REFERENCE(:ref_name);
    WHEN 'CLEAR' THEN
      SELECT SYSTEM$REMOVE_REFERENCE(:ref_name);
    ELSE
      RETURN 'unknown operation: ' || operation;
  END CASE;
END;
$$;

GRANT USAGE ON PROCEDURE core.register_single_callback(STRING, STRING, STRING) TO APPLICATION ROLE app_public;

CREATE OR REPLACE PROCEDURE core.get_config_for_ref(ref_name STRING)
RETURNS STRING
LANGUAGE SQL
AS 
$$
BEGIN
  CASE (UPPER(ref_name))
    WHEN 'EXTERNAL_ACCESS_INTEGRATION_REF' THEN
      RETURN OBJECT_CONSTRUCT(
        'type', 'CONFIGURATION',
        'payload', OBJECT_CONSTRUCT(
          'host_ports', ARRAY_CONSTRUCT(
            'overpass-api.de:443', 
            'nominatim.openstreetmap.org:443'
          ),
          'allowed_secrets', 'NONE'
        )
      )::STRING;
    ELSE
      RETURN '';
  END CASE;
END;
$$;

GRANT USAGE ON PROCEDURE core.get_config_for_ref(STRING) TO APPLICATION ROLE app_public;

-- ============================================================================
-- CREATE INFRASTRUCTURE
-- ============================================================================
CREATE STAGE IF NOT EXISTS core.generated_maps
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = 'Storage for generated OpenStreetMap files';

GRANT READ, WRITE ON STAGE core.generated_maps TO APPLICATION ROLE app_public;

CREATE TABLE IF NOT EXISTS core.map_generation_history (
  id STRING DEFAULT UUID_STRING(),
  request_type STRING,
  city_name STRING,
  bbox VARIANT,
  status STRING DEFAULT 'pending',
  created_at TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  completed_at TIMESTAMP_LTZ,
  file_path STRING,
  file_size_bytes NUMBER,
  processing_time_seconds NUMBER,
  error_message STRING,
  PRIMARY KEY (id)
);

GRANT SELECT, INSERT, UPDATE ON TABLE core.map_generation_history TO APPLICATION ROLE app_public;

-- Table to store active map configuration for OpenRouteService
CREATE TABLE IF NOT EXISTS core.ors_config (
  config_key STRING PRIMARY KEY,
  config_value STRING,
  updated_at TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP(),
  updated_by STRING DEFAULT CURRENT_USER()
);

-- Initialize with default values
MERGE INTO core.ors_config AS target
USING (SELECT 'active_map' AS config_key, NULL AS config_value) AS source
ON target.config_key = source.config_key
WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (source.config_key, source.config_value);

MERGE INTO core.ors_config AS target
USING (SELECT 'ors_status' AS config_key, 'not_configured' AS config_value) AS source
ON target.config_key = source.config_key
WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES (source.config_key, source.config_value);

GRANT SELECT, INSERT, UPDATE ON TABLE core.ors_config TO APPLICATION ROLE app_public;

-- ============================================================================
-- PROCEDURE TO CREATE REAL OSM FUNCTIONS (called from grant_callback)
-- ============================================================================
CREATE OR REPLACE PROCEDURE core.create_osm_functions()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
  -- Create real geocode function with external access
  -- If area is too large, automatically creates a smaller central area
  CREATE OR REPLACE FUNCTION core.geocode_city(city_name STRING)
  RETURNS STRING
  LANGUAGE PYTHON
  RUNTIME_VERSION = '3.10'
  PACKAGES = ('requests')
  HANDLER = 'geocode_handler'
  EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_integration_ref'))
  AS '
import requests
import json

# Max area in square degrees (0.01 = roughly 1km x 1km at equator)
MAX_AREA = 0.01

def geocode_handler(city_name):
    try:
        url = "https://nominatim.openstreetmap.org/search"
        params = {"q": city_name, "format": "json", "limit": 1}
        headers = {"User-Agent": "SnowflakeNativeApp-MapGenerator/1.0"}
        response = requests.get(url, params=params, headers=headers, timeout=30)
        response.raise_for_status()
        results = response.json()
        if not results:
            return json.dumps({"success": False, "error": f"City not found: {city_name}"})
        result = results[0]
        bbox = result.get("boundingbox")
        if not bbox or len(bbox) != 4:
            return json.dumps({"success": False, "error": "No bounding box found"})
        
        ymin, ymax, xmin, xmax = map(float, bbox)
        original_area = (xmax - xmin) * (ymax - ymin)
        
        # If area is too large, create a smaller central area
        area_reduced = False
        if original_area > MAX_AREA:
            area_reduced = True
            # Get center point
            center_lat = float(result.get("lat", (ymin + ymax) / 2))
            center_lng = float(result.get("lon", (xmin + xmax) / 2))
            
            # Create a ~0.1 degree box around center (roughly 10km x 10km)
            # This gives area of 0.01 sq deg
            half_size = 0.05
            xmin = center_lng - half_size
            xmax = center_lng + half_size
            ymin = center_lat - half_size
            ymax = center_lat + half_size
        
        new_area = (xmax - xmin) * (ymax - ymin)
        
        response_data = {
            "success": True, 
            "city_name": city_name, 
            "display_name": result.get("display_name", city_name),
            "lat": float(result.get("lat", 0)), 
            "lng": float(result.get("lon", 0)),
            "bbox": {"xmin": xmin, "ymin": ymin, "xmax": xmax, "ymax": ymax},
            "bbox_string": f"{xmin},{ymin},{xmax},{ymax}",
            "area_sq_deg": round(new_area, 6),
            "source": "OpenStreetMap Nominatim API"
        }
        
        if area_reduced:
            response_data["area_reduced"] = True
            response_data["original_area_sq_deg"] = round(original_area, 4)
            response_data["message"] = f"Area was too large ({original_area:.2f} sq deg). Using central {half_size*2:.1f}° area instead."
        
        return json.dumps(response_data)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})
  ';
  
  GRANT USAGE ON FUNCTION core.geocode_city(STRING) TO APPLICATION ROLE app_public;
  
  -- Create combined download and save procedure
  -- This downloads OSM data and writes directly to stage, avoiding large return values
  CREATE OR REPLACE PROCEDURE core.download_and_save_osm(bbox_string STRING, output_filename STRING)
  RETURNS STRING
  LANGUAGE PYTHON
  RUNTIME_VERSION = '3.10'
  PACKAGES = ('requests', 'snowflake-snowpark-python')
  HANDLER = 'download_and_save_handler'
  EXTERNAL_ACCESS_INTEGRATIONS = (reference('external_access_integration_ref'))
  AS '
import requests
import json
import time
import os

def download_and_save_handler(session, bbox_string, output_filename):
    try:
        coords = bbox_string.split(",")
        if len(coords) != 4:
            return json.dumps({"success": False, "error": "Invalid bbox format"})
        xmin, ymin, xmax, ymax = map(float, coords)
        area = (xmax - xmin) * (ymax - ymin)
        # Limit to ~0.01 sq deg to avoid temp storage issues (~5-10MB max file size)
        if area > 0.01:
            return json.dumps({"success": False, "error": f"Area too large: {area:.4f} sq deg (max 0.01). Use a smaller area or specific neighborhood."})
        
        query = f"""[out:xml][timeout:180][bbox:{ymin},{xmin},{ymax},{xmax}];
(way["highway"];way["building"];node["amenity"];);out body;>;out skel qt;"""
        
        start_time = time.time()
        response = requests.post("https://overpass-api.de/api/interpreter", 
                                data={"data": query}, 
                                headers={"User-Agent": "SnowflakeNativeApp/1.0"},
                                timeout=180)
        response.raise_for_status()
        download_time = time.time() - start_time
        
        content = response.content
        content_str = content.decode("utf-8", errors="ignore")
        
        # Count elements for stats
        node_count = content_str.count("<node")
        way_count = content_str.count("<way")
        relation_count = content_str.count("<relation")
        total_elements = node_count + way_count + relation_count
        file_size = len(content)
        
        # Write to temp file and upload to stage
        temp_path = f"/tmp/{output_filename}"
        with open(temp_path, "wb") as f:
            f.write(content)
        
        session.file.put(temp_path, "@core.generated_maps", auto_compress=False, overwrite=True)
        os.remove(temp_path)
        
        # Refresh stage directory metadata so file appears immediately
        session.sql("ALTER STAGE core.generated_maps REFRESH").collect()
        
        return json.dumps({
            "success": True, 
            "filename": output_filename, 
            "bbox": bbox_string,
            "file_size_bytes": file_size, 
            "download_time_seconds": round(download_time, 2),
            "total_elements": total_elements,
            "node_count": node_count,
            "way_count": way_count,
            "relation_count": relation_count,
            "source": "OpenStreetMap Overpass API"
        })
    except requests.exceptions.Timeout:
        return json.dumps({"success": False, "error": "Download timed out. Try a smaller area."})
    except requests.exceptions.RequestException as e:
        return json.dumps({"success": False, "error": f"Download failed: {str(e)}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})
  ';
  
  GRANT USAGE ON PROCEDURE core.download_and_save_osm(STRING, STRING) TO APPLICATION ROLE app_public;
  
  RETURN 'OSM functions created successfully';
END;
$$;

GRANT USAGE ON PROCEDURE core.create_osm_functions() TO APPLICATION ROLE app_public;

-- ============================================================================
-- MERGE MAPS PROCEDURE (outside create_osm_functions to avoid nested $$ issue)
-- ============================================================================
CREATE OR REPLACE PROCEDURE core.merge_maps(file_list ARRAY, output_filename STRING)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.10'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'merge_handler'
AS $$
import json
import os
import re
from collections import OrderedDict

def merge_handler(session, file_list, output_filename):
    try:
        if not file_list or len(file_list) < 2:
            return json.dumps({"success": False, "error": "Please provide at least 2 files to merge"})
        
        nodes = OrderedDict()
        ways = OrderedDict()
        relations = OrderedDict()
        bounds_list = []
        files_processed = 0
        dq = chr(34)
        
        for filename in file_list:
            temp_path = f"/tmp/{filename}"
            try:
                session.file.get(f"@core.generated_maps/{filename}", "/tmp/")
            except Exception as e:
                return json.dumps({"success": False, "error": f"Failed to get file {filename}: {str(e)}"})
            
            if not os.path.exists(temp_path):
                return json.dumps({"success": False, "error": f"File not found: {filename}"})
            
            with open(temp_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            os.remove(temp_path)
            
            bounds_match = re.search(r"<bounds[^>]+/>", content)
            if bounds_match:
                bounds_list.append(bounds_match.group())
            
            node_pattern = re.compile(r'<node[^>]*id=' + dq + r'(-?\d+)' + dq + r'[^>]*(?:/>|>.*?</node>)', re.DOTALL)
            for match in node_pattern.finditer(content):
                node_id = match.group(1)
                if node_id not in nodes:
                    nodes[node_id] = match.group(0)
            
            way_pattern = re.compile(r'<way[^>]*id=' + dq + r'(-?\d+)' + dq + r'[^>]*>.*?</way>', re.DOTALL)
            for match in way_pattern.finditer(content):
                way_id = match.group(1)
                if way_id not in ways:
                    ways[way_id] = match.group(0)
            
            rel_pattern = re.compile(r'<relation[^>]*id=' + dq + r'(-?\d+)' + dq + r'[^>]*>.*?</relation>', re.DOTALL)
            for match in rel_pattern.finditer(content):
                rel_id = match.group(1)
                if rel_id not in relations:
                    relations[rel_id] = match.group(0)
            
            files_processed += 1
        
        min_lat, max_lat = 90.0, -90.0
        min_lon, max_lon = 180.0, -180.0
        for bounds in bounds_list:
            for attr in ["minlat", "maxlat", "minlon", "maxlon"]:
                attr_pattern = re.compile(attr + r'=' + dq + r'([^' + dq + r']+)' + dq)
                match = attr_pattern.search(bounds)
                if match:
                    val = float(match.group(1))
                    if attr == "minlat": min_lat = min(min_lat, val)
                    elif attr == "maxlat": max_lat = max(max_lat, val)
                    elif attr == "minlon": min_lon = min(min_lon, val)
                    elif attr == "maxlon": max_lon = max(max_lon, val)
        
        merged_lines = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<osm version="0.6" generator="SnowflakeNativeApp-MapMerger/1.0">',
            f'  <bounds minlat="{min_lat}" minlon="{min_lon}" maxlat="{max_lat}" maxlon="{max_lon}"/>'
        ]
        for node in nodes.values():
            merged_lines.append("  " + node)
        for way in ways.values():
            merged_lines.append("  " + way)
        for relation in relations.values():
            merged_lines.append("  " + relation)
        merged_lines.append("</osm>")
        merged_content = "\n".join(merged_lines)
        
        output_path = f"/tmp/{output_filename}"
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(merged_content)
        file_size = os.path.getsize(output_path)
        
        session.file.put(output_path, "@core.generated_maps", auto_compress=False, overwrite=True)
        os.remove(output_path)
        session.sql("ALTER STAGE core.generated_maps REFRESH").collect()
        
        return json.dumps({
            "success": True,
            "filename": output_filename,
            "files_merged": files_processed,
            "input_files": list(file_list),
            "file_size_bytes": file_size,
            "total_nodes": len(nodes),
            "total_ways": len(ways),
            "total_relations": len(relations),
            "total_elements": len(nodes) + len(ways) + len(relations),
            "merged_bounds": {"minlat": min_lat, "minlon": min_lon, "maxlat": max_lat, "maxlon": max_lon}
        })
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})
$$;

GRANT USAGE ON PROCEDURE core.merge_maps(ARRAY, STRING) TO APPLICATION ROLE app_public;

-- ============================================================================
-- ORS CONFIGURATION FUNCTIONS
-- ============================================================================

-- Procedure to generate ORS config file with the specified map and vehicle profiles
-- profiles parameter is a VARIANT array of profile names to enable
-- Available profiles: driving-car, driving-hgv, cycling-road, cycling-regular, 
--                     cycling-mountain, cycling-electric, foot-walking, foot-hiking, wheelchair
CREATE OR REPLACE PROCEDURE core.generate_ors_config(map_filename STRING, profiles VARIANT)
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.10'
PACKAGES = ('snowflake-snowpark-python')
HANDLER = 'generate_config_handler'
AS $$
import json
import os

def generate_config_handler(session, map_filename, profiles):
    try:
        # Available ORS profiles with descriptions
        available_profiles = {
            "driving-car": "Standard car routing",
            "driving-hgv": "Heavy goods vehicle (truck) routing",
            "cycling-road": "Road cycling",
            "cycling-regular": "Regular cycling",
            "cycling-mountain": "Mountain biking",
            "cycling-electric": "Electric bike routing",
            "foot-walking": "Walking routes",
            "foot-hiking": "Hiking trails",
            "wheelchair": "Wheelchair accessible routes"
        }
        
        # Parse profiles - default to common ones if not specified
        if profiles is None or len(profiles) == 0:
            enabled_profiles = ["driving-car", "driving-hgv", "foot-walking"]
        else:
            enabled_profiles = list(profiles)
        
        # Validate profiles
        invalid_profiles = [p for p in enabled_profiles if p not in available_profiles]
        if invalid_profiles:
            return json.dumps({
                "success": False, 
                "error": f"Invalid profiles: {invalid_profiles}. Available: {list(available_profiles.keys())}"
            })
        
        # Build profiles YAML section
        profiles_yaml = ""
        for profile in available_profiles.keys():
            if profile in enabled_profiles:
                profiles_yaml += f"      {profile}:\n        enabled: true\n"
            # Only include disabled profiles that were explicitly in the list
            # (don't clutter config with all disabled profiles)
        
        # ORS config template
        config_content = f'''################################################################################################
### OpenRouteService Configuration - Generated by OSM Generator Native App              ###
### https://giscience.github.io/openrouteservice/run-instance/configuration/             ###
### Enabled profiles: {", ".join(enabled_profiles)}
################################################################################################
ors:
  engine:
    profile_default:
      build:  
        source_file: /home/ors/files/{map_filename}
        instructions: true
      service:
        maximum_visited_nodes: 1000000000
    profiles:
{profiles_yaml}  endpoints:
    routing:
      enabled: true
      maximum_avoid_polygon_area: 200000000
      maximum_avoid_polygon_extent: 20000
      maximum_alternative_routes: 3
    matrix:
      enabled: true
      maximum_visited_nodes: 1000000000
      maximum_routes: 250000
      maximum_routes_flexible: 25
    isochrones:
      enabled: true
      maximum_locations: 2
      maximum_intervals: 10
      maximum_range_distance_default: 50000
      maximum_range_time_default: 18000
'''
        
        # Write config to temp file
        config_filename = "ors-config.yml"
        temp_path = f"/tmp/{config_filename}"
        with open(temp_path, "w", encoding="utf-8") as f:
            f.write(config_content)
        
        file_size = os.path.getsize(temp_path)
        
        # Upload to stage (same stage as maps)
        session.file.put(temp_path, "@core.generated_maps", auto_compress=False, overwrite=True)
        os.remove(temp_path)
        
        # Refresh stage
        session.sql("ALTER STAGE core.generated_maps REFRESH").collect()
        
        # Store enabled profiles in config table
        profiles_json = json.dumps(enabled_profiles)
        session.sql(f"""
            MERGE INTO core.ors_config AS target
            USING (SELECT 'enabled_profiles' AS config_key) AS source
            ON target.config_key = source.config_key
            WHEN MATCHED THEN UPDATE SET config_value = '{profiles_json}', updated_at = CURRENT_TIMESTAMP()
            WHEN NOT MATCHED THEN INSERT (config_key, config_value) VALUES ('enabled_profiles', '{profiles_json}')
        """).collect()
        
        return json.dumps({
            "success": True,
            "message": f"ORS config generated for map: {map_filename}",
            "config_file": config_filename,
            "map_file": map_filename,
            "enabled_profiles": enabled_profiles,
            "file_size_bytes": file_size,
            "source_path": f"/home/ors/files/{map_filename}"
        })
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})
$$;

GRANT USAGE ON PROCEDURE core.generate_ors_config(STRING, VARIANT) TO APPLICATION ROLE app_public;

-- Helper function to get available ORS profiles
CREATE OR REPLACE FUNCTION core.get_available_profiles()
RETURNS TABLE(profile_name STRING, description STRING, category STRING)
LANGUAGE SQL
AS
$$
  SELECT profile_name, description, category FROM VALUES
    ('driving-car', 'Standard car routing with turn restrictions', 'Driving'),
    ('driving-hgv', 'Heavy goods vehicle (truck) routing', 'Driving'),
    ('cycling-road', 'Road cycling on paved surfaces', 'Cycling'),
    ('cycling-regular', 'Regular cycling on mixed surfaces', 'Cycling'),
    ('cycling-mountain', 'Mountain biking on trails', 'Cycling'),
    ('cycling-electric', 'Electric bike with extended range', 'Cycling'),
    ('foot-walking', 'Walking routes on sidewalks and paths', 'Walking'),
    ('foot-hiking', 'Hiking trails including unpaved paths', 'Walking'),
    ('wheelchair', 'Wheelchair accessible routes', 'Accessibility')
  AS t(profile_name, description, category)
$$;

GRANT USAGE ON FUNCTION core.get_available_profiles() TO APPLICATION ROLE app_public;

-- Procedure to set active map for OpenRouteService (also generates config)
-- profiles is optional - defaults to driving-car, driving-hgv, foot-walking
CREATE OR REPLACE PROCEDURE core.set_active_map(map_filename STRING, profiles VARIANT DEFAULT NULL)
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
  file_count NUMBER;
  config_result STRING;
  profiles_to_use VARIANT;
BEGIN
  -- Check if file exists in stage
  SELECT COUNT(*) INTO file_count FROM DIRECTORY(@core.generated_maps) WHERE RELATIVE_PATH LIKE '%' || :map_filename || '%';
  
  IF (file_count = 0) THEN
    RETURN '{"success": false, "error": "File not found in stage: ' || :map_filename || '"}';
  END IF;
  
  -- Use provided profiles or default
  IF (:profiles IS NULL) THEN
    profiles_to_use := PARSE_JSON('["driving-car", "driving-hgv", "foot-walking"]');
  ELSE
    profiles_to_use := :profiles;
  END IF;
  
  -- Generate ORS config file for this map with specified profiles
  CALL core.generate_ors_config(:map_filename, :profiles_to_use) INTO :config_result;
  
  -- Update the active map config
  UPDATE core.ors_config 
  SET config_value = :map_filename, updated_at = CURRENT_TIMESTAMP(), updated_by = CURRENT_USER()
  WHERE config_key = 'active_map';
  
  -- Update status
  UPDATE core.ors_config 
  SET config_value = 'map_selected', updated_at = CURRENT_TIMESTAMP()
  WHERE config_key = 'ors_status';
  
  RETURN :config_result;
END;
$$;

GRANT USAGE ON PROCEDURE core.set_active_map(STRING, VARIANT) TO APPLICATION ROLE app_public;

-- Function to get current ORS configuration
CREATE OR REPLACE FUNCTION core.get_ors_config()
RETURNS STRING
LANGUAGE SQL
AS
$$
  SELECT OBJECT_CONSTRUCT(
    'active_map', MAX(CASE WHEN config_key = 'active_map' THEN config_value END),
    'ors_status', MAX(CASE WHEN config_key = 'ors_status' THEN config_value END),
    'enabled_profiles', MAX(CASE WHEN config_key = 'enabled_profiles' THEN config_value END),
    'last_updated', MAX(updated_at)
  )::STRING
  FROM core.ors_config
$$;

GRANT USAGE ON FUNCTION core.get_ors_config() TO APPLICATION ROLE app_public;

-- ============================================================================
-- GRANT CALLBACK - Called after privileges are granted (from manifest.yml)
-- ============================================================================
CREATE OR REPLACE PROCEDURE core.grant_callback(privileges ARRAY)
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
  -- Create the real OSM functions with external access
  CALL core.create_osm_functions();
  RETURN 'OpenStreetMap Generator configured successfully';
END;
$$;

GRANT USAGE ON PROCEDURE core.grant_callback(ARRAY) TO APPLICATION ROLE app_public;

-- ============================================================================
-- STATUS CHECK PROCEDURE (used by Streamlit)
-- ============================================================================
CREATE OR REPLACE PROCEDURE core.check_status()
RETURNS STRING
LANGUAGE SQL
AS
$$
BEGIN
  RETURN 'REAL_API: OpenStreetMap integration active via Nominatim and Overpass APIs';
END;
$$;

GRANT USAGE ON PROCEDURE core.check_status() TO APPLICATION ROLE app_public;

-- ============================================================================
-- GET PRESET AREAS FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION core.get_preset_areas()
RETURNS TABLE(name STRING, description STRING, bbox VARIANT)
LANGUAGE SQL
AS
$$
  SELECT 
    name,
    description,
    PARSE_JSON(bbox_json) as bbox
  FROM VALUES
    ('Times Square NYC', 'Times Square area, Manhattan', '{"xmin": -73.990, "ymin": 40.755, "xmax": -73.982, "ymax": 40.762}'),
    ('Trafalgar Square', 'Trafalgar Square, London', '{"xmin": -0.135, "ymin": 51.505, "xmax": -0.120, "ymax": 51.512}'),
    ('Union Square SF', 'Union Square, San Francisco', '{"xmin": -122.410, "ymin": 37.785, "xmax": -122.400, "ymax": 37.792}'),
    ('Brandenburg Gate', 'Brandenburg Gate area, Berlin', '{"xmin": 13.375, "ymin": 52.514, "xmax": 13.385, "ymax": 52.520}'),
    ('Eiffel Tower', 'Eiffel Tower area, Paris', '{"xmin": 2.290, "ymin": 48.855, "xmax": 2.300, "ymax": 48.862}'),
    ('Shibuya Crossing', 'Shibuya Crossing, Tokyo', '{"xmin": 139.698, "ymin": 35.658, "xmax": 139.705, "ymax": 35.663}')
  AS t(name, description, bbox_json)
$$;

GRANT USAGE ON FUNCTION core.get_preset_areas() TO APPLICATION ROLE app_public;

-- ============================================================================
-- MAIN MAP GENERATION PROCEDURE
-- ============================================================================
CREATE OR REPLACE PROCEDURE core.generate_map(request_type STRING, params VARIANT)
RETURNS STRING
LANGUAGE SQL
AS
$$
DECLARE
  request_id STRING;
  bbox_string STRING;
  city_name STRING;
  filename STRING;
  geocode_result STRING;
  geocode_data VARIANT;
  download_result STRING;
  download_data VARIANT;
  start_time TIMESTAMP_LTZ;
  end_time TIMESTAMP_LTZ;
  processing_time NUMBER;
  file_size NUMBER;
BEGIN
  request_id := UUID_STRING();
  start_time := CURRENT_TIMESTAMP();
  
  IF (request_type = 'city') THEN
    city_name := params:city_name::STRING;
    geocode_result := (SELECT core.geocode_city(:city_name));
    geocode_data := PARSE_JSON(:geocode_result);
    
    IF (:geocode_data:success::BOOLEAN = FALSE) THEN
      LET error_msg STRING := :geocode_data:error::STRING;
      INSERT INTO core.map_generation_history (id, request_type, city_name, status, error_message)
      SELECT :request_id, :request_type, :city_name, 'failed', :error_msg;
      RETURN 'Failed to geocode city: ' || :error_msg;
    END IF;
    
    bbox_string := :geocode_data:bbox_string::STRING;
    city_name := :geocode_data:display_name::STRING;
    -- Filename: city name + date + short ID, e.g., "london_uk_2025-11-28_a1b2c3d4.osm"
    filename := REGEXP_REPLACE(LOWER(params:city_name::STRING), '[^a-z0-9]', '_') || '_' || TO_CHAR(CURRENT_DATE(), 'YYYY-MM-DD') || '_' || LEFT(:request_id, 8) || '.osm';
    
  ELSEIF (request_type = 'bbox') THEN
    bbox_string := params:bbox::STRING;
    city_name := COALESCE(params:area_name::STRING, 'Custom Area');
    -- Filename: area name + date + short ID, e.g., "central_london_2025-11-28_a1b2c3d4.osm"
    filename := REGEXP_REPLACE(LOWER(:city_name), '[^a-z0-9]', '_') || '_' || TO_CHAR(CURRENT_DATE(), 'YYYY-MM-DD') || '_' || LEFT(:request_id, 8) || '.osm';
    
  ELSE
    RETURN 'Unknown request type: ' || request_type;
  END IF;
  
  INSERT INTO core.map_generation_history (id, request_type, city_name, bbox, status, file_path)
  SELECT :request_id, :request_type, :city_name, OBJECT_CONSTRUCT('bbox_string', :bbox_string), 'processing', :filename;
  
  -- Download OSM data and save directly to stage (combined operation)
  CALL core.download_and_save_osm(:bbox_string, :filename) INTO :download_result;
  download_data := PARSE_JSON(:download_result);
  
  IF (:download_data:success::BOOLEAN = FALSE) THEN
    end_time := CURRENT_TIMESTAMP();
    processing_time := DATEDIFF(SECOND, :start_time, :end_time);
    UPDATE core.map_generation_history 
    SET status = 'failed', completed_at = :end_time, processing_time_seconds = :processing_time,
        error_message = :download_data:error::STRING
    WHERE id = :request_id;
    RETURN 'Map generation failed: ' || :download_data:error::STRING;
  END IF;
  
  file_size := :download_data:file_size_bytes::NUMBER;
  
  end_time := CURRENT_TIMESTAMP();
  processing_time := DATEDIFF(SECOND, :start_time, :end_time);
  
  UPDATE core.map_generation_history 
  SET status = 'completed', completed_at = :end_time, file_size_bytes = :file_size,
      processing_time_seconds = :processing_time
  WHERE id = :request_id;
  
  RETURN 'Map generated! File: ' || :filename || 
         ', Size: ' || :file_size::STRING || ' bytes' ||
         ', Elements: ' || :download_data:total_elements::STRING ||
         ', Source: ' || :download_data:source::STRING;
         
EXCEPTION
  WHEN OTHER THEN
    RETURN 'Map generation failed: ' || SQLERRM;
END;
$$;

GRANT USAGE ON PROCEDURE core.generate_map(STRING, VARIANT) TO APPLICATION ROLE app_public;

-- ============================================================================
-- CREATE STREAMLIT APP
-- ============================================================================
CREATE OR REPLACE STREAMLIT core.map_generator_app
  FROM '/streamlit'
  MAIN_FILE = '/app.py';

GRANT USAGE ON STREAMLIT core.map_generator_app TO APPLICATION ROLE app_public;
