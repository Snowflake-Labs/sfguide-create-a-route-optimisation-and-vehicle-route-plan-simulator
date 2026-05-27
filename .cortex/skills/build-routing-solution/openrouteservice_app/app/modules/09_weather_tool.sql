-- =============================================================================
-- 09_weather_tool.sql
-- Deploys the Met Office weather tool for the ROUTING_AGENT.
-- Run AFTER: 08_route_optimization_data.sql
-- Requires: MET_OFFICE_S3_ACCESS EAI (created in 01_core_infra or standalone)
--
-- Creates:
--   GET_WEATHER_AT_POINT  — Python UDF querying Met Office NetCDF from S3
--   TOOL_WEATHER          — Stored procedure the agent calls
--
-- The agent spec already references TOOL_WEATHER. This module creates the
-- actual procedure so it resolves at runtime.
-- =============================================================================

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-add-weather-routing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Network rule + EAI (idempotent)
CREATE OR REPLACE NETWORK RULE FLEET_INTELLIGENCE.ROUTING_AGENT.MET_OFFICE_S3_RULE
    MODE = EGRESS TYPE = HOST_PORT
    VALUE_LIST = ('met-office-atmospheric-model-data.s3.amazonaws.com:443','met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com:443')
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-weather-routing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION MET_OFFICE_S3_ACCESS
    ALLOWED_NETWORK_RULES = (FLEET_INTELLIGENCE.ROUTING_AGENT.MET_OFFICE_S3_RULE)
    ENABLED = TRUE
    COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-weather-routing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

-- Python UDF: fetches NetCDF from Met Office S3, extracts weather at lat/lon
CREATE OR REPLACE FUNCTION FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT(
    LATITUDE FLOAT, LONGITUDE FLOAT, WEATHER_DATE DATE, FORECAST_HOUR INT, WEATHER_PARAMETER VARCHAR
)
RETURNS VARIANT
LANGUAGE PYTHON
RUNTIME_VERSION = '3.10'
PACKAGES = ('requests', 'xarray', 'h5netcdf', 'numpy')
EXTERNAL_ACCESS_INTEGRATIONS = (MET_OFFICE_S3_ACCESS)
HANDLER = 'get_weather_at_point'
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-weather-routing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
import requests
import xarray as xr
import numpy as np
from io import BytesIO
from datetime import datetime, timedelta

def get_weather_at_point(latitude, longitude, weather_date, forecast_hour, weather_parameter):
    try:
        param_files = {
            'temperature': 'temperature_at_screen_level', 'temp': 'temperature_at_screen_level',
            'precipitation': 'precipitation_rate', 'rain': 'rainfall_rate', 'rainfall': 'rainfall_rate',
            'wind_speed': 'wind_speed_at_10m', 'wind': 'wind_speed_at_10m', 'wind_gust': 'wind_gust_at_10m',
            'humidity': 'relative_humidity_at_screen_level', 'cloud': 'cloud_amount_of_total_cloud',
            'cloud_cover': 'cloud_amount_of_total_cloud', 'pressure': 'pressure_at_mean_sea_level',
            'visibility': 'visibility_at_screen_level',
        }
        param_lower = (weather_parameter or 'temperature').lower().strip()
        file_param = param_files.get(param_lower, 'temperature_at_screen_level')
        if hasattr(weather_date, 'year'):
            dt = datetime(weather_date.year, weather_date.month, weather_date.day)
        else:
            dt = datetime.strptime(str(weather_date), '%Y-%m-%d')
        model_hour = 12
        lead_hours = min(max(0, forecast_hour or 0), 120)
        date_str = dt.strftime('%Y%m%d')
        model_run = f'{date_str}T{model_hour:02d}00Z'
        lead_str = f'PT{lead_hours:04d}H00M'
        base_url = 'https://met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com'
        file_url = f'{base_url}/global-deterministic-10km/{model_run}/{model_run}-{lead_str}-{file_param}.nc'
        response = requests.get(file_url, timeout=60)
        if response.status_code == 404:
            yesterday = dt - timedelta(days=1)
            date_str = yesterday.strftime('%Y%m%d')
            model_run = f'{date_str}T{model_hour:02d}00Z'
            lead_str = f'PT{lead_hours + 24:04d}H00M'
            file_url = f'{base_url}/global-deterministic-10km/{model_run}/{model_run}-{lead_str}-{file_param}.nc'
            response = requests.get(file_url, timeout=60)
        if response.status_code != 200:
            return {'error': f'Data not available (HTTP {response.status_code})', 'parameter': weather_parameter, 'date': str(weather_date)}
        ds = xr.open_dataset(BytesIO(response.content), engine='h5netcdf')
        lats = ds.latitude.values
        lons = ds.longitude.values
        q_lon = longitude + 360 if (lons.max() > 180 and longitude < 0) else longitude
        lat_idx = int(np.abs(lats - latitude).argmin())
        lon_idx = int(np.abs(lons - q_lon).argmin())
        var_name = list(ds.data_vars)[0]
        data = ds[var_name].values
        value = float(data[0, lat_idx, lon_idx] if data.ndim == 3 else data[lat_idx, lon_idx] if data.ndim == 2 else data.flat[0])
        unit = ds[var_name].attrs.get('units', 'unknown')
        if unit == 'K': value -= 273.15; unit = '°C'
        elif unit == 'kg m-2 s-1': value *= 3600; unit = 'mm/hr'
        elif unit == 'Pa': value /= 100; unit = 'hPa'
        actual_lat = float(lats[lat_idx])
        actual_lon = float(lons[lon_idx])
        if actual_lon > 180: actual_lon -= 360
        ds.close()
        return {'location': {'lat': round(actual_lat, 3), 'lon': round(actual_lon, 3)}, 'parameter': weather_parameter, 'value': round(value, 2), 'unit': unit, 'model_run': model_run, 'source': 'Met Office Global 10km (Open Government Licence)'}
    except Exception as e:
        return {'error': str(e), 'latitude': latitude, 'longitude': longitude, 'parameter': weather_parameter}
$$;

-- Stored procedure: agent-callable wrapper that geocodes region → lat/lon → weather
CREATE OR REPLACE PROCEDURE FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_WEATHER(
    REGION_NAME VARCHAR DEFAULT 'SanFrancisco'
)
RETURNS VARIANT
LANGUAGE SQL
COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-add-weather-routing","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}'
AS
$$
DECLARE
    v_lat FLOAT; v_lon FLOAT; v_region VARCHAR;
    v_temp VARIANT; v_wind VARIANT; v_rain VARIANT; v_vis VARIANT; v_humidity VARIANT; v_pressure VARIANT; v_cloud VARIANT;
    v_model_date DATE; v_lead_hours INT;
BEGIN
    v_region := REGION_NAME;
    v_model_date := CURRENT_DATE();
    v_lead_hours := 0;
    BEGIN
        SELECT LATITUDE, LONGITUDE INTO v_lat, v_lon
        FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
        WHERE UPPER(REPLACE(PLANT_NAME, ' ', '')) LIKE '%' || UPPER(REPLACE(:v_region, ' ', '')) || '%'
           OR UPPER(CITY) = UPPER(:v_region)
           OR UPPER(COUNTRY) LIKE '%' || UPPER(:v_region) || '%'
        LIMIT 1;
    EXCEPTION WHEN OTHER THEN v_lat := NULL;
    END;
    IF (v_lat IS NULL) THEN
        BEGIN
            SELECT CENTER_LAT, CENTER_LON INTO v_lat, v_lon
            FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY WHERE REGION_NAME = :v_region LIMIT 1;
        EXCEPTION WHEN OTHER THEN v_lat := NULL;
        END;
    END IF;
    IF (v_lat IS NULL) THEN v_lat := 37.7749; v_lon := -122.4194; END IF;
    v_temp := FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT(v_lat, v_lon, v_model_date, v_lead_hours, 'temperature');
    IF (v_temp:error IS NOT NULL) THEN
        v_model_date := DATEADD('day', -1, CURRENT_DATE());
        v_lead_hours := HOUR(CURRENT_TIMESTAMP()) + 24;
        v_temp := FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT(v_lat, v_lon, v_model_date, v_lead_hours, 'temperature');
    END IF;
    v_wind := FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT(v_lat, v_lon, v_model_date, v_lead_hours, 'wind_speed');
    v_rain := FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT(v_lat, v_lon, v_model_date, v_lead_hours, 'precipitation');
    v_vis := FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT(v_lat, v_lon, v_model_date, v_lead_hours, 'visibility');
    v_humidity := FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT(v_lat, v_lon, v_model_date, v_lead_hours, 'humidity');
    v_pressure := FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT(v_lat, v_lon, v_model_date, v_lead_hours, 'pressure');
    v_cloud := FLEET_INTELLIGENCE.ROUTING_AGENT.GET_WEATHER_AT_POINT(v_lat, v_lon, v_model_date, v_lead_hours, 'cloud');
    RETURN OBJECT_CONSTRUCT(
        'status', CASE WHEN v_temp:error IS NOT NULL THEN 'PARTIAL' ELSE 'SUCCESS' END,
        'region', v_region, 'location', OBJECT_CONSTRUCT('lat', v_lat, 'lon', v_lon),
        'geometry', OBJECT_CONSTRUCT('type', 'Point', 'coordinates', ARRAY_CONSTRUCT(v_lon, v_lat)),
        'timestamp', CURRENT_TIMESTAMP()::VARCHAR,
        'model_info', OBJECT_CONSTRUCT('model_date', v_model_date::VARCHAR, 'lead_hours', v_lead_hours),
        'conditions', OBJECT_CONSTRUCT('temperature', v_temp, 'wind_speed', v_wind, 'precipitation', v_rain, 'visibility', v_vis, 'humidity', v_humidity, 'pressure', v_pressure, 'cloud_cover', v_cloud),
        'routing_advisory', CASE
            WHEN v_temp:error IS NOT NULL THEN 'WEATHER DATA UNAVAILABLE: Proceed with default routing profiles.'
            WHEN v_vis:value::FLOAT < 1000 THEN 'LOW VISIBILITY WARNING: Fog detected. Avoid cycling/walking.'
            WHEN v_wind:value::FLOAT > 10 THEN 'HIGH WIND WARNING: Wind > 10 m/s. E-bike routes unsafe.'
            WHEN v_rain:value::FLOAT > 2 THEN 'HEAVY RAIN: >2mm/hr. Increase ETAs 20%. Avoid cycling.'
            WHEN v_rain:value::FLOAT > 0.5 THEN 'LIGHT RAIN: Cycling OK with caution.'
            ELSE 'CONDITIONS CLEAR: All routing profiles safe.'
        END,
        'source', 'Met Office Global Deterministic 10km (Open Government Licence)'
    );
EXCEPTION
    WHEN OTHER THEN
        RETURN OBJECT_CONSTRUCT('error', 'TOOL_WEATHER failed: ' || SQLERRM, 'sqlcode', SQLCODE, 'status', 'FAILED');
END;
$$;
