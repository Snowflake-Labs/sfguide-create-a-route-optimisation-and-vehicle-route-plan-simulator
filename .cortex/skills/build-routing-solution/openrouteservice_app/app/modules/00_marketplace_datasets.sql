-- =============================================================================
-- 00_marketplace_datasets.sql
-- Installs required Overture Maps Marketplace datasets.
-- Must run BEFORE any demo skill that queries POI/address/building data.
-- Idempotent: safe to re-run.
--
-- Datasets installed:
--   OVERTURE_MAPS__PLACES    — POI data (route-optimization, retail-catchment, fleet-intelligence)
--   OVERTURE_MAPS__ADDRESSES — Address geocoding (route-optimization SEN students)
--   OVERTURE_MAPS__BUILDINGS — Building footprints (add-plant-map campus views)
--
-- Listing IDs (CARTO / Overture Maps Foundation):
--   Places:    GZT0Z4CM1E9KR
--   Addresses: GZT0Z4CM1E9NQ
--   Buildings: GZT0Z4CM1E9KN
-- =============================================================================

-- Accept legal terms for all three listings (idempotent — no-op if already accepted)
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KN');

-- Install databases from listings (idempotent — skips if already exists)
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING 'GZT0Z4CM1E9KR';
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING 'GZT0Z4CM1E9NQ';
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__BUILDINGS FROM LISTING 'GZT0Z4CM1E9KN';

-- Verify installation
SELECT 'OVERTURE_MAPS__PLACES' AS DATASET, COUNT(*) AS ACCESSIBLE FROM OVERTURE_MAPS__PLACES.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'CARTO'
UNION ALL
SELECT 'OVERTURE_MAPS__ADDRESSES', COUNT(*) FROM OVERTURE_MAPS__ADDRESSES.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'CARTO'
UNION ALL
SELECT 'OVERTURE_MAPS__BUILDINGS', COUNT(*) FROM OVERTURE_MAPS__BUILDINGS.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'CARTO';
