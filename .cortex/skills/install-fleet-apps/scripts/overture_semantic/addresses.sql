-- Overture Addresses semantic layer. 475M rows globally: every query must be
-- bounded by bbox_* (measured: the bbox prunes, a geometry predicate scans all).
-- Rendered by prepare_overture.py from contract constants only.
create or replace view $ns.ADDRESS comment = $comment as
select id::varchar as id, geometry as geom,
       street::varchar as street, number::varchar as house_number, unit::varchar as unit,
       postcode::varchar as postcode,
       coalesce(postal_city::varchar,
                address_levels[array_size(address_levels) - 1]:value::varchar) as city,
       address_levels[0]:value::varchar as region,
       country::varchar as country,
       st_y(geometry)::float as latitude, st_x(geometry)::float as longitude,
       h3_point_to_cell_string(geometry, 8) as h3_cell,
       bbox:xmin::float as bbox_xmin, bbox:xmax::float as bbox_xmax,
       bbox:ymin::float as bbox_ymin, bbox:ymax::float as bbox_ymax
from $src.ADDRESS
-- statement
create or replace semantic view $sv.SV_OVERTURE_ADDRESSES
tables (
    addresses as $ns.ADDRESS primary key (ID)
        comment = 'Overture Maps address points, worldwide public reference data (475M rows). Coverage varies by country.'
)
facts (
    addresses.geometry as GEOM comment = 'Point GEOGRAPHY.',
    addresses.latitude as LATITUDE,
    addresses.longitude as LONGITUDE,
    addresses.bbox_xmin as BBOX_XMIN comment = 'REQUIRED filter. Minimum longitude.',
    addresses.bbox_xmax as BBOX_XMAX comment = 'REQUIRED filter. Maximum longitude.',
    addresses.bbox_ymin as BBOX_YMIN comment = 'REQUIRED filter. Minimum latitude.',
    addresses.bbox_ymax as BBOX_YMAX comment = 'REQUIRED filter. Maximum latitude.'
)
dimensions (
    addresses.address_id as ID,
    addresses.street as STREET comment = 'Street name; casing follows the source (often upper case in the US). Match with ILIKE.',
    addresses.house_number as HOUSE_NUMBER,
    addresses.unit as UNIT,
    addresses.postcode as POSTCODE,
    addresses.city as CITY comment = 'Postal city, else the most specific address level.',
    addresses.region as REGION comment = 'Top address level, e.g. CA, BW. Bare code.',
    addresses.country as COUNTRY comment = 'ISO alpha-2.',
    addresses.h3_cell as H3_CELL comment = 'H3 index string at resolution 8.'
)
metrics (
    addresses.address_count as count(addresses.ID),
    addresses.map_latitude as any_value(addresses.LATITUDE) comment = 'Group by address_id only.',
    addresses.map_longitude as any_value(addresses.LONGITUDE) comment = 'Group by address_id only.'
)
comment = $comment
ai_sql_generation 'Overture Addresses is a 475-million-row public worldwide table, not fleet data.
EVERY query MUST filter bbox_xmin >= W AND bbox_xmax <= E AND bbox_ymin >= S AND bbox_ymax <= N
with literal coordinates spanning at most about 0.5 degrees. A city or postcode filter alone, or a
geometry predicate alone, scans the whole table; if no area is given, ask for one instead of querying.
Match street with ILIKE. Use ST_DWITHIN / ST_DISTANCE on geometry with literal coordinates (longitude
first) for radius queries, in metres. Geometry is GEOGRAPHY: never GET_PATH or GROUP BY it.
Group map coordinates by address_id. Use literal values, not semantic variables.'
ai_verified_queries (
    street_addresses as (
        question 'List the addresses on Hyde Street near Pine Street in San Francisco on a map.'
        sql 'select id as address_id, house_number, street, postcode, latitude, longitude from $ns.ADDRESS
where bbox_xmin >= -122.420 and bbox_xmax <= -122.415 and bbox_ymin >= 37.788 and bbox_ymax <= 37.792
  and street ilike ''hyde st%''
order by try_to_number(house_number) limit 200'),
    nearest_address as (
        question 'What is the nearest address to longitude -122.4194, latitude 37.7749?'
        sql 'select id as address_id, house_number, street, city, postcode,
       round(st_distance(geom, st_makepoint(-122.4194, 37.7749))) as distance_m
from $ns.ADDRESS
where bbox_xmin >= -122.4224 and bbox_xmax <= -122.4164 and bbox_ymin >= 37.7725 and bbox_ymax <= 37.7773
order by distance_m limit 1'),
    postcode_counts as (
        question 'How many addresses are there per postcode in central San Francisco?'
        sql 'select postcode, count(id) as address_count from $ns.ADDRESS
where bbox_xmin >= -122.45 and bbox_xmax <= -122.39 and bbox_ymin >= 37.76 and bbox_ymax <= 37.81
group by postcode order by address_count desc limit 50'),
    address_density as (
        question 'Map address density in central Berlin with H3 hexagons, top 500 cells.'
        sql 'select h3_cell, count(id) as address_count from $ns.ADDRESS
where bbox_xmin >= 13.30 and bbox_xmax <= 13.48 and bbox_ymin >= 52.47 and bbox_ymax <= 52.56
group by h3_cell order by address_count desc limit 500')
)
