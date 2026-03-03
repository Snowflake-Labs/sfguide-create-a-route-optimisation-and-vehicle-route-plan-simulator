-- Historic Flood Outlines loader and per-area summary
-- Place your EA Historic Flood Outlines GeoJSON at the path below before running
-- Example path: /Users/boconnor/using-a-native-app-to-build-a-route-optimisation-simulator-hands-on-lab/uk_storms/historic/historic_flood_outlines.geojson

use database UK_STORMS_DB;
use schema PUBLIC;

-- Stage and file format
create or replace file format GEOJSON_HFO
  type = json
  strip_outer_array = false
  compression = auto;

create or replace stage HFO_STAGE;

-- Raw and curated tables
create or replace transient table HFO_RAW (RAW variant);

create or replace table HISTORIC_FLOOD_OUTLINES (
  PROPERTIES variant,
  GEOMETRY variant,
  GEOG geography
);

-- Upload local file to stage (edit path if needed)
put file:///Users/boconnor/using-a-native-app-to-build-a-route-optimisation-simulator-hands-on-lab/uk_storms/historic/historic_flood_outlines.geojson @HFO_STAGE auto_compress=false;

-- Load into RAW
copy into HFO_RAW
  from @HFO_STAGE
  files = ('historic_flood_outlines.geojson')
  file_format = (format_name = GEOJSON_HFO)
  on_error = 'abort_statement'
  force = true;

-- Parse FeatureCollection into curated table, transforming BNG (EPSG:27700) -> WGS84 (EPSG:4326)
insert overwrite into HISTORIC_FLOOD_OUTLINES (PROPERTIES, GEOMETRY, GEOG)
select
  feature:properties as PROPERTIES,
  feature:geometry as GEOMETRY,
  to_geography(
    st_transform(
      st_setsrid(to_geometry(feature:geometry), 27700),
      4326
    )
  ) as GEOG
from HFO_RAW,
  lateral flatten(input => RAW:features) f,
  lateral (select f.value as feature);

-- Per-FRA historic summary (overlap and counts)
create or replace view FLOOD_RISK_AREAS_HISTORY as
select
  fra.FRA_ID,
  fra.FRA_NAME,
  count(*) as HISTORIC_OUTLINE_COUNT,
  sum(st_area(st_intersection(fra.GEOG, hfo.GEOG))) as INTERSECT_AREA_M2,
  st_area(fra.GEOG) as FRA_AREA_M2,
  case when st_area(fra.GEOG) > 0 then (sum(st_area(st_intersection(fra.GEOG, hfo.GEOG))) / st_area(fra.GEOG)) else null end as INTERSECT_AREA_PCT
from FLOOD_RISK_AREAS fra
join HISTORIC_FLOOD_OUTLINES hfo
  on st_intersects(fra.GEOG, hfo.GEOG)
group by fra.FRA_ID, fra.FRA_NAME, fra.GEOG;

-- Quick checks
-- select * from FLOOD_RISK_AREAS_HISTORY order by INTERSECT_AREA_PCT desc limit 20;
