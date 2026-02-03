-- Optional: set your role/warehouse if needed
-- use role <YOUR_ROLE>;
-- use warehouse <YOUR_WAREHOUSE>;

-- Create and select a workspace
create database if not exists UK_STORMS_DB;
use database UK_STORMS_DB;
create schema if not exists PUBLIC;
use schema PUBLIC;

-- CSV file format for storms CSV (quoted, UTF-8, long-text)
create or replace file format CSV_UK_STORMS
  type = csv
  field_delimiter = ','
  skip_header = 1
  field_optionally_enclosed_by = '"'
  encoding = 'UTF8'
  null_if = ('\\N','NULL')
  empty_field_as_null = false
  trim_space = false
  error_on_column_count_mismatch = true
  replace_invalid_characters = true
  multi_line = true;

-- JSON file format for GeoJSON
create or replace file format GEOJSON_FORMAT
  type = json
  strip_outer_array = false
  compression = auto;

-- Stage for flood risk data
create or replace stage FLOOD_RISK_STAGE;

-- Target tables
create or replace table UK_STORMS (
  NAME string,
  DATES string,
  DESCRIPTION string,
  UK_FATALITIES string,
  SOURCE string,
  NEWS_SUMMARY string
);

create or replace table FLOOD_RISK_AREAS (
  FEATURE variant,
  PROPERTIES variant,
  GEOMETRY variant
);

create or replace transient table FLOOD_RISK_RAW (RAW variant);

-- Load UK storms CSV via table stage
put file:///Users/boconnor/using-a-native-app-to-build-a-route-optimisation-simulator-hands-on-lab/uk_storms/uk_storms.csv @%UK_STORMS auto_compress=false;
copy into UK_STORMS
  from @%UK_STORMS
  files = ('uk_storms.csv')
  file_format = (format_name = CSV_UK_STORMS)
  on_error = 'abort_statement'
  force = true;

-- Load Flood Risk Areas GeoJSON
put file:///Users/boconnor/using-a-native-app-to-build-a-route-optimisation-simulator-hands-on-lab/uk_storms/flood_risk/Flood_Risk_Areas.geojson @FLOOD_RISK_STAGE auto_compress=false;
copy into FLOOD_RISK_RAW
  from @FLOOD_RISK_STAGE
  files = ('Flood_Risk_Areas.geojson')
  file_format = (format_name = GEOJSON_FORMAT)
  on_error = 'abort_statement'
  force = true;

-- Insert one row per feature into final table
insert overwrite into FLOOD_RISK_AREAS (FEATURE, PROPERTIES, GEOMETRY)
select
  feature as FEATURE,
  feature:properties as PROPERTIES,
  feature:geometry as GEOMETRY
from FLOOD_RISK_RAW,
  lateral flatten(input => RAW:features) f,
  lateral (select f.value as feature);

-- Optional checks
-- select count(*) as storms_rows from UK_STORMS;
-- select count(*) as flood_risk_rows from FLOOD_RISK_AREAS;
-- select properties:Risk_Area_Ref::string as ref from FLOOD_RISK_AREAS limit 5;
