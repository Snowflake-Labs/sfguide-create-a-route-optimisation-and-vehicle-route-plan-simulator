-- Overture Transportation semantic layer: road, rail and water segments.
-- 353M rows / 150 GB globally: every query must be bounded by bbox_*.
-- CONNECTOR is not modeled (no analytic attributes). Speed limit is the first
-- unconditional rule only (no between / when), converted to km/h.
-- Rendered by prepare_overture.py from contract constants only.
create or replace view $ns.SEGMENT comment = $comment as
select id::varchar as id, geometry as geom,
       names:primary::varchar as name,
       subtype::varchar as subtype, class::varchar as class, subclass::varchar as subclass,
       road_surface[0]:value::varchar as surface,
       iff(speed_limits[0]:between is null and speed_limits[0]:when is null,
           speed_limits[0]:max_speed:value::float
             * iff(speed_limits[0]:max_speed:unit::varchar = 'mph', 1.609344, 1),
           null) as speed_limit_kmh,
       st_length(geometry) / 1000 as length_km,
       st_asgeojson(geometry)::varchar as geojson,
       bbox:xmin::float as bbox_xmin, bbox:xmax::float as bbox_xmax,
       bbox:ymin::float as bbox_ymin, bbox:ymax::float as bbox_ymax
from $src.SEGMENT
-- statement
create or replace semantic view $sv.SV_OVERTURE_TRANSPORTATION
tables (
    segments as $ns.SEGMENT primary key (ID)
        comment = 'Overture Maps transportation segments (roads, rail, water), worldwide public reference data. Not the routing graph.'
)
facts (
    segments.geometry as GEOM comment = 'LineString GEOGRAPHY.',
    segments.length_km as LENGTH_KM,
    segments.speed_limit_kmh as SPEED_LIMIT_KMH comment = 'Posted unconditional maximum speed; NULL when absent or conditional.',
    segments.bbox_xmin as BBOX_XMIN comment = 'REQUIRED filter. Minimum longitude.',
    segments.bbox_xmax as BBOX_XMAX comment = 'REQUIRED filter. Maximum longitude.',
    segments.bbox_ymin as BBOX_YMIN comment = 'REQUIRED filter. Minimum latitude.',
    segments.bbox_ymax as BBOX_YMAX comment = 'REQUIRED filter. Maximum latitude.'
)
dimensions (
    segments.segment_id as ID,
    segments.name as NAME comment = 'Primary street or route name. Match with ILIKE.',
    segments.subtype as SUBTYPE comment = 'road, rail or water.',
    segments.road_class as CLASS
        comment = 'motorway, trunk, primary, secondary, tertiary, residential, service, footway, cycleway...',
    segments.subclass as SUBCLASS comment = 'e.g. link, sidewalk, crosswalk, driveway.',
    segments.surface as SURFACE comment = 'paved, unpaved, gravel...'
)
metrics (
    segments.segment_count as count(segments.ID),
    segments.total_length_km as sum(segments.LENGTH_KM),
    segments.avg_speed_limit_kmh as avg(segments.SPEED_LIMIT_KMH),
    segments.geojson as any_value(segments.GEOJSON) comment = 'Line shape for maps. Group by segment_id only.'
)
comment = $comment
ai_sql_generation 'Overture Transportation is a 353-million-row public worldwide table of road, rail and
water segments, not fleet data and not the routing graph (use the routing tools for travel time).
EVERY query MUST filter bbox_xmin >= W AND bbox_xmax <= E AND bbox_ymin >= S AND bbox_ymax <= N with
literal coordinates spanning at most about 0.5 degrees. A name filter alone, or a geometry predicate
alone, scans the whole table; if no area is given, ask for one instead of querying.
Roads are subtype = road. length_km is geodesic. Group map geometry by segment_id, never name alone.
Geometry is GEOGRAPHY: never GET_PATH or GROUP BY it. Use literal values, not semantic variables.'
ai_verified_queries (
    road_length_by_class as (
        question 'What is the total road length by road class in central San Francisco?'
        sql 'select class, round(sum(length_km), 1) as total_length_km, count(id) as segment_count from $ns.SEGMENT
where bbox_xmin >= -122.45 and bbox_xmax <= -122.39 and bbox_ymin >= 37.76 and bbox_ymax <= 37.81
  and subtype = ''road''
group by class order by total_length_km desc'),
    motorways_map as (
        question 'Show motorway and trunk road segments around Manchester on a map.'
        sql 'select id as segment_id, name, class, round(length_km, 2) as length_km, geojson from $ns.SEGMENT
where bbox_xmin >= -2.40 and bbox_xmax <= -2.10 and bbox_ymin >= 53.40 and bbox_ymax <= 53.56
  and subtype = ''road'' and class in (''motorway'', ''trunk'')
limit 500'),
    speed_limits as (
        question 'What is the average posted speed limit by road class in central London?'
        sql 'select class, round(avg(speed_limit_kmh), 1) as avg_speed_limit_kmh, count(speed_limit_kmh) as segments_with_limit
from $ns.SEGMENT
where bbox_xmin >= -0.20 and bbox_xmax <= -0.05 and bbox_ymin >= 51.48 and bbox_ymax <= 51.54
  and subtype = ''road''
group by class order by avg_speed_limit_kmh desc nulls last'),
    unpaved_roads as (
        question 'How many km of unpaved roads are there around Austin, Texas?'
        sql 'select round(sum(length_km), 1) as total_length_km from $ns.SEGMENT
where bbox_xmin >= -97.95 and bbox_xmax <= -97.55 and bbox_ymin >= 30.10 and bbox_ymax <= 30.50
  and subtype = ''road'' and surface in (''unpaved'', ''gravel'', ''dirt'')')
)
