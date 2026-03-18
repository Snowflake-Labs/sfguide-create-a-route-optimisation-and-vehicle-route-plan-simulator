-- Optional: set your role/warehouse if needed
-- use role <YOUR_ROLE>;
-- use warehouse <YOUR_WAREHOUSE>;

-- Create and select a workspace
create database if not exists UK_STORMS_DB;
use database UK_STORMS_DB;
create schema if not exists PUBLIC;
use schema PUBLIC;

-- Create a file format for GeoJSON (JSON works)
create or replace file format GEOJSON_FORMAT
  type = json
  strip_outer_array = false
  compression = auto;

-- Create a stage for loading
create or replace stage FLOOD_RISK_STAGE;

-- Create target table: one row per feature
-- Store full feature, properties and geometry in VARIANT columns
create or replace table FLOOD_RISK_AREAS (
  FEATURE variant,
  PROPERTIES variant,
  GEOMETRY variant
);

-- Put local GeoJSON into the stage
put file:///Users/boconnor/uk_storms/flood_risk/Flood_Risk_Areas.geojson @FLOOD_RISK_STAGE auto_compress=false;

-- Load raw file into a transient landing table first (one VARIANT column)
create or replace transient table FLOOD_RISK_RAW (RAW variant);
copy into FLOOD_RISK_RAW
  from @FLOOD_RISK_STAGE
  files = ('Flood_Risk_Areas.geojson')
  file_format = (format_name = GEOJSON_FORMAT)
  on_error = 'abort_statement'
  force = true;

-- Insert one row per feature into the final table
-- GeoJSON is a FeatureCollection with features array
insert overwrite into FLOOD_RISK_AREAS (FEATURE, PROPERTIES, GEOMETRY)
select
  feature as FEATURE,
  feature:properties as PROPERTIES,
  feature:geometry as GEOMETRY
from FLOOD_RISK_RAW,
  lateral flatten(input => RAW:features) f,
  lateral (select f.value as feature);

-- Optional checks
-- select count(*) from FLOOD_RISK_AREAS;
-- select properties:Risk_Area_Ref::string as ref from FLOOD_RISK_AREAS limit 5;
