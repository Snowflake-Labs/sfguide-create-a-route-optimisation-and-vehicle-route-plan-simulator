-- SV_FOOD_DELIVERY — Food Delivery demo semantic view
-- Source: FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES + RESTAURANTS_ENRICHED
-- Deploy target: FLEET_INTELLIGENCE.SEMANTIC (via fleet_test_evals connection)
-- All GEOGRAPHY columns excluded. deliveries joins restaurants on RESTAURANT_ID.

CREATE OR REPLACE SEMANTIC VIEW FLEET_INTELLIGENCE.SEMANTIC.SV_FOOD_DELIVERY

  TABLES (
    deliveries AS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERIES
      PRIMARY KEY (DELIVERY_ID)
    , restaurants AS FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.RESTAURANTS_ENRICHED
      PRIMARY KEY (RESTAURANT_ID)
  )

  RELATIONSHIPS (
    deliveries_to_restaurant AS deliveries(RESTAURANT_ID) REFERENCES restaurants(RESTAURANT_ID)
  )

  FACTS (
    deliveries.delivery_time_min AS DELIVERY_TIME_MIN COMMENT = 'Delivery duration in minutes'
    , deliveries.distance_km AS DISTANCE_KM COMMENT = 'Delivery distance in km'
    , restaurants.total_orders AS TOTAL_ORDERS COMMENT = 'Total orders per restaurant (precomputed)'
    , restaurants.avg_delivery_time_min AS AVG_DELIVERY_TIME_MIN COMMENT = 'Avg delivery time per restaurant (precomputed)'
  )

  DIMENSIONS (
    deliveries.courier_id AS COURIER_ID WITH SYNONYMS ('courier', 'rider') COMMENT = 'Courier id'
    , deliveries.delivery_restaurant_name AS RESTAURANT_NAME WITH SYNONYMS ('restaurant') COMMENT = 'Restaurant name (on delivery)'
    , deliveries.order_status AS ORDER_STATUS WITH SYNONYMS ('status') COMMENT = 'Order status'
    , deliveries.order_time AS ORDER_TIME WITH SYNONYMS ('order timestamp') COMMENT = 'Order placed timestamp'
    , restaurants.restaurant_name AS RESTAURANT_NAME WITH SYNONYMS ('restaurant') COMMENT = 'Restaurant name'
    , restaurants.region AS REGION WITH SYNONYMS ('city') COMMENT = 'Region'
  )

  METRICS (
    deliveries.total_deliveries AS COUNT(DISTINCT DELIVERY_ID) WITH SYNONYMS ('number of deliveries', 'orders delivered') COMMENT = 'Distinct deliveries'
    , deliveries.active_couriers AS COUNT(DISTINCT COURIER_ID) WITH SYNONYMS ('number of couriers') COMMENT = 'Distinct active couriers'
    , deliveries.avg_delivery_time AS AVG(delivery_time_min) WITH SYNONYMS ('average delivery time') COMMENT = 'Average delivery time (minutes)'
    , deliveries.total_distance_km AS SUM(distance_km) COMMENT = 'Total delivery distance (km)'
    , deliveries.avg_distance_km AS AVG(distance_km) COMMENT = 'Average delivery distance (km)'
    , restaurants.total_restaurants AS COUNT(DISTINCT RESTAURANT_ID) WITH SYNONYMS ('number of restaurants') COMMENT = 'Distinct restaurants'
    , restaurants.restaurant_total_orders AS SUM(total_orders) WITH SYNONYMS ('total orders') COMMENT = 'Total orders across restaurants'
    , restaurants.avg_restaurant_delivery_time AS AVG(avg_delivery_time_min) COMMENT = 'Average restaurant delivery time (minutes)'
  )

  COMMENT = 'Food Delivery demo: courier deliveries (time, distance, status) joined to restaurants (order volume, avg delivery time).'

  AI_SQL_GENERATION 'Food Delivery semantic view.
Entities:
- deliveries (DELIVERIES): one row per delivery; join to restaurants on RESTAURANT_ID.
- restaurants (RESTAURANTS_ENRICHED): one row per restaurant with precomputed total_orders and avg delivery time, and region.
Conventions:
- "average delivery time" -> deliveries.avg_delivery_time (row-level) for delivery-grained questions; restaurants.avg_restaurant_delivery_time for restaurant-precomputed.
- "busiest restaurants" -> group restaurants by restaurant_name ORDER BY restaurant_total_orders.
- "deliveries per courier" -> group deliveries by courier_id.'
;
