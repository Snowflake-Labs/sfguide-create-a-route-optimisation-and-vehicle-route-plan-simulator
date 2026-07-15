-- SV_CATCHMENT - Catchment demo semantic view
-- Source: FLEET_INTELLIGENCE.CATCHMENT.POIS + CITIES_BY_STATE
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- GEOMETRY GEOGRAPHY column excluded; lat/lon retained on base view but not modeled as metrics.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"sv-catchment"}}';

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_CATCHMENT

  TABLES (
    pois AS FLEET_INTELLIGENCE.CATCHMENT.POIS
      PRIMARY KEY (POI_ID)
    , cities AS FLEET_INTELLIGENCE.CATCHMENT.CITIES_BY_STATE
      PRIMARY KEY (REGION, STATE, CITY)
  )

  FACTS (
    cities.city_poi_count AS POI_COUNT COMMENT = 'Precomputed POI count for a city'
  )

  DIMENSIONS (
    pois.poi_name AS POI_NAME WITH SYNONYMS ('place', 'location name') COMMENT = 'POI name'
    , pois.basic_category AS BASIC_CATEGORY WITH SYNONYMS ('category', 'type') COMMENT = 'POI category (coffee_shop, restaurant, grocery_store, etc.)'
    , pois.city AS CITY COMMENT = 'POI city'
    , pois.state AS STATE COMMENT = 'POI state'
    , pois.postcode AS POSTCODE WITH SYNONYMS ('zip', 'postal code') COMMENT = 'POI postcode'
    , pois.address AS ADDRESS COMMENT = 'POI street address'
    , pois.region AS REGION COMMENT = 'Region'
    , cities.cities_state AS STATE COMMENT = 'State (cities aggregate)'
    , cities.cities_city AS CITY COMMENT = 'City (cities aggregate)'
    , cities.cities_region AS REGION COMMENT = 'Region (cities aggregate)'
  )

  METRICS (
    pois.total_pois AS COUNT(DISTINCT POI_ID) WITH SYNONYMS ('number of pois', 'poi count', 'locations') COMMENT = 'Distinct POI count'
    , pois.unique_cities AS COUNT(DISTINCT CITY) WITH SYNONYMS ('number of cities') COMMENT = 'Distinct cities'
    , pois.unique_categories AS COUNT(DISTINCT BASIC_CATEGORY) WITH SYNONYMS ('number of categories') COMMENT = 'Distinct POI categories'
    , cities.total_city_pois AS SUM(city_poi_count) WITH SYNONYMS ('total pois by city') COMMENT = 'Total POIs across cities (precomputed)'
  )

  COMMENT = 'Catchment demo: points of interest by category/city/state, plus precomputed POI counts per city.'

  AI_SQL_GENERATION 'Catchment semantic view.
Entities (two independent facts):
- pois (POIS): one row per POI. Use total_pois grouped by basic_category, city, or state for density/competition questions.
- cities (CITIES_BY_STATE): precomputed POI counts per city.
Conventions:
- "how many coffee shops in X" -> total_pois filtered by basic_category and city.
- "competition density" -> total_pois grouped by basic_category + city.'
;
