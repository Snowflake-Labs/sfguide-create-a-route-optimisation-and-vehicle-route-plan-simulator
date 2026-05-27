---
name: add-plant-map
description: "Add Plant Intelligence module to the ors_control_app React app: Overture Maps building footprints for 6 manufacturing plants, color-coded by live supply chain alerts (batch holds, temp excursions, low stock, delayed shipments). 3-level drill-down: world → plant building → interactive 3D warehouse floor plan with zones, sensors, and 24-hour timeline. Image v1.0.203 already deployed. Triggers: plant map, building footprints, manufacturing map, plant intelligence, Overture buildings, warehouse floor plan, sensor data."
depends_on:
  - add-pharma-supply-chain
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: visualization
---

# Plant Intelligence Map

Adds a **Plant Intelligence** page to the ORS Control App showing Overture Maps building footprints for each manufacturing plant, color-coded by real-time supply chain alerts.

**Image v1.0.203 is already deployed** to the publisher registry. The React module, API routes, and nav entries are already in the image. This skill only needs to run the Snowflake SQL to create the pre-computed footprints table.

## What's in the Image (v1.0.203)

- `PlantIntelligence.tsx` — 3-level DeckGL navigation:
  1. **World view** — severity-colored plant markers
  2. **Plant view** (zoom 15) — single largest building per plant highlighted, click to enter warehouse
  3. **Warehouse view** (zoom 19, pitch 60) — synthetic 3D floor plan with 7 zones:
     Cold Storage −20°C, Cold Storage +4°C, Controlled Substances, Production Floor, QC Lab, Loading Dock, General Warehouse
- `server/plant-intel/routes.ts` — 5 API endpoints: `/plants`, `/buildings`, `/batches`, `/inventory`, `/warehouse`
  - `/buildings` returns single largest building (via `PLANT_PRIMARY_BUILDING` view)
  - `/warehouse` generates synthetic floor plan zones, sensor readings, 24h timeline
- `App.tsx` — "Plant Intelligence" nav entry in Solution Accelerators
- `Home.tsx` — Plant Intelligence home card

## Prerequisites

- `$add-pharma-supply-chain` deployed (plants, batches, inventory, shipments tables must exist)
- `OVERTURE_MAPS__BUILDINGS` database available (confirmed on all HOL instances)
- ACCOUNTADMIN role

## Workflow

### Step 1: Build Plant Footprints (required once)

Execute `references/build-plant-footprints.sql`:

```sql
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
```

This creates:
- `FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_BUILDING_FOOTPRINTS` — Overture building polygons per plant
- `FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS` — aggregated alert severity view
- `FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_PRIMARY_BUILDING` — largest building per plant (used by warehouse drill-down)

**Expected output:**
```
BUILDING_FOOTPRINT_ROWS | PLANTS_WITH_FOOTPRINTS
------------------------|-----------------------
        ~200-800        |           6
```

If `plants_with_footprints < 6`, some plants may have no Overture data in their area — these will show as plant markers with no building footprint overlay (still functional, just no zoom-in buildings).

**Verify alert status:**
```sql
SELECT PLANT_NAME, MAX_SEVERITY, CRITICAL_BATCHES, TEMP_EXCURSIONS
FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANT_ALERT_STATUS
ORDER BY MAX_SEVERITY DESC;
```

Expected: Mount Vernon and Macclesfield show MAX_SEVERITY = 4 (crimson — critical batch holds).

### Step 2: Upgrade SPCS Service

The ORS Control App SPCS service needs to be updated to use image v1.0.200:

```sql
ALTER SERVICE OPENROUTESERVICE_APP.CORE.ORS_CONTROL_APP
  FROM SPECIFICATION_FILE = '@OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/services/ors_control_app/ors_control_app_service.yaml';
```

Or redeploy with: `$build-routing-solution` (which will pick up v1.0.203 automatically from `image-versions.env`).

## Alert Color Legend

| Color | Severity | Trigger |
|-------|----------|---------|
| Crimson | 4 — Critical | Batch ON_HOLD with critical deviations or REJECTED |
| Red | 3 — High | Temperature excursion or major batch deviation |
| Amber | 2 — Moderate | Shipment delayed >7 days or critical stock |
| Yellow | 1 — Low | Low stock or short shipment delay |
| Green | 0 — None | No active alerts |

## Expected Visualization

**Thursday demo flow:**
1. Open Plant Intelligence → world map shows 6 plant dots
2. Macclesfield (UK) = crimson dot (Tagrisso API critical + batch on hold)
3. Mount Vernon (US) = crimson dot (Enhertu batch critical hold, $2.35M at risk)
4. Click Mount Vernon → zooms to New York state → Overture buildings appear as red 3D polygons
5. Side panel shows: "1 batch on hold: Enhertu (T-DXd), 4 critical deviations, $2.35M"
6. Switch to Inventory tab → "Enhertu API: 1.2 kg, 8 days coverage, CRITICAL"
7. Singapore → green dot → no alerts, building footprints green
