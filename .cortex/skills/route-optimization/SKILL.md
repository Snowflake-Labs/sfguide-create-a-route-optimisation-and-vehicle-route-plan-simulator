---
name: route-optimization
description: "Deploy the Route Optimization demo (VRP simulator with industries: healthcare, food, cosmetics, beverages, SEN Transport). Uses Overture Maps Places + Addresses. Use when: setting up route optimization, VRP demo, industry delivery simulation. Do NOT use for: fleet telemetry (fleet-intelligence-taxis), route deviation, retail catchment. Triggers: deploy route optimization, setup VRP demo, SEN transport demo."
depends_on:
  - build-routing-solution
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: route-optimization
---

# Deploy Route Optimization Demo

Interactive VRP simulator with 5 industries, time-windowed deliveries, and multi-vehicle skills-based routing. SEN Transport uses schools as origins and real residential addresses as student pickups.

## Prerequisites

- `build-routing-solution` deployed (ORS services running)
- IMPORT SHARE privilege (for Overture Maps Marketplace listings)

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `REGION_GEOHASH` | `9q` | Geohash prefix for Overture Maps filter |
| `REGION_NAME` | `SanFrancisco` | Region identifier |

## Workflow

### Step 1: Acquire Marketplace Data

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING 'GZT0Z4CM1E9KR';

CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING 'GZT0Z4CM1E9NQ';
```

### Step 2: Run Seed Data

Execute `references/seed-data.sql` (via `snow sql -f` or statement-by-statement in workspace).

> **Workspace:** Replace `$REGION_GEOHASH` → `'9q'` and `$REGION_NAME` → `'SanFrancisco'` in every statement. One statement per `snowflake_sql_execute` call.

This creates: CONFIG, PLACES, JOB_TEMPLATE, LOOKUP, SEN_STUDENTS tables.

**Key tables:**

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `PLACES` | POIs from Overture (includes schools for SEN) | REGION, NAME, CATEGORY, GEOMETRY |
| `LOOKUP` | Industry config (5 industries) | INDUSTRY, CTYPE, STYPE, SOURCE_TABLE, DEPOT_CTYPE |
| `JOB_TEMPLATE` | Time-windowed delivery jobs | SLOT_START, SLOT_END, SKILLS, INDUSTRY |
| `SEN_STUDENTS` | Real residential addresses near schools | NAME, LNG, LAT, DISPLAY_ADDRESS |

### Step 3: Verify

```sql
SELECT 'PLACES' AS TBL, COUNT(*) AS CNT FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES
UNION ALL SELECT 'LOOKUP', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP
UNION ALL SELECT 'JOB_TEMPLATE', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE
UNION ALL SELECT 'SEN_STUDENTS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEN_STUDENTS;
```

Expected: PLACES 50K+, LOOKUP 5, JOB_TEMPLATE 50+, SEN_STUDENTS 60.

## SEN Transport Architecture

```
Schools (from PLACES where CATEGORY IN DEPOT_CTYPE) → ORIGINS/DEPOTS
Student Addresses (from SEN_STUDENTS via SOURCE_TABLE) → DELIVERY POINTS
Vehicle Types: Solo Taxi + Chaperone, Shared Taxi, Accessible Minibus
Time Windows: Morning 07:00-08:30, Afternoon 15:00-17:00
```

The React app:
1. Queries `LOOKUP` for `DEPOT_CTYPE` (school categories)
2. Queries `PLACES` for schools matching those categories near the search center
3. Shows schools in the "Origins" dropdown
4. Queries `SOURCE_TABLE` (SEN_STUDENTS) for delivery locations

## Required Privileges

| Privilege | Scope | Reason |
|-----------|-------|--------|
| CREATE DATABASE | Account | FLEET_INTELLIGENCE |
| IMPORT SHARE | Account | Overture Maps listings |
| USAGE ON DATABASE OVERTURE_MAPS__PLACES | Database | POI data (schools, hospitals, etc.) |
| USAGE ON DATABASE OVERTURE_MAPS__ADDRESSES | Database | Residential addresses for SEN |

## Cleanup

```sql
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SEN_STUDENTS;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.PLACES;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.JOB_TEMPLATE;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.LOOKUP;
DROP TABLE IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG;
DROP SCHEMA IF EXISTS FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION;
```
