---
name: add-plant-map
description: "Add Plant Intelligence module to the ors_control_app React app: Overture Maps building footprints for 6 pharma manufacturing plants, 4-level drill-down (world → campus multi-building → floor plan → room contents), GMP sensors, 24-hour timeline, agent click integration. Image v1.0.211 already deployed. Triggers: plant map, plant intelligence, building footprints, manufacturing map, Overture buildings, warehouse floor plan, campus map, room contents, GMP sensors, pharma campus."
depends_on:
  - add-pharma-supply-chain
metadata:
  author: Snowflake SIT-IS
  version: 2.0.0
  category: visualization
---

# Plant Intelligence Map

Adds a **Plant Intelligence** page to the ORS Control App showing real Overture Maps building footprints for each pharma manufacturing plant with a 4-level interactive drill-down into campus buildings, floor plans, and room-level contents.

**Image v1.0.211 is already deployed** to the publisher registry. All React components, API routes, and nav entries are already in the image. This skill only needs to run the Snowflake SQL to create views and grant access to the Overture Maps listing.

---

## What's in the Image (v1.0.211)

### React Components

- **`PlantIntelligence.tsx`** — Full Plant Intelligence page with sidebar:
  - **Level 1 — World view**: severity-colored plant markers (zoom 1.4)
  - **Level 2 — Campus view**: 5–6 real Overture buildings per plant, each assigned a pharma role and color (zoom 15, pitch 45)
  - **Level 3 — Floor plan**: extruded 3D zones for the selected building + floor, with GMP sensors and 24-hour timeline chart in sidebar (zoom 18.5, pitch 55)
  - **Level 4 — Room contents**: racks/pallets, equipment footprints, or lab benches depending on zone type (zoom 20, pitch 45)

- **`PlantIntelMap.tsx`** — Map-only version embedded in Agent Playground (no sidebar). Supports the same 4-level navigation with `onBuildingSelect` / `onRoomSelect` callback props for agent integration.

### API Endpoints (`server/plant-intel/routes.ts`)

| Endpoint | Description |
|----------|-------------|
| `GET /api/plant-intel/plants` | All plants with alert severity from `PLANT_ALERT_STATUS` view |
| `GET /api/plant-intel/campus?plant_id=N` | 5–6 campus buildings with pharma roles, floors, zones, sensors, contents, timeline |
| `GET /api/plant-intel/batches?plant_id=N` | Production batch data |
| `GET /api/plant-intel/inventory?plant_id=N` | Material inventory |
| `GET /api/plant-intel/warehouse?plant_id=N` | Legacy single-building data (still used for sidebar details) |

### Campus Building Roles (server-assigned per plant)

| Role ID | Name | Floors | Colour |
|---------|------|--------|--------|
| `api` | API Manufacturing | 3 | Purple |
| `form` | Formulation & Filling | 2 | Blue |
| `cold` | Cold Chain Warehouse | 1 | Cyan |
| `qc` | QC Laboratory | 2 | Yellow |
| `util` | Central Utilities | 2 | Grey |
| `dist` | Distribution & Dispatch | 1 | Amber |

### Zone Types + Room Contents

Room contents are generated server-side per zone type. All types now produce visual 3D content:

| Zone Type | Visual Style | Contents |
|-----------|-------------|----------|
| `warehouse`, `chill`, `deep_freeze`, `freezer`, `storage`, `dispensary` | Rack rows + aisle strips + pallet slots | Products with expiry dates, batch numbers |
| `hazardous` | Rack rows | Solvent drums with expiry |
| `quarantine` | Rack rows | Held items with days-in-hold |
| `reactor`, `process`, `aseptic`, `packaging`, `dock` | Equipment footprints + central walkway | Reactors, pumps, filling lines, bays |
| `lab`, `analytical`, `precision` | Perimeter benches + central island | HPLC, dissolution, FTIR, balances |
| `utility`, `hvac`, `electrical`, `control`, `cleanroom` | Lab bench layout | AHUs, UPS, SCADA workstations, PW systems |

### GMP Sensors (per zone type)

Zones have 3–5 sensors each, type-appropriate for GMP pharma:
- **Temperature, humidity, differential pressure** (all zones)
- **Particle count, viable particles** (cleanroom, aseptic)
- **pH, dissolved O₂, RPM** (reactor)
- **TOC, conductivity, endotoxin** (utility/water systems)
- **Compression force, fill weight** (tableting/filling)

Sensor readings are seeded deterministic per `plantId` (demos always show the same data).

### Agent Click Integration

`PlantIntelMap.tsx` accepts optional callbacks:
- `onBuildingSelect(building, plant)` — triggered when user clicks a building at Level 2
- `onRoomSelect(room, building, plant)` — triggered when user clicks a room at Level 3

In Agent Playground with `plant_intel` scenario active, clicking a building or room auto-populates the chat input with a rich context message (building role, alert summary, sensor readings, contents) so the agent can analyse the facility using `pharma_supply_chain` and other tools.

---

## Prerequisites

- `$add-pharma-supply-chain` deployed (`PLANTS`, `PRODUCTION_BATCHES`, `MATERIAL_INVENTORY`, `SHIPMENTS` tables)
- `OVERTURE_MAPS__BUILDINGS` database accessible (SQL step below handles this)
- ACCOUNTADMIN role

---

## Workflow

### Step 1: Run `references/build-plant-footprints.sql`

This single SQL file does everything:

1. **Accepts Overture Maps marketplace terms** (idempotent):
   ```sql
   CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KN');
   CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__BUILDINGS FROM LISTING 'GZT0Z4CM1E9KN';
   ```

2. **Creates `PLANT_ALERT_STATUS` view** — aggregates alert severity (batch holds, temp excursions, stock levels, shipment delays) per plant for map colour-coding

3. **Creates `PLANT_BUILDING_FOOTPRINTS` table** — pre-computes Overture building polygons within 800m of each plant using BBOX pre-filter

4. **Creates `PLANT_PRIMARY_BUILDING` view** — single largest building per plant (used by legacy `/buildings` endpoint)

5. **Creates `PLANT_CAMPUS_BUILDINGS` view** — top 6 buildings ≥500 sqm per plant (used by `/campus` endpoint for multi-building campus view)

**Run it:**
```sql
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
```
Then execute the full file.

**Verify:**
```sql
-- Should show ~200-800 rows, 6 plants
SELECT COUNT(*) AS building_rows,
       COUNT(DISTINCT PLANT_ID) AS plants_covered
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS;

-- Should show 6 rows with campus buildings
SELECT PLANT_NAME, COUNT(*) AS campus_buildings
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_CAMPUS_BUILDINGS
GROUP BY PLANT_NAME;

-- Alert severity check
SELECT PLANT_NAME, MAX_SEVERITY, CRITICAL_BATCHES, TEMP_EXCURSIONS
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS
ORDER BY MAX_SEVERITY DESC;
```

Expected: Mount Vernon and Macclesfield show `MAX_SEVERITY = 4` (Critical).

If a plant has `< 6` Overture buildings ≥500 sqm nearby, the `/campus` endpoint falls back to as many buildings as available (can be 1–5). Plants still show on the world map; they just have fewer campus buildings to drill into.

### Step 2: Upgrade SPCS Service

If deploying fresh, run `$build-routing-solution` — it picks up `v1.0.211` automatically from `image-versions.env`.

If already deployed and just need to update:
```sql
ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP
  FROM SPECIFICATION_FILE = '@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/ors_control_app_service.yaml';
```

---

## Demo Flow

1. Open **Plant Intelligence** → world map shows 6 colour-coded plant dots
2. **Macclesfield (UK)** and **Mount Vernon (US)** = crimson (Critical)
3. Click a plant → zooms to campus, shows 5–6 real buildings colour-coded by pharma role
4. Click **API Manufacturing** building → floor plan appears with 3 floors
5. Switch floors using floor selector → different zone layouts per floor
6. Click **Reactor Hall** zone → zooms in, shows 3D reactor vessels + pumps + walkway
7. Hover over a reactor → tooltip shows batch, temperature, pressure, status
8. In **Agent Playground** with Plant Intel tab: click a building → chat pre-fills with context → send → agent analyses facility

---

## Alert Colour Legend

| Colour | Severity | Trigger |
|--------|----------|---------|
| Crimson | 4 — Critical | Batch ON_HOLD with critical deviation or REJECTED |
| Red | 3 — High | Temperature excursion or major batch deviation |
| Amber | 2 — Moderate | Shipment delayed >7 days or critical stock |
| Yellow | 1 — Low | Low stock or short shipment delay |
| Green | 0 — None | No active alerts |
