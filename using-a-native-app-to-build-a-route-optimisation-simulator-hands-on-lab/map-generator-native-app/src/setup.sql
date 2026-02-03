-- OpenStreetMap Generator Native App Setup Script
-- This script creates the core functions and procedures for map generation

-- Create application role and schema
CREATE APPLICATION ROLE IF NOT EXISTS app_public;
CREATE SCHEMA IF NOT EXISTS core;
GRANT USAGE ON SCHEMA core TO APPLICATION ROLE app_public;

-- Create external access integration reference
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION osm_external_access
  ALLOWED_NETWORK_RULES = ('osm_network_rule')
  ALLOWED_AUTHENTICATION_SECRETS = ()
  ENABLED = TRUE
  COMMENT = 'External access for OpenStreetMap APIs';

-- Create network rule for OSM services
CREATE OR REPLACE NETWORK RULE osm_network_rule
  MODE = EGRESS
  TYPE = HOST_PORT
  VALUE_LIST = (
    'overpass-api.de:443',
    'nominatim.openstreetmap.org:443',
    'download.geofabrik.de:443',
    'extract.bbbike.org:443'
  )
  COMMENT = 'Network access for OpenStreetMap services';

-- Create stage for storing generated maps
CREATE STAGE IF NOT EXISTS core.generated_maps
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')
  DIRECTORY = (ENABLE = TRUE)
  COMMENT = 'Storage for generated OpenStreetMap files';

GRANT READ, WRITE ON STAGE core.generated_maps TO APPLICATION ROLE app_public;

-- Create table to track map generation requests
CREATE TABLE IF NOT EXISTS core.map_requests (
  request_id STRING DEFAULT UUID_STRING(),
  request_timestamp TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  request_type STRING, -- 'bbox', 'city', 'preset'
  request_params VARIANT,
  bbox_coordinates STRING,
  city_name STRING,
  output_filename STRING,
  status STRING DEFAULT 'PENDING', -- PENDING, PROCESSING, COMPLETED, FAILED
  file_size_bytes NUMBER,
  processing_time_seconds NUMBER,
  error_message STRING,
  created_by STRING DEFAULT CURRENT_USER(),
  PRIMARY KEY (request_id)
);

GRANT SELECT, INSERT, UPDATE ON TABLE core.map_requests TO APPLICATION ROLE app_public;

-- Create Python UDF for geocoding cities
CREATE OR REPLACE FUNCTION core.geocode_city(city_name STRING)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.8'
PACKAGES = ('requests', 'json')
HANDLER = 'geocode_city_handler'
EXTERNAL_ACCESS_INTEGRATIONS = (osm_external_access)
AS
$$
import requests
import json

def geocode_city_handler(city_name):
    """
    Geocode a city name to get bounding box coordinates
    Returns dict with coordinates or error
    """
    try:
        # Nominatim geocoding API
        url = "https://nominatim.openstreetmap.org/search"
        params = {
            'q': city_name,
            'format': 'json',
            'limit': 1,
            'extratags': 1,
            'addressdetails': 1
        }
        
        headers = {
            'User-Agent': 'SnowflakeNativeApp-MapGenerator/1.0'
        }
        
        response = requests.get(url, params=params, headers=headers, timeout=30)
        response.raise_for_status()
        
        results = response.json()
        if not results:
            return {
                'success': False,
                'error': f'City "{city_name}" not found'
            }
            
        result = results[0]
        bbox = result.get('boundingbox')
        
        if not bbox or len(bbox) != 4:
            return {
                'success': False,
                'error': f'No bounding box found for "{city_name}"'
            }
            
        # Nominatim returns [south, north, west, east]
        # Convert to [west, south, east, north] = [xmin, ymin, xmax, ymax]
        ymin, ymax, xmin, xmax = map(float, bbox)
        
        return {
            'success': True,
            'city_name': city_name,
            'display_name': result.get('display_name', city_name),
            'bbox': {
                'xmin': xmin,
                'ymin': ymin,
                'xmax': xmax,
                'ymax': ymax
            },
            'bbox_string': f'{xmin},{ymin},{xmax},{ymax}',
            'coordinates': {
                'longitude': float(result.get('lon', 0)),
                'latitude': float(result.get('lat', 0))
            }
        }
        
    except requests.RequestException as e:
        return {
            'success': False,
            'error': f'Network error: {str(e)}'
        }
    except Exception as e:
        return {
            'success': False,
            'error': f'Unexpected error: {str(e)}'
        }
$$;

-- Create Python UDF for downloading OSM data
CREATE OR REPLACE FUNCTION core.download_osm_data(
    bbox_string STRING,
    output_filename STRING
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.8'
PACKAGES = ('requests', 'json')
HANDLER = 'download_osm_handler'
EXTERNAL_ACCESS_INTEGRATIONS = (osm_external_access)
AS
$$
import requests
import json
import time

def download_osm_handler(bbox_string, output_filename):
    """
    Download OSM data for the specified bounding box
    Returns status and file information
    """
    try:
        # Parse bounding box
        coords = bbox_string.split(',')
        if len(coords) != 4:
            return {
                'success': False,
                'error': 'Invalid bounding box format. Expected: xmin,ymin,xmax,ymax'
            }
        
        xmin, ymin, xmax, ymax = map(float, coords)
        
        # Validate coordinates
        if not (-180 <= xmin <= 180 and -180 <= xmax <= 180):
            return {'success': False, 'error': 'Longitude must be between -180 and 180'}
        
        if not (-90 <= ymin <= 90 and -90 <= ymax <= 90):
            return {'success': False, 'error': 'Latitude must be between -90 and 90'}
        
        if xmin >= xmax or ymin >= ymax:
            return {'success': False, 'error': 'Invalid coordinate order'}
        
        # Check area size (warn if too large)
        area = (xmax - xmin) * (ymax - ymin)
        if area > 1.0:  # Roughly 100km x 100km at equator
            return {
                'success': False,
                'error': f'Area too large ({area:.2f} deg²). Please use a smaller bounding box.'
            }
        
        # Build Overpass query
        query = f"""
        [out:xml][timeout:300][bbox:{ymin},{xmin},{ymax},{xmax}];
        (
          relation;
          way;
          node;
        );
        out meta;
        """
        
        # Make request to Overpass API
        overpass_url = "https://overpass-api.de/api/interpreter"
        headers = {
            'User-Agent': 'SnowflakeNativeApp-MapGenerator/1.0',
            'Content-Type': 'text/plain'
        }
        
        start_time = time.time()
        
        response = requests.post(
            overpass_url,
            data=query.strip(),
            headers=headers,
            timeout=600,  # 10 minutes timeout
            stream=True
        )
        response.raise_for_status()
        
        # Calculate download size and time
        content_length = response.headers.get('content-length')
        if content_length:
            estimated_size = int(content_length)
        else:
            estimated_size = 0
        
        # Read response content
        content = response.content
        actual_size = len(content)
        download_time = time.time() - start_time
        
        return {
            'success': True,
            'filename': output_filename,
            'bbox': bbox_string,
            'file_size_bytes': actual_size,
            'estimated_size_bytes': estimated_size,
            'download_time_seconds': round(download_time, 2),
            'format': 'OSM XML',
            'area_degrees_squared': round(area, 6),
            'content_preview': content[:1000].decode('utf-8', errors='ignore') if content else '',
            'message': f'Successfully downloaded {actual_size / 1024 / 1024:.1f} MB of OSM data'
        }
        
    except requests.RequestException as e:
        return {
            'success': False,
            'error': f'Download failed: {str(e)}'
        }
    except Exception as e:
        return {
            'success': False,
            'error': f'Unexpected error: {str(e)}'
        }
$$;

-- Create procedure to generate and store map
CREATE OR REPLACE PROCEDURE core.generate_map(
    request_type STRING,
    request_params VARIANT
)
RETURNS VARIANT
LANGUAGE SQL
AS
$$
DECLARE
    request_id STRING;
    bbox_string STRING;
    city_name STRING;
    output_filename STRING;
    geocode_result VARIANT;
    download_result VARIANT;
    error_msg STRING;
BEGIN
    -- Generate unique request ID
    request_id := UUID_STRING();
    
    -- Extract parameters based on request type
    IF (request_type = 'city') THEN
        city_name := request_params:city_name::STRING;
        output_filename := COALESCE(request_params:output_filename::STRING, 
                                  REPLACE(LOWER(city_name), ' ', '_') || '.osm');
        
        -- Geocode the city
        geocode_result := core.geocode_city(city_name);
        
        IF (geocode_result:success::BOOLEAN = FALSE) THEN
            INSERT INTO core.map_requests (request_id, request_type, request_params, 
                                         city_name, output_filename, status, error_message)
            VALUES (request_id, request_type, request_params, city_name, 
                   output_filename, 'FAILED', geocode_result:error::STRING);
            
            RETURN OBJECT_CONSTRUCT('success', FALSE, 'error', geocode_result:error::STRING, 
                                  'request_id', request_id);
        END IF;
        
        bbox_string := geocode_result:bbox_string::STRING;
        
    ELSEIF (request_type = 'bbox') THEN
        bbox_string := request_params:bbox::STRING;
        output_filename := COALESCE(request_params:output_filename::STRING, 'custom_map.osm');
        
    ELSE
        RETURN OBJECT_CONSTRUCT('success', FALSE, 'error', 'Invalid request type: ' || request_type);
    END IF;
    
    -- Insert initial request record
    INSERT INTO core.map_requests (request_id, request_type, request_params, 
                                 bbox_coordinates, city_name, output_filename, status)
    VALUES (request_id, request_type, request_params, bbox_string, city_name, 
           output_filename, 'PROCESSING');
    
    -- Download OSM data
    download_result := core.download_osm_data(bbox_string, output_filename);
    
    IF (download_result:success::BOOLEAN = FALSE) THEN
        -- Update request with failure
        UPDATE core.map_requests 
        SET status = 'FAILED', 
            error_message = download_result:error::STRING
        WHERE request_id = :request_id;
        
        RETURN OBJECT_CONSTRUCT('success', FALSE, 'error', download_result:error::STRING, 
                              'request_id', request_id);
    END IF;
    
    -- Update request with success
    UPDATE core.map_requests 
    SET status = 'COMPLETED',
        file_size_bytes = download_result:file_size_bytes::NUMBER,
        processing_time_seconds = download_result:download_time_seconds::NUMBER
    WHERE request_id = :request_id;
    
    -- Return success response
    RETURN OBJECT_CONSTRUCT(
        'success', TRUE,
        'request_id', request_id,
        'filename', output_filename,
        'bbox', bbox_string,
        'file_size_mb', ROUND(download_result:file_size_bytes::NUMBER / 1024 / 1024, 2),
        'processing_time_seconds', download_result:download_time_seconds::NUMBER,
        'message', download_result:message::STRING
    );
    
EXCEPTION
    WHEN OTHER THEN
        error_msg := SQLERRM;
        
        -- Update request with error
        UPDATE core.map_requests 
        SET status = 'FAILED', 
            error_message = error_msg
        WHERE request_id = :request_id;
        
        RETURN OBJECT_CONSTRUCT('success', FALSE, 'error', error_msg, 'request_id', request_id);
END;
$$;

-- Create view for map generation history
CREATE OR REPLACE VIEW core.map_generation_history AS
SELECT 
    request_id,
    request_timestamp,
    request_type,
    CASE 
        WHEN request_type = 'city' THEN city_name
        WHEN request_type = 'bbox' THEN bbox_coordinates
        ELSE 'Unknown'
    END AS area_description,
    output_filename,
    status,
    ROUND(file_size_bytes / 1024 / 1024, 2) AS file_size_mb,
    processing_time_seconds,
    error_message,
    created_by
FROM core.map_requests
ORDER BY request_timestamp DESC;

GRANT SELECT ON VIEW core.map_generation_history TO APPLICATION ROLE app_public;

-- Create convenience functions for common cities
CREATE OR REPLACE FUNCTION core.get_preset_areas()
RETURNS TABLE (
    name STRING,
    bbox STRING,
    description STRING
)
AS
$$
SELECT * FROM VALUES
    ('Manhattan, NYC', '-74.0479,40.7128,-73.9441,40.7831', 'Dense urban area in New York City'),
    ('Central London', '-0.1778,51.4893,-0.0762,51.5279', 'Historic center of London, UK'),
    ('San Francisco', '-122.5149,37.7081,-122.3574,37.8085', 'Full city of San Francisco, CA'),
    ('Amsterdam Center', '4.8372,52.3477,4.9419,52.3925', 'Historic center of Amsterdam, Netherlands'),
    ('Berlin Mitte', '13.3501,52.4946,13.4286,52.5323', 'Central district of Berlin, Germany'),
    ('Paris Center', '2.2241,48.8155,2.4697,48.9021', 'Central Paris, France'),
    ('Tokyo Shibuya', '139.6917,35.6581,139.7044,35.6731', 'Shibuya district, Tokyo, Japan'),
    ('Sydney CBD', '151.1957,-33.8688,151.2187,-33.8548', 'Central Business District, Sydney, Australia')
    AS preset_areas(name, bbox, description)
$$;

GRANT USAGE ON FUNCTION core.get_preset_areas() TO APPLICATION ROLE app_public;

-- Grant permissions on all functions and procedures
GRANT USAGE ON FUNCTION core.geocode_city(STRING) TO APPLICATION ROLE app_public;
GRANT USAGE ON FUNCTION core.download_osm_data(STRING, STRING) TO APPLICATION ROLE app_public;
GRANT USAGE ON PROCEDURE core.generate_map(STRING, VARIANT) TO APPLICATION ROLE app_public;

-- Create Streamlit app
CREATE STREAMLIT core.map_generator_app
FROM '/streamlit'
MAIN_FILE = 'app.py'
QUERY_WAREHOUSE = COMPUTE_WH;

GRANT USAGE ON STREAMLIT core.map_generator_app TO APPLICATION ROLE app_public;
