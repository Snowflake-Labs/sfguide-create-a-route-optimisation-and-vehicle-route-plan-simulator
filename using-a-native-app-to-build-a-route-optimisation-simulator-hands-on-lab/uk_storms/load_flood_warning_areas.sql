-- Flood Warning Areas (FWA) loader and joins to historic warnings + FRA
-- Place EA Flood Warning Areas GeoJSON at the path below before running
-- Example path: /Users/boconnor/using-a-native-app-to-build-a-route-optimisation-simulator-hands-on-lab/uk_storms/historic/flood_warning_areas.geojson

use database UK_STORMS_DB;
use schema PUBLIC;

-- File format and stage
create or replace file format GEOJSON_FWA
  type = json
  strip_outer_array = false
  compression = auto;

create or replace stage FWA_STAGE;

-- Raw + curated
create or replace transient table FWA_RAW (RAW variant);

create or replace table FLOOD_WARNING_AREAS (
  PROPERTIES variant,
  GEOMETRY variant,
  GEOG geography,
  CODE string,
  AREA_NAME string
);

-- Upload local file to stage (edit path if needed)
put file:///Users/boconnor/using-a-native-app-to-build-a-route-optimisation-simulator-hands-on-lab/uk_storms/historic/flood_warning_areas.geojson @FWA_STAGE auto_compress=false;

-- Load raw
copy into FWA_RAW
  from @FWA_STAGE
  files = ('flood_warning_areas.geojson')
  file_format = (format_name = GEOJSON_FWA)
  on_error = 'abort_statement'
  force = true;

-- Parse FeatureCollection; most EA layers are BNG (27700) -> transform to 4326
insert overwrite into FLOOD_WARNING_AREAS (PROPERTIES, GEOMETRY, GEOG, CODE, AREA_NAME)
select
  feature:properties as PROPERTIES,
  feature:geometry as GEOMETRY,
  to_geography(
    st_transform(
      st_setsrid(to_geometry(feature:geometry), 27700),
      4326
    )
  ) as GEOG,
  coalesce(feature:properties:code::string, feature:properties:warningareaid::string, feature:properties:WARNING_AREA_ID::string) as CODE,
  coalesce(feature:properties:name::string, feature:properties:WARNING_AREA_NAME::string) as AREA_NAME
from FWA_RAW,
  lateral flatten(input => RAW:features) f,
  lateral (select f.value as feature);

-- Basic index-like clustering
-- alter table FLOOD_WARNING_AREAS cluster by (CODE);

-- Summaries: warnings per FWA code
create or replace view FWA_WARNINGS_SUMMARY as
select
  upper(fwa.CODE) as CODE,
  any_value(fwa.AREA_NAME) as AREA_NAME,
  count(*) as WARN_COUNT,
  min(w.EVENT_TS) as FIRST_WARN_TS,
  max(w.EVENT_TS) as LAST_WARN_TS,
  sum(case when w.EVENT_TS >= dateadd(year,-5,current_timestamp()) then 1 else 0 end) as WARN_COUNT_5Y
from FLOOD_WARNING_AREAS fwa
join FWS_WARNINGS_CLEAN w
  on upper(w.CODE) = upper(fwa.CODE)
where fwa.CODE is not null
group by upper(fwa.CODE);

-- Roll up to Flood Risk Areas by spatial intersection
-- Requires FRA GEOG and FWA GEOG
create or replace view FRA_WARNINGS_FROM_FWA as
select
  fra.FRA_ID,
  fra.FRA_NAME,
  sum(coalesce(s.WARN_COUNT,0)) as WARN_COUNT,
  min(s.FIRST_WARN_TS) as FIRST_WARN_TS,
  max(s.LAST_WARN_TS) as LAST_WARN_TS,
  sum(coalesce(s.WARN_COUNT_5Y,0)) as WARN_COUNT_5Y
from FLOOD_RISK_AREAS fra
left join FLOOD_WARNING_AREAS fwa
  on st_intersects(fra.GEOG, fwa.GEOG)
left join FWA_WARNINGS_SUMMARY s
  on upper(s.CODE) = upper(fwa.CODE)
group by fra.FRA_ID, fra.FRA_NAME, fra.GEOG;

-- Quick checks
-- select * from FWA_WARNINGS_SUMMARY order by WARN_COUNT desc limit 20;
-- select * from FRA_WARNINGS_FROM_FWA order by WARN_COUNT desc limit 20;
