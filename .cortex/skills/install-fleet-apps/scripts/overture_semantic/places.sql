-- Overture Places semantic layer: normalized view, category vocabulary and
-- search, and SV_OVERTURE_PLACES. Rendered by prepare_overture.py; $ns, $sv,
-- $src, $comment and $warehouse come from contract constants, never input.
-- Category reads TAXONOMY (the share dropped CATEGORIES).
create or replace view $ns.PLACE comment = $comment as
select id::varchar as id, geometry as geom,
       names:primary::varchar as name,
       coalesce(taxonomy:primary::varchar, basic_category::varchar) as category,
       basic_category::varchar as basic_category,
       brand:names:primary::varchar as brand,
       confidence::float as confidence,
       operating_status::varchar as operating_status,
       addresses[0]:country::varchar as country,
       addresses[0]:region::varchar as region,
       addresses[0]:locality::varchar as locality,
       addresses[0]:postcode::varchar as postcode,
       addresses[0]:freeform::varchar as street_address,
       websites[0]::varchar as website,
       phones[0]::varchar as phone,
       st_y(geometry)::float as latitude, st_x(geometry)::float as longitude,
       h3_point_to_cell_string(geometry, 8) as h3_cell,
       bbox:xmin::float as bbox_xmin, bbox:xmax::float as bbox_xmax,
       bbox:ymin::float as bbox_ymin, bbox:ymax::float as bbox_ymax
from $src.PLACE
-- statement
create table if not exists $ns.CATEGORY_VOCAB
change_tracking = true data_retention_time_in_days = 1 comment = $comment as
select category, any_value(basic_category) as basic_category, count(*) as place_count,
       replace(category, '_', ' ') || ' (Overture place category: ' || category || ')' as search_text
from $ns.PLACE
where category is not null
group by category
-- statement
create cortex search service if not exists $ns.OVERTURE_CATEGORY_SEARCH
on search_text attributes category, basic_category
warehouse = $warehouse target_lag = '12 hours'
comment = $comment
as select category, basic_category, place_count, search_text from $ns.CATEGORY_VOCAB
-- statement
create or replace semantic view $sv.SV_OVERTURE_PLACES
tables (
    places as $ns.PLACE primary key (ID)
        comment = 'Overture Maps points of interest, worldwide public reference data. One point per ID.'
)
facts (
    places.geometry as GEOM
        comment = 'Point GEOGRAPHY. Use with literal coordinates in ST_DWITHIN / ST_DISTANCE.',
    places.latitude as LATITUDE,
    places.longitude as LONGITUDE,
    places.confidence as CONFIDENCE comment = 'Source confidence 0..1.',
    places.bbox_xmin as BBOX_XMIN comment = 'Minimum longitude. Filter bbox_* first: it prunes storage.',
    places.bbox_xmax as BBOX_XMAX,
    places.bbox_ymin as BBOX_YMIN,
    places.bbox_ymax as BBOX_YMAX
)
dimensions (
    places.place_id as ID,
    places.name as NAME,
    places.category as CATEGORY
        comment = 'Exact primary category tag, e.g. hospital, cafe. Resolve with overture_category_search first.',
    places.basic_category as BASIC_CATEGORY comment = 'Coarser category group, e.g. financial_service.',
    places.brand as BRAND,
    places.operating_status as OPERATING_STATUS,
    places.country as COUNTRY comment = 'ISO 3166-1 alpha-2, e.g. US, GB.',
    places.region as REGION comment = 'Bare region code, e.g. CA, NY, ENG. Not US-CA.',
    places.locality as LOCALITY comment = 'Address locality (city). Not exact boundary containment.',
    places.postcode as POSTCODE,
    places.street_address as STREET_ADDRESS,
    places.website as WEBSITE,
    places.phone as PHONE,
    places.h3_cell as H3_CELL comment = 'H3 index string at fixed resolution 8.'
)
metrics (
    places.place_count as count(places.ID),
    places.avg_confidence as avg(places.CONFIDENCE),
    places.map_latitude as any_value(places.LATITUDE)
        comment = 'Use only grouped by place_id; otherwise an arbitrary point.',
    places.map_longitude as any_value(places.LONGITUDE)
        comment = 'Use only grouped by place_id; otherwise an arbitrary point.'
)
comment = $comment
ai_sql_generation 'Overture Places is a public worldwide snapshot, not fleet data.
Scope spatially with bbox_xmin >= W AND bbox_xmax <= E AND bbox_ymin >= S AND bbox_ymax <= N
whenever a place, city or coordinate is given: it prunes storage. Use ST_DWITHIN / ST_DISTANCE
on geometry with literal coordinates (longitude first) for radius and distance, in metres.
Geometry is GEOGRAPHY, not JSON; never GET_PATH or GROUP BY it. Group map coordinates by place_id,
never name alone. Region is a bare code (CA). Use the exposed h3_cell (resolution 8).
Use literal values, not semantic variables.'
ai_verified_queries (
    sf_hospitals as (
        question 'Show up to 200 hospitals in San Francisco, California on a map with their names.'
        sql 'select id as place_id, name, latitude, longitude from $ns.PLACE
where bbox_xmin >= -122.52 and bbox_xmax <= -122.35 and bbox_ymin >= 37.70 and bbox_ymax <= 37.83
  and category = ''hospital'' and locality = ''San Francisco'' and region = ''CA''
order by name limit 200'),
    nearby_cafes as (
        question 'Find the 20 nearest cafes within 1 km of longitude -122.3937, latitude 37.7955 with distance in metres.'
        sql 'select id as place_id, name, latitude, longitude,
       round(st_distance(geom, st_makepoint(-122.3937, 37.7955))) as distance_m
from $ns.PLACE
where bbox_xmin >= -122.41 and bbox_xmax <= -122.38 and bbox_ymin >= 37.786 and bbox_ymax <= 37.805
  and category = ''cafe'' and st_dwithin(geom, st_makepoint(-122.3937, 37.7955), 1000)
order by distance_m limit 20'),
    sf_density as (
        question 'Map the density of places in San Francisco, California using H3 hexagons, colored by place count, top 500 cells.'
        sql 'select h3_cell, count(id) as place_count from $ns.PLACE
where bbox_xmin >= -122.52 and bbox_xmax <= -122.35 and bbox_ymin >= 37.70 and bbox_ymax <= 37.83
  and locality = ''San Francisco'' and region = ''CA''
group by h3_cell order by place_count desc limit 500'),
    top_brands_london as (
        question 'Which 10 brands have the most places in London?'
        sql 'select brand, count(id) as place_count from $ns.PLACE
where bbox_xmin >= -0.51 and bbox_xmax <= 0.33 and bbox_ymin >= 51.28 and bbox_ymax <= 51.69
  and brand is not null and country = ''GB''
group by brand order by place_count desc limit 10')
)
