---
name: retail-catchment
description: "Deploy Retail Catchment Analysis: isochrone trade areas, competitor mapping, address density from Overture Maps. Use when: retail catchment demo, trade area analysis, competitor mapping. Do NOT use for: fleet demos, route optimization, dwell analysis. Triggers: retail catchment, trade area, competitor mapping, isochrone retail."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: retail-analytics
---

# Deploy Retail Catchment Demo

Trade area analysis using ORS isochrones + Overture Maps POIs and addresses. Dashboard served via the ORS Control App React UI.

## Prerequisites

- `build-routing-solution` deployed (ORS services running)
- IMPORT SHARE privilege (Overture Maps Marketplace)

## Workflow

### Step 1: Acquire Marketplace Data

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING 'GZT0Z4CM1E9KR';

CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING 'GZT0Z4CM1E9NQ';
```

### Step 2: Run Seed Data

Execute `references/seed-data.sql` statement-by-statement. Creates:

| Table | Purpose |
|-------|---------|
| `CONFIG` | Region filter (single row) |
| `RETAIL_POIS` | POIs from Overture for the region |
| `CITIES_BY_STATE` | State/city POI counts |
| `REGION_CONFIG` | Bounding box for region |
| `REGIONAL_ADDRESSES` | Residential addresses for density analysis |

### Step 3: Verify

```sql
SELECT 'RETAIL_POIS' AS TBL, COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS
UNION ALL SELECT 'REGIONAL_ADDRESSES', COUNT(*) FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES;
```

Expected: RETAIL_POIS 50K+, REGIONAL_ADDRESSES 100K+.

## React Component → SQL Mapping

The RetailCatchment.tsx component queries:

| Query | Table | Key Columns |
|-------|-------|-------------|
| POI search | `RETAIL_POIS` | POI_NAME, BASIC_CATEGORY, LONGITUDE, LATITUDE, GEOMETRY |
| Address density | `REGIONAL_ADDRESSES` | LNG, LAT |
| Region list | `REGION_CONFIG` | REGION, BBOX_MIN_LON, BBOX_MAX_LON |
| City filter | `CITIES_BY_STATE` | STATE, CITY, POI_COUNT |

## Cleanup

```sql
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CITIES_BY_STATE;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGION_CONFIG;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT.CONFIG;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.RETAIL_CATCHMENT;
```
