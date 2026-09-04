-- semantic_views_emergency.sql - Cortex Analyst semantic view for the Emergency
-- Response pack (SV_EMERGENCY_RESPONSE).
--
-- WHY THIS EXISTS
-- The emergency-response pack had NO semantic view at all, so every question about
-- hazard exposure, care-centre capacity or the participant population could only be
-- answered from the app's on-screen memo - and in Cowork, where there is no panel, not
-- at all. It is also the cleanest map story in the deployment: VW_HAZARD_ZONES already
-- carries a GeoJSON Polygon STRING, so Cowork's data_to_map can draw a hazard choropleth
-- straight from an Analyst result with no transformation and no routing engine involved.
--
-- SEPARATE FILE ON PURPOSE
-- The emergency pack is not part of every deployment (its data is produced by the
-- Data Studio emergency generator), so the installer runs this best-effort, the same
-- way it treats semantic_views_marketplace.sql. Keeping it out of semantic_views.sql
-- means a missing pack cannot abort the whole semantic layer - `snow sql -f` stops at
-- the first error, so one absent view would silently skip every view below it.
--
-- SCOPE: the evacuation INPUTS and the exposure picture. It does NOT model the solved
-- evacuation plan - the wizard computes that live per interaction (capacitated
-- multi-depot VRP through the routing contract) and never persists it, per Tenet 9.
-- Route "which van picks up whom" questions at the app, not at this view.
--
-- GRAIN MODEL (three independent facts, no relationships)
--   hazard_zones - one row per procedural hazard cell, with its polygon.
--   care_centers - one row per evacuation anchor / care centre.
--   participants - one row per person to be evacuated, with a nearest-centre label.
-- participants.nearest_center_id names a care centre but is deliberately NOT declared as
-- a relationship: it is a proximity label, not a dispatch assignment, and joining on it
-- would let the model present "assigned to" numbers that no plan produced.

ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","module":"semantic_views_emergency"}}';

CREATE SCHEMA IF NOT EXISTS FLEET_INTELLIGENCE.SEMANTIC
  COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql","component":"semantic-views"}}';

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_EMERGENCY_RESPONSE

  TABLES (
    hazard_zones AS FLEET_APP.EMERGENCY_RESPONSE.VW_HAZARD_ZONES
      PRIMARY KEY (REGION, GEOJSON)
      COMMENT = 'Procedural hazard cell with a GeoJSON Polygon boundary. Map-ready as-is.'
    , care_centers AS FLEET_APP.EMERGENCY_RESPONSE.VW_CARE_CENTERS
      PRIMARY KEY (CENTER_ID)
      COMMENT = 'Evacuation anchor / care centre. Standalone.'
    , participants AS FLEET_APP.EMERGENCY_RESPONSE.VW_PARTICIPANTS
      PRIMARY KEY (PARTICIPANT_ID)
      COMMENT = 'Person to evacuate. Standalone; nearest_center_id is a proximity label, not a dispatch assignment.'
  )

  FACTS (
    hazard_zones.wildfire_level AS WILDFIRE_LEVEL
      COMMENT = 'Ordinal wildfire hazard level for the cell'
    , hazard_zones.flood_level AS FLOOD_LEVEL
      COMMENT = 'Ordinal flood hazard level for the cell'
    , hazard_zones.composite_score AS COMPOSITE_SCORE
      COMMENT = 'Blended hazard score for the cell (higher is worse)'
  )

  DIMENSIONS (
    hazard_zones.zone_region AS REGION
      COMMENT = 'Region the hazard cell belongs to'
    , hazard_zones.zone_state AS STATE COMMENT = 'State'
    , hazard_zones.zone_county AS COUNTY COMMENT = 'County'
    , hazard_zones.hazard_geojson AS GEOJSON
      WITH SYNONYMS ('hazard boundary', 'hazard polygon', 'zone boundary')
      COMMENT = 'Map-ready hazard cell boundary, already a GeoJSON Polygon STRING. Use directly as the geo column of a geojson layer - no ST_ASGEOJSON needed.'
    , hazard_zones.composite_rating AS COMPOSITE_RATING
      WITH SYNONYMS ('risk band', 'hazard rating', 'risk rating', 'composite band')
      COMMENT = 'Blended hazard band (Very High, Relatively High, Relatively Moderate, Relatively Low)'
    , hazard_zones.wildfire_label AS WILDFIRE_LABEL
      WITH SYNONYMS ('wildfire band', 'wildfire rating')
      COMMENT = 'Wildfire hazard band'
    , hazard_zones.flood_label AS FLOOD_LABEL
      WITH SYNONYMS ('flood band', 'flood rating')
      COMMENT = 'Flood hazard band'
    , care_centers.center_id AS CENTER_ID
      WITH SYNONYMS ('centre', 'center', 'shelter', 'anchor')
      COMMENT = 'Care centre identifier'
    , care_centers.center_name AS CENTER_NAME COMMENT = 'Care centre name'
    , care_centers.center_category AS CATEGORY COMMENT = 'Care centre category / facility type'
    , care_centers.center_region AS REGION COMMENT = 'Region'
    , care_centers.center_city AS CITY COMMENT = 'Care centre city'
    , care_centers.center_lat AS LAT
      WITH SYNONYMS ('centre latitude')
      COMMENT = 'Care centre latitude. Map-ready: use with center_lon as a latlon layer.'
    , care_centers.center_lon AS LON
      WITH SYNONYMS ('centre longitude')
      COMMENT = 'Care centre longitude. Map-ready: use with center_lat as a latlon layer.'
    , participants.participant_id AS PARTICIPANT_ID
      WITH SYNONYMS ('person', 'evacuee', 'resident')
      COMMENT = 'Participant identifier'
    , participants.participant_region AS REGION COMMENT = 'Region'
    , participants.participant_city AS CITY COMMENT = 'Participant city'
    , participants.participant_postal_code AS POSTAL_CODE COMMENT = 'Participant postal code'
    , participants.nearest_center_id AS NEAREST_CENTER_ID
      WITH SYNONYMS ('nearest centre', 'closest shelter')
      COMMENT = 'Care centre nearest to this participant. A PROXIMITY label only - it is not a dispatch assignment and no plan produced it.'
    , participants.participant_lat AS LAT
      WITH SYNONYMS ('participant latitude')
      COMMENT = 'Participant latitude. Map-ready: use with participant_lon as a latlon layer.'
    , participants.participant_lon AS LON
      WITH SYNONYMS ('participant longitude')
      COMMENT = 'Participant longitude. Map-ready: use with participant_lat as a latlon layer.'
  )

  METRICS (
    hazard_zones.zone_count AS COUNT(*)
      WITH SYNONYMS ('number of hazard zones', 'zone count', 'cells')
      COMMENT = 'Count of hazard cells'
    , hazard_zones.avg_composite_score AS AVG(composite_score)
      WITH SYNONYMS ('average risk', 'mean hazard score')
      COMMENT = 'Average blended hazard score'
    , hazard_zones.max_composite_score AS MAX(composite_score)
      WITH SYNONYMS ('worst risk')
      COMMENT = 'Worst blended hazard score'
    , hazard_zones.avg_wildfire_level AS AVG(wildfire_level)
      COMMENT = 'Average wildfire hazard level'
    , hazard_zones.avg_flood_level AS AVG(flood_level)
      COMMENT = 'Average flood hazard level'
    , care_centers.center_count AS COUNT(DISTINCT CENTER_ID)
      WITH SYNONYMS ('number of centres', 'number of shelters')
      COMMENT = 'Distinct care centres'
    , participants.participant_count AS COUNT(DISTINCT PARTICIPANT_ID)
      WITH SYNONYMS ('number of participants', 'people to evacuate', 'evacuees')
      COMMENT = 'Distinct participants to evacuate'
  )

  COMMENT = 'Emergency response evacuation inputs and exposure: procedural hazard cells with map-ready GeoJSON boundaries and wildfire / flood / composite bands, care centres, and the participant population with a nearest-centre proximity label. The solved evacuation plan is computed live in the app and is NOT modeled here.'

  AI_SQL_GENERATION 'Emergency-response semantic view: evacuation INPUTS and hazard EXPOSURE.

Entities (three independent facts - never mix them in one grouping, there are no relationships):
- hazard_zones (VW_HAZARD_ZONES): one row per procedural hazard cell. composite_rating is the band (Very High / Relatively High / Relatively Moderate / Relatively Low), composite_score the numeric blend, with separate wildfire and flood levels and labels. hazard_geojson is a ready-to-map GeoJSON Polygon string.
- care_centers (VW_CARE_CENTERS): one row per care centre / evacuation anchor, with coordinates and category.
- participants (VW_PARTICIPANTS): one row per person to evacuate, with coordinates and a nearest-centre label.

Conventions:
- "how risky is X" -> avg_composite_score or zone_count grouped by composite_rating. Prefer the BAND for narrative answers and the score for ranking.
- "how many people" -> participant_count; "how many shelters" -> center_count.
- nearest_center_id is PROXIMITY ONLY. Never describe a participant as assigned, dispatched, or scheduled to a centre on the strength of it, and never sum participants per centre and call it a plan.
- MAPPING: for a hazard choropleth select hazard_geojson and use a geojson layer, coloring by composite_score (sequential) or composite_rating (categorical). For participants or centres select the lat/lon pair and use a latlon layer, coloring participants by their nearest centre. Hazard cells number in the low thousands, so filter by composite_rating or region before mapping - an oversized payload renders as a blank map rather than an error.

IMPORTANT scope limit: the evacuation PLAN - which vehicle collects whom, in what order, over how many trips - is solved live by the Emergency Response wizard through the routing engine and is never persisted. This view cannot answer it. Answer exposure and population questions here and direct plan questions to that page or to the evacuation tools.'
;
