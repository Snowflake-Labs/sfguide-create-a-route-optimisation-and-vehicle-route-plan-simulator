-- SV_BACKLOAD_MATCHING — Backload matching demo semantic view
-- Source: FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS + VW_TRAILERS
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- NOTE: offers/trailers views may be empty until the backload-matching demo generates data;
-- PROPOSAL_DECISIONS is written by the Backload Matching / Freight Exchange pages.
-- Three independent facts; all coordinates exposed as LON/LAT floats (no GEOGRAPHY).

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_BACKLOAD_MATCHING

  TABLES (
    offers AS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_EXTERNAL_OFFERS
      PRIMARY KEY (OFFER_ID)
    , trailers AS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.VW_TRAILERS
      PRIMARY KEY (TRAILER_ID)
    , decisions AS FLEET_INTELLIGENCE.BACKLOAD_MATCHING.PROPOSAL_DECISIONS
      PRIMARY KEY (DECISION_ID)
  )

  FACTS (
    offers.weight_kg AS WEIGHT_KG COMMENT = 'Offer load weight kg'
    , offers.price_eur AS PRICE_EUR COMMENT = 'Offer price EUR'
    , trailers.eta_min AS ETA_MIN COMMENT = 'Minutes to trailer ETA'
    , trailers.max_payload_kg AS MAX_PAYLOAD_KG COMMENT = 'Trailer max payload kg'
    , trailers.ev_range_km AS EV_RANGE_KM COMMENT = 'Electric range km'
    , decisions.score AS SCORE COMMENT = 'Match score'
    , decisions.empty_km AS EMPTY_KM COMMENT = 'Deadhead/empty km for the match'
    , decisions.net_benefit_eur AS NET_BENEFIT_EUR COMMENT = 'Net benefit of the decision EUR'
  )

  DIMENSIONS (
    offers.source AS SOURCE WITH SYNONYMS ('exchange') COMMENT = 'External exchange source'
    , offers.pickup_country AS PICKUP_COUNTRY COMMENT = 'Pickup country'
    , offers.dropoff_country AS DROPOFF_COUNTRY COMMENT = 'Dropoff country'
    , offers.pickup_city AS PICKUP_CITY WITH SYNONYMS ('origin city') COMMENT = 'Pickup city'
    , offers.dropoff_city AS DROPOFF_CITY WITH SYNONYMS ('destination city') COMMENT = 'Dropoff city'
    , offers.product AS PRODUCT COMMENT = 'Product / commodity'
    , offers.hazmat AS HAZMAT COMMENT = 'Hazmat flag'
    , trailers.operating_country AS OPERATING_COUNTRY COMMENT = 'Trailer operating country'
    , trailers.home_depot AS HOME_DEPOT WITH SYNONYMS ('depot') COMMENT = 'Trailer home depot'
    , trailers.current_load AS CURRENT_LOAD COMMENT = 'Current load / vehicle type'
    , trailers.trailer_status AS STATUS COMMENT = 'Trailer status'
    , trailers.hazmat_cert AS HAZMAT_CERT COMMENT = 'Hazmat certified'
    , decisions.decision_source AS SOURCE WITH SYNONYMS ('decision exchange') COMMENT = 'Source of the matched offer (INTERNAL/EXTERNAL exchange)'
    , decisions.decided_by AS DECIDED_BY WITH SYNONYMS ('dispatcher', 'decided by') COMMENT = 'User/dispatcher who decided'
    , decisions.source_page AS SOURCE_PAGE COMMENT = 'Origin page (BACKLOAD_MATCHING / FREIGHT_EXCHANGE)'
    , decisions.decision_type AS DECISION_TYPE WITH SYNONYMS ('type') COMMENT = 'Decision type (SINGLE / ROUND_TRIP / BUNDLE)'
    , decisions.decided_at AS DECIDED_AT WITH SYNONYMS ('decision time') COMMENT = 'When the decision was made'
  )

  METRICS (
    offers.total_offers AS COUNT(DISTINCT OFFER_ID) WITH SYNONYMS ('number of offers') COMMENT = 'Distinct external offers'
    , offers.avg_price_eur AS AVG(price_eur) WITH SYNONYMS ('average price') COMMENT = 'Average offer price (EUR)'
    , offers.total_price_eur AS SUM(price_eur) COMMENT = 'Total offer price (EUR)'
    , offers.avg_weight_kg AS AVG(weight_kg) COMMENT = 'Average offer weight (kg)'
    , trailers.total_trailers AS COUNT(DISTINCT TRAILER_ID) WITH SYNONYMS ('number of trailers') COMMENT = 'Distinct trailers'
    , trailers.avg_eta_min AS AVG(eta_min) COMMENT = 'Average minutes to ETA'
    , trailers.avg_max_payload_kg AS AVG(max_payload_kg) COMMENT = 'Average max payload (kg)'
    , decisions.total_decisions AS COUNT(DISTINCT DECISION_ID) WITH SYNONYMS ('number of decisions', 'matches') COMMENT = 'Distinct backload decisions'
    , decisions.avg_score AS AVG(score) WITH SYNONYMS ('average match score') COMMENT = 'Average match score'
    , decisions.avg_empty_km AS AVG(empty_km) WITH SYNONYMS ('average deadhead') COMMENT = 'Average empty/deadhead km'
    , decisions.total_empty_km AS SUM(empty_km) COMMENT = 'Total empty/deadhead km'
    , decisions.total_net_benefit_eur AS SUM(net_benefit_eur) WITH SYNONYMS ('total net benefit') COMMENT = 'Total net benefit EUR'
    , decisions.avg_net_benefit_eur AS AVG(net_benefit_eur) COMMENT = 'Average net benefit EUR'
  )

  COMMENT = 'Backload matching demo: external freight offers, available trailers, and recorded matching decisions (score, empty km, net benefit). Offers/trailers views may be empty until the demo generates data; decisions are written by the Backload Matching / Freight Exchange pages.'

  AI_SQL_GENERATION 'Backload matching semantic view.
Entities (three independent facts):
- offers (VW_EXTERNAL_OFFERS): external freight offers available to fill a backload.
- trailers (VW_TRAILERS): trailers in transit / available, with ETA and capacity.
- decisions (PROPOSAL_DECISIONS): recorded accept decisions with match score, empty (deadhead) km, and net benefit. Use for "matches", "deadhead/empty km", "net benefit", and breakdowns by decision_source, decision_type, or decided_by.
Conventions:
- "matches" / "decisions" -> decisions.total_decisions.
- "empty km" / "deadhead" -> decisions.avg_empty_km or total_empty_km.
- "net benefit" / "savings from matching" -> decisions.total_net_benefit_eur.
- internal vs external -> decisions.decision_source.'
;
