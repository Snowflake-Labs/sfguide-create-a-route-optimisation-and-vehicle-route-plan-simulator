# Freight Exchange - Schema Contract

The Freight Exchange page reads exclusively from `FLEET_INTELLIGENCE.MARKETPLACE.VW_OFFER_ENRICHED`. All other objects in this skill exist to feed that view. The contract is deliberately stable so phase C/D additions (chat, bids, posting, alerts) can extend the view without breaking the page.

## Source of truth

Two parallel definitions exist for the MARKETPLACE objects:

- [.cortex/skills/freight-exchange/references/bootstrap.sql](bootstrap.sql) - for greenfield install / audit reruns.
- `services/ors_control_app/server/lib/init.ts` - runs on every container boot.

When you change a column list, change BOTH. The init.ts copy is the authoritative one - if the two diverge, init.ts wins on the next service restart.

## VW_OFFER_ENRICHED columns

| Column | Type | Source | Notes |
|---|---|---|---|
| OFFER_ID | VARCHAR | FACT_FREIGHT_OFFERS | Stable per offer |
| SOURCE | VARCHAR(30) | FACT_FREIGHT_OFFERS | TIMOCOM / WTRANSNET / TELEROUTE / B2P / DAT / TRUCKSTOP / CONVOY / UBER_FREIGHT |
| PARTNER_ID | VARCHAR | FACT_FREIGHT_OFFERS | Joins to DIM_PARTNERS |
| PICKUP_CITY / DROPOFF_CITY | VARCHAR | DIM_POIS | Looked up from PICKUP_POI_ID / DROPOFF_POI_ID |
| PICKUP_LON / PICKUP_LAT / PICKUP_GEOM | FLOAT / FLOAT / GEOGRAPHY | FACT_FREIGHT_OFFERS | |
| DROPOFF_LON / DROPOFF_LAT / DROPOFF_GEOM | FLOAT / FLOAT / GEOGRAPHY | FACT_FREIGHT_OFFERS | |
| PICKUP_FROM_TS / PICKUP_TO_TS | TIMESTAMP_NTZ | FACT_FREIGHT_OFFERS | Pickup window |
| WEIGHT_KG | NUMBER | FACT_FREIGHT_OFFERS | |
| PRODUCT | VARCHAR | FACT_FREIGHT_OFFERS | Free-text |
| PRICE_USD | NUMBER | FACT_FREIGHT_OFFERS | Total offer price |
| HAZMAT | BOOLEAN | FACT_FREIGHT_OFFERS | True if ADR_CLASS is set |
| LISTING_TEXT | VARCHAR | FACT_FREIGHT_OFFERS | Synthetic broker copy for AI_FILTER demos |
| POSTED_AT | TIMESTAMP_NTZ | FACT_FREIGHT_OFFERS | Jittered last 24h |
| **EQUIPMENT** | VARCHAR(20) | FACT_FREIGHT_OFFERS | TAUTLINER / MEGA / REEFER / BOX / FLATBED |
| **ADR_CLASS** | VARCHAR(8) | FACT_FREIGHT_OFFERS | NULL or '1' .. '9' |
| **LDM** | FLOAT | FACT_FREIGHT_OFFERS | Loading-meter (1-13.6) |
| **DISTANCE_KM** | FLOAT | FACT_FREIGHT_OFFERS | Haversine pickup -> dropoff |
| **PRICE_PER_KM_USD** | FLOAT | FACT_FREIGHT_OFFERS | Used by RATE_INDEX |
| **STATUS** | VARCHAR(20) | FACT_FREIGHT_OFFERS | OPEN / TAKEN / EXPIRED |
| POSTED_AGE_MIN | NUMBER | derived | `DATEDIFF('minute', POSTED_AT, CURRENT_TIMESTAMP())` |
| PARTNER_NAME | VARCHAR | DIM_PARTNERS | |
| PARTNER_COUNTRY | VARCHAR(4) | DIM_PARTNERS | ISO-2 |
| PARTNER_CREDIT_SCORE | NUMBER | DIM_PARTNERS | 0-100 |
| PARTNER_PAYMENT_DAYS | NUMBER | DIM_PARTNERS | Avg payment days |
| PARTNER_KYC | VARCHAR(20) | DIM_PARTNERS | VERIFIED / PENDING / REJECTED |
| PARTNER_BLACKLIST | BOOLEAN | DIM_PARTNERS | |
| **TRUST_BADGE** | VARCHAR | derived | GREEN / YELLOW / RED |
| MARKET_P25 / MARKET_P50 / MARKET_P75 | FLOAT | RATE_INDEX | USD/km percentiles by EQUIPMENT + WEEK |
| PRICE_DELTA_PCT | FLOAT | derived | `(PRICE_PER_KM_USD - MARKET_P50) / MARKET_P50 * 100` |
| **MARKET_BADGE** | VARCHAR | derived | UNKNOWN / AT_MARKET / BELOW_MARKET / ABOVE_MARKET (within +/-5% = AT_MARKET) |

## Routed columns (populated by `POST /api/fx/refresh-routes`)

These columns come from `LEFT JOIN FACT_OFFER_ROUTES` on `OFFER_ID`. They are null until the batch refresh endpoint has cached an ORS DIRECTIONS result for the offer.

| Column | Type | Source | Notes |
|---|---|---|---|
| ROAD_KM | FLOAT | FACT_OFFER_ROUTES | ORS road distance (km) |
| ROAD_MIN | FLOAT | FACT_OFFER_ROUTES | ORS drive time (minutes) |
| ROUTE_GEOMETRY | VARCHAR | FACT_OFFER_ROUTES.GEOMETRY | GeoJSON LineString |
| ROUTE_PROFILE | VARCHAR(20) | FACT_OFFER_ROUTES | driving-hgv / driving-car |
| ROUTE_COMPUTED_AT | TIMESTAMP_NTZ | FACT_OFFER_ROUTES | Last DIRECTIONS cache time |
| PRICE_PER_ROAD_KM_USD | FLOAT | derived | `PRICE_USD / ROAD_KM` when routed, else `PRICE_PER_KM_USD` |
| ROUTE_DETOUR_BADGE | VARCHAR | derived | PENDING_ROUTE / DIRECT / DETOUR_MODERATE / DETOUR_HEAVY |

## Trust badge tier rules

| Badge | Condition |
|-------|-----------|
| RED   | `BLACKLIST_FLAG = TRUE` OR `CREDIT_SCORE < 40` OR `KYC_STATUS = 'REJECTED'` |
| YELLOW | `CREDIT_SCORE BETWEEN 40 AND 69` OR `KYC_STATUS = 'PENDING'` |
| GREEN | otherwise (`CREDIT_SCORE >= 70` AND `KYC_STATUS = 'VERIFIED'`) |

## Market badge tier rules

| Badge | Condition |
|-------|-----------|
| UNKNOWN | `RATE_INDEX` has no row for the offer's `(EQUIPMENT, WEEK)` |
| AT_MARKET | `ABS(price_per_km - p50) / p50 <= 0.05` |
| BELOW_MARKET | `price_per_km < p50` (more than 5% below) |
| ABOVE_MARKET | `price_per_km > p50` (more than 5% above) |
