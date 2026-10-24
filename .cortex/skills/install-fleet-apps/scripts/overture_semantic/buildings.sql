-- Overture Buildings semantic layer. 2.5B rows / 644 GB globally. Measured on
-- wgb26798: a bbox_* filter scanned 15 GB in 1.8 s; the same box as an
-- ST_INTERSECTS predicate scanned all 644 GB in 14.5 min. Every query must be
-- bounded by bbox_*. BUILDING_PART is not modeled (duplicates BUILDING).
-- Rendered by prepare_overture.py from contract constants only.
-- Pruning depends on source clustering: an unclustered S3 copy prunes a
-- downtown-SF box 98% but a Berlin box only ~75% (measured partitions).
create or replace view $ns.BUILDING comment = $comment as
select id::varchar as id, geometry as geom,
       names:primary::varchar as name,
       subtype::varchar as subtype, class::varchar as class,
       height::float as height_m, num_floors::number as num_floors,
       is_underground::boolean as is_underground,
       roof_shape::varchar as roof_shape,
       st_area(geometry)::float as footprint_sqm,
       st_y(st_centroid(geometry))::float as latitude,
       st_x(st_centroid(geometry))::float as longitude,
       h3_point_to_cell_string(st_centroid(geometry), 8) as h3_cell,
       st_asgeojson(geometry)::varchar as geojson,
       bbox:xmin::float as bbox_xmin, bbox:xmax::float as bbox_xmax,
       bbox:ymin::float as bbox_ymin, bbox:ymax::float as bbox_ymax
from $src.BUILDING
-- statement
create or replace semantic view $sv.SV_OVERTURE_BUILDINGS
tables (
    buildings as $ns.BUILDING primary key (ID)
        comment = 'Overture Maps building footprints, worldwide public reference data (2.5 billion rows).'
)
facts (
    buildings.geometry as GEOM comment = 'Footprint polygon GEOGRAPHY.',
    buildings.height_m as HEIGHT_M comment = 'Height in metres; often NULL.',
    buildings.num_floors as NUM_FLOORS comment = 'Often NULL.',
    buildings.footprint_sqm as FOOTPRINT_SQM,
    buildings.latitude as LATITUDE comment = 'Footprint centroid.',
    buildings.longitude as LONGITUDE comment = 'Footprint centroid.',
    buildings.bbox_xmin as BBOX_XMIN comment = 'REQUIRED filter. Minimum longitude.',
    buildings.bbox_xmax as BBOX_XMAX comment = 'REQUIRED filter. Maximum longitude.',
    buildings.bbox_ymin as BBOX_YMIN comment = 'REQUIRED filter. Minimum latitude.',
    buildings.bbox_ymax as BBOX_YMAX comment = 'REQUIRED filter. Maximum latitude.'
)
dimensions (
    buildings.building_id as ID,
    buildings.name as NAME,
    buildings.subtype as SUBTYPE comment = 'residential, commercial, industrial, education, medical, civic...',
    buildings.building_class as CLASS comment = 'Finer type, e.g. house, apartments, warehouse.',
    buildings.is_underground as IS_UNDERGROUND,
    buildings.roof_shape as ROOF_SHAPE,
    buildings.h3_cell as H3_CELL comment = 'H3 index string of the centroid at resolution 8.'
)
metrics (
    buildings.building_count as count(buildings.ID),
    buildings.total_footprint_sqm as sum(buildings.FOOTPRINT_SQM),
    buildings.avg_height_m as avg(buildings.HEIGHT_M),
    buildings.max_height_m as max(buildings.HEIGHT_M),
    buildings.geojson as any_value(buildings.GEOJSON) comment = 'Footprint for maps. Group by building_id only.'
)
comment = $comment
ai_sql_generation 'Overture Buildings is a 2.5-billion-row public worldwide table, not fleet data.
EVERY query MUST filter bbox_xmin >= W AND bbox_xmax <= E AND bbox_ymin >= S AND bbox_ymax <= N with
literal coordinates spanning at most about 0.2 degrees. A geometry predicate (ST_INTERSECTS, ST_DWITHIN)
or any other filter WITHOUT the bbox filters scans 644 GB for minutes; if no area is given, ask for one
instead of querying. Add a geometry predicate only on top of the bbox filters. Height, floors, subtype
and class are often NULL (most footprints are untyped outside major cities), so state coverage and
never present a zero typed count as absence. Group map footprints by building_id and cap map rows at 1000.
Geometry is GEOGRAPHY: never GET_PATH or GROUP BY it. Use literal values, not semantic variables.'
ai_verified_queries (
    tallest_buildings as (
        question 'What are the 10 tallest buildings in downtown San Francisco? Show them on a map.'
        sql 'select id as building_id, name, height_m, num_floors, geojson from $ns.BUILDING
where bbox_xmin >= -122.41 and bbox_xmax <= -122.39 and bbox_ymin >= 37.78 and bbox_ymax <= 37.80
  and height_m is not null
order by height_m desc limit 10'),
    building_types as (
        question 'How many buildings of each subtype are there in central Manchester, and what is their total footprint?'
        sql 'select subtype, count(id) as building_count, round(sum(footprint_sqm)) as total_footprint_sqm from $ns.BUILDING
where bbox_xmin >= -2.26 and bbox_xmax <= -2.22 and bbox_ymin >= 53.47 and bbox_ymax <= 53.49
group by subtype order by building_count desc'),
    building_density as (
        question 'Map building density in central Berlin with H3 hexagons, top 500 cells.'
        sql 'select h3_cell, count(id) as building_count from $ns.BUILDING
where bbox_xmin >= 13.36 and bbox_xmax <= 13.44 and bbox_ymin >= 52.49 and bbox_ymax <= 52.54
group by h3_cell order by building_count desc limit 500'),
    commercial_near_point as (
        question 'Find commercial buildings within 1 km of longitude -122.40, latitude 37.79 on a map.'
        sql 'select id as building_id, name, class, round(footprint_sqm) as footprint_sqm, geojson from $ns.BUILDING
where bbox_xmin >= -122.412 and bbox_xmax <= -122.388 and bbox_ymin >= 37.781 and bbox_ymax <= 37.799
  and subtype = ''commercial'' and st_dwithin(geom, st_makepoint(-122.40, 37.79), 1000)
limit 1000')
)
