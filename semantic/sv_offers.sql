-- SV_OFFERS - vehicle-agnostic offers marketplace semantic view
-- Source: FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED (offers, denormalized)
--         FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_HISTORY      (partner-lane reliability)
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- Two independent facts (offers + lane_history); GEOGRAPHY cols (PICKUP_GEOM/DROPOFF_GEOM) excluded.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_OFFERS

  TABLES (
    offers AS FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED
      PRIMARY KEY (OFFER_ID)
    , lane_history AS FLEET_INTELLIGENCE.MARKETPLACE.VW_LANE_HISTORY
      PRIMARY KEY (PARTNER_ID, ORIGIN_COUNTRY, DEST_COUNTRY, VEHICLE_EQUIPMENT)
  )

  FACTS (
    offers.weight_kg AS WEIGHT_KG COMMENT = 'Delivery weight in kg'
    , offers.price_usd AS PRICE_USD COMMENT = 'Delivery price in USD'
    , offers.distance_km AS DISTANCE_KM COMMENT = 'Straight-line distance in km'
    , offers.road_km AS ROAD_KM COMMENT = 'ORS-routed road distance in km'
    , offers.road_min AS ROAD_MIN COMMENT = 'ORS-routed road duration in minutes'
    , offers.price_per_km_usd AS PRICE_PER_KM_USD COMMENT = 'Price per straight-line km'
    , offers.price_per_road_km_usd AS PRICE_PER_ROAD_KM_USD COMMENT = 'Price per routed road km'
    , offers.price_delta_pct AS PRICE_DELTA_PCT COMMENT = 'Percent deviation from market median rate'
    , offers.posted_age_min AS POSTED_AGE_MIN COMMENT = 'Minutes since the delivery was posted'
    , offers.partner_credit_score AS PARTNER_CREDIT_SCORE COMMENT = 'Partner credit score 0-100'
    , lane_history.shipments AS SHIPMENTS COMMENT = 'Historical deliveries on this lane'
    , lane_history.on_time AS ON_TIME COMMENT = 'On-time delivery count'
    , lane_history.late_cnt AS LATE_CNT COMMENT = 'Late delivery count'
    , lane_history.damaged_cnt AS DAMAGED_CNT COMMENT = 'Damaged delivery count'
    , lane_history.avg_cost_per_km AS AVG_COST_PER_KM COMMENT = 'Average cost per km on this lane'
  )

  DIMENSIONS (
    offers.source AS SOURCE WITH SYNONYMS ('marketplace', 'platform') COMMENT = 'Delivery marketplace source'
    , offers.pickup_city AS PICKUP_CITY WITH SYNONYMS ('origin city', 'pickup') COMMENT = 'Pickup city'
    , offers.dropoff_city AS DROPOFF_CITY WITH SYNONYMS ('destination city', 'dropoff') COMMENT = 'Dropoff city'
    , offers.vehicle_equipment AS VEHICLE_EQUIPMENT WITH SYNONYMS ('equipment', 'carrier type') COMMENT = 'Vehicle equipment / carrier (scales to the fleet, e.g. INSULATED_BAG, CARGO_VAN, TAUTLINER)'
    , offers.product AS PRODUCT COMMENT = 'Product / commodity'
    , offers.status AS STATUS WITH SYNONYMS ('status') COMMENT = 'Delivery status (OPEN, TAKEN, EXPIRED)'
    , offers.hazmat AS HAZMAT COMMENT = 'Dangerous goods flag'
    , offers.partner_name AS PARTNER_NAME WITH SYNONYMS ('carrier', 'partner') COMMENT = 'Carrier partner name'
    , offers.partner_country AS PARTNER_COUNTRY COMMENT = 'Partner country'
    , offers.partner_kyc AS PARTNER_KYC COMMENT = 'Partner KYC status'
    , offers.trust_badge AS TRUST_BADGE WITH SYNONYMS ('partner trust') COMMENT = 'Partner trust badge (GREEN/YELLOW/RED)'
    , offers.market_badge AS MARKET_BADGE WITH SYNONYMS ('market position') COMMENT = 'Price vs market (AT_MARKET/BELOW_MARKET/ABOVE_MARKET)'
    , offers.route_detour_badge AS ROUTE_DETOUR_BADGE COMMENT = 'Route detour severity'
    , offers.route_profile AS ROUTE_PROFILE COMMENT = 'ORS routing profile used'
    , offers.posted_at AS POSTED_AT WITH SYNONYMS ('posting time') COMMENT = 'When the delivery was posted'
    , lane_history.partner_id AS PARTNER_ID COMMENT = 'Partner id (lane history)'
    , lane_history.origin_country AS ORIGIN_COUNTRY COMMENT = 'Lane origin country'
    , lane_history.dest_country AS DEST_COUNTRY COMMENT = 'Lane destination country'
    , lane_history.vehicle_equipment AS LANE_VEHICLE_EQUIPMENT COMMENT = 'Lane vehicle equipment'
  )

  METRICS (
    offers.total_deliveries AS COUNT(DISTINCT OFFER_ID) WITH SYNONYMS ('number of deliveries', 'delivery count') COMMENT = 'Distinct delivery count'
    , offers.total_price_usd AS SUM(price_usd) COMMENT = 'Total delivery price (USD)'
    , offers.avg_price_usd AS AVG(price_usd) WITH SYNONYMS ('average price') COMMENT = 'Average delivery price (USD)'
    , offers.avg_price_per_km AS AVG(price_per_km_usd) COMMENT = 'Average price per km (USD)'
    , offers.avg_weight_kg AS AVG(weight_kg) COMMENT = 'Average delivery weight (kg)'
    , offers.total_weight_kg AS SUM(weight_kg) COMMENT = 'Total delivery weight (kg)'
    , offers.avg_distance_km AS AVG(distance_km) COMMENT = 'Average straight-line distance (km)'
    , offers.avg_road_km AS AVG(road_km) COMMENT = 'Average routed road distance (km)'
    , offers.avg_price_delta_pct AS AVG(price_delta_pct) WITH SYNONYMS ('average market delta') COMMENT = 'Average percent deviation from market median'
    , offers.below_market_deliveries AS COUNT_IF(MARKET_BADGE = 'BELOW_MARKET') COMMENT = 'Deliveries priced below market'
    , offers.above_market_deliveries AS COUNT_IF(MARKET_BADGE = 'ABOVE_MARKET') COMMENT = 'Deliveries priced above market'
    , offers.green_trust_deliveries AS COUNT_IF(TRUST_BADGE = 'GREEN') COMMENT = 'Deliveries from green-trust partners'
    , offers.avg_partner_credit_score AS AVG(partner_credit_score) COMMENT = 'Average partner credit score'
    , lane_history.total_shipments AS SUM(shipments) WITH SYNONYMS ('shipments') COMMENT = 'Total historical deliveries'
    , lane_history.total_on_time AS SUM(on_time) COMMENT = 'Total on-time deliveries'
    , lane_history.total_late AS SUM(late_cnt) COMMENT = 'Total late deliveries'
    , lane_history.total_damaged AS SUM(damaged_cnt) COMMENT = 'Total damaged deliveries'
    , lane_history.on_time_rate_pct AS DIV0(SUM(on_time), SUM(shipments)) * 100 WITH SYNONYMS ('on time rate', 'reliability') COMMENT = 'Percent of deliveries completed on time'
    , lane_history.avg_lane_cost_per_km AS AVG(avg_cost_per_km) COMMENT = 'Average cost per km across lanes'
  )

  COMMENT = 'Deliveries marketplace analytics: vehicle-agnostic delivery offers with market-rate benchmarking, partner trust, and routed distances; plus historical partner-lane reliability.'

  AI_SQL_GENERATION 'Vehicle-agnostic deliveries marketplace semantic view for the Route Optimisation & Fleet Intelligence solution.

Entities (two independent facts, do NOT mix in one grouping):
- offers (VW_OFFER_ENRICHED): one row per offer, fully denormalized with partner trust, market-rate benchmark, and ORS routed distance. Use for current offers, pricing, market position, partner trust.
- lane_history (VW_LANE_HISTORY): aggregated partner reliability per (partner, origin_country, dest_country, vehicle_equipment). Use for on-time / reliability questions.

Conventions:
- "below/above market" -> offers.below_market_deliveries / above_market_deliveries, or filter market_badge.
- "trustworthy partners" -> trust_badge = GREEN.
- "reliability" / "on time" -> lane_history.on_time_rate_pct.
- vehicle_equipment scales to the fleet (e.g. INSULATED_BAG for e-bike, CARGO_VAN for car/van, TAUTLINER for HGV).'
;
