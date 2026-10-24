-- Overture Divisions semantic layer: administrative areas, labels and borders.
-- Rendered by prepare_overture.py from contract constants only.
create or replace view $ns.DIVISION comment = $comment as
select id::varchar as id, geometry as geom, names:primary::varchar as name,
       country::varchar as country, region::varchar as region,
       subtype::varchar as subtype, class::varchar as class,
       parent_division_id::varchar as parent_division_id,
       population::number as population, wikidata::varchar as wikidata,
       st_y(geometry)::float as latitude, st_x(geometry)::float as longitude
from $src.DIVISION
-- statement
create or replace view $ns.DIVISION_AREA comment = $comment as
select id::varchar as id, division_id::varchar as division_id, geometry as geom,
       names:primary::varchar as name, country::varchar as country,
       region::varchar as region, subtype::varchar as subtype, class::varchar as class,
       is_land::boolean as is_land,
       st_area(geometry) / 1e6 as area_sqkm,
       st_isvalid(geometry) as is_valid_geometry,
       st_asgeojson(st_simplify(geometry, 100))::varchar as geojson,
       bbox:xmin::float as bbox_xmin, bbox:xmax::float as bbox_xmax,
       bbox:ymin::float as bbox_ymin, bbox:ymax::float as bbox_ymax
from $src.DIVISION_AREA
-- statement
create or replace view $ns.DIVISION_BOUNDARY comment = $comment as
select id::varchar as id, geometry as geom, country::varchar as country,
       region::varchar as region, subtype::varchar as subtype,
       class::varchar as class, is_land::boolean as is_land,
       is_disputed::boolean as is_disputed,
       st_length(geometry) / 1000 as length_km,
       st_asgeojson(st_simplify(geometry, 100))::varchar as geojson
from $src.DIVISION_BOUNDARY
-- statement
create or replace semantic view $sv.SV_OVERTURE_DIVISIONS
tables (
    areas as $ns.DIVISION_AREA primary key (ID)
        comment = 'Administrative polygons (country, region, county, locality...). Land and maritime are separate rows.',
    divisions as $ns.DIVISION primary key (ID)
        comment = 'Administrative division labels as points, with population. Not containment polygons.',
    boundaries as $ns.DIVISION_BOUNDARY primary key (ID)
        comment = 'Border line segments between divisions.'
)
relationships (
    area_to_division as areas(DIVISION_ID) references divisions(ID)
)
facts (
    areas.geometry as GEOM
        comment = 'Exact polygon GEOGRAPHY for ST_CONTAINS / ST_INTERSECTS. Return geojson for maps.',
    areas.area_sqkm as AREA_SQKM
        comment = 'NULL for the few invalid source polygons (e.g. Russia, Australia); sort NULLS LAST.',
    areas.bbox_xmin as BBOX_XMIN, areas.bbox_xmax as BBOX_XMAX,
    areas.bbox_ymin as BBOX_YMIN, areas.bbox_ymax as BBOX_YMAX,
    divisions.geometry as GEOM,
    divisions.population_value as POPULATION,
    divisions.latitude as LATITUDE,
    divisions.longitude as LONGITUDE,
    boundaries.geometry as GEOM,
    boundaries.length_km as LENGTH_KM
)
dimensions (
    areas.area_id as ID comment = 'Include when returning one polygon per row.',
    areas.name as NAME,
    areas.country as COUNTRY comment = 'ISO alpha-2, e.g. US.',
    areas.region as REGION comment = 'ISO 3166-2 code, e.g. US-CA. Not CA.',
    areas.subtype as SUBTYPE comment = 'country, dependency, region, county, localadmin, locality, neighborhood...',
    areas.area_class as CLASS comment = 'land or maritime. Filter land for land areas and maps.',
    areas.is_land as IS_LAND,
    areas.is_valid_geometry as IS_VALID_GEOMETRY,
    divisions.division_id as ID,
    divisions.name as NAME,
    divisions.country as COUNTRY,
    divisions.region as REGION,
    divisions.subtype as SUBTYPE,
    divisions.parent_division_id as PARENT_DIVISION_ID,
    divisions.wikidata as WIKIDATA,
    boundaries.boundary_id as ID,
    boundaries.country as COUNTRY,
    boundaries.region as REGION,
    boundaries.subtype as SUBTYPE,
    boundaries.boundary_class as CLASS,
    boundaries.is_land as IS_LAND,
    boundaries.is_disputed as IS_DISPUTED
)
metrics (
    areas.area_count as count(areas.ID),
    areas.total_area_sqkm as sum(areas.AREA_SQKM),
    areas.geojson as any_value(areas.GEOJSON)
        comment = 'Map shape simplified by 100 m. Group by area_id, never name alone.',
    divisions.division_count as count(divisions.ID),
    divisions.total_population as sum(divisions.POPULATION)
        comment = 'Population coverage is incomplete; not a census total.',
    boundaries.total_length_km as sum(boundaries.LENGTH_KM),
    boundaries.geojson as any_value(boundaries.GEOJSON)
)
comment = $comment
ai_sql_generation 'Overture Divisions is public worldwide administrative geography, not fleet data.
Use exact geometry for predicates (ST_CONTAINS(geometry, ST_MAKEPOINT(lon, lat))) and the simplified
geojson only for display. Group map geometry by area_id, never name alone. Filter area_class = land for
land areas. Area and division region is ISO-prefixed (US-CA). Use subtype for hierarchy, not admin_level.
area_sqkm is NULL where the source polygon is invalid: always ORDER BY area_sqkm DESC NULLS LAST and say
which areas had no measurable area.
For point containment also filter bbox_xmin <= lon AND bbox_xmax >= lon AND bbox_ymin <= lat AND
bbox_ymax >= lat: it prunes storage. Geometry is GEOGRAPHY: never GET_PATH or GROUP BY it.
There is no modeled relationship to places, addresses, roads or buildings. Use literal values.'
ai_verified_queries (
    ca_counties as (
        question 'Show California county land boundaries on a map, colored by area in square kilometres.'
        sql 'select id as area_id, name, round(area_sqkm, 1) as area_sqkm, geojson from $ns.DIVISION_AREA
where region = ''US-CA'' and subtype = ''county'' and class = ''land'' order by area_sqkm desc nulls last'),
    reverse_geocode as (
        question 'Which US county contains longitude -122.4194, latitude 37.7749? Show its boundary.'
        sql 'select id as area_id, name, region, geojson from $ns.DIVISION_AREA
where bbox_xmin <= -122.4194 and bbox_xmax >= -122.4194 and bbox_ymin <= 37.7749 and bbox_ymax >= 37.7749
  and country = ''US'' and subtype = ''county'' and class = ''land''
  and st_contains(geom, st_makepoint(-122.4194, 37.7749))'),
    largest_countries as (
        question 'What are the 10 largest countries by land area?'
        sql 'select id as area_id, name, round(area_sqkm) as area_sqkm from $ns.DIVISION_AREA
where subtype = ''country'' and class = ''land'' order by area_sqkm desc nulls last limit 10'),
    populous_localities as (
        question 'Which 10 localities in Germany have the highest population?'
        sql 'select id as division_id, name, population from $ns.DIVISION
where country = ''DE'' and subtype = ''locality'' and population is not null
order by population desc limit 10')
)
