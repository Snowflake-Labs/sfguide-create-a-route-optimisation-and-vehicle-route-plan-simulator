---
name: add-pharma-supply-chain
description: "Add upstream pharmaceutical manufacturing supply chain intelligence to the Routing Agent. Creates 6 tables (plants, suppliers, products, batches, shipments, material inventory), a Cortex Analyst semantic view, and adds a pharma_supply_chain tool to the ROUTING_AGENT. Business lines: ONCOLOGY, CARDIOVASCULAR, RESPIRATORY, BIOLOGICS. Manufacturing plants in UK, US, Sweden, Singapore, Ireland. Use when: adding upstream supply chain, manufacturing intelligence, supplier reliability, batch analytics, shipment tracking. Prerequisites: routing-agent deployed. Triggers: supply chain, manufacturing, supplier, batch, API, upstream, plants, shipments."
depends_on:
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: intelligence-agent
---

# Add Pharma Upstream Supply Chain Intelligence

Extends the Routing Agent with upstream pharmaceutical manufacturing analytics — from API suppliers through manufacturing plants to batch production and inbound shipments.

**The story:** A global pharmaceutical company manufactures across 6 sites. The upstream challenge is supplier reliability, batch quality, cold chain integrity, and raw material coverage — all feeding into the downstream pharmacy distribution network.

## What Gets Created

| Object | Description |
|--------|-------------|
| `PLANTS` | 6 manufacturing sites: Macclesfield UK, Mount Vernon US, Södertälje SE, Singapore, Dunboyne IE, Lubbock US |
| `SUPPLIERS` | 12 API/excipient/contract suppliers with reliability scores, lead times, GMP status |
| `PRODUCTS` | 17 branded products across ONCOLOGY, CARDIOVASCULAR, RESPIRATORY, BIOLOGICS |
| `PRODUCTION_BATCHES` | 15 recent batches including on-hold and rejected batches |
| `SHIPMENTS` | 13 inbound shipments with delays, customs holds, and temperature excursions |
| `MATERIAL_INVENTORY` | Raw material/API stock at each plant with days of coverage |
| `PHARMA_SUPPLY_CHAIN_SV` | Cortex Analyst semantic view joining all tables |
| Updated `ROUTING_AGENT` | `pharma_supply_chain` Cortex Analyst tool added |
| Updated `agent-demos.json` | "Pharma Manufacturing" scenario with 5 prompts |

## Prerequisites

- `$routing-agent` deployed
- ROUTING_ANALYTICS warehouse
- ACCOUNTADMIN role

## Workflow

### Step 1: Deploy Tables and Semantic View

Execute `references/deploy-pharma-supply-chain.sql`:

```sql
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
```

**Verify:**
```sql
SELECT 'PLANTS', COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PLANTS
UNION ALL SELECT 'SUPPLIERS', COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SUPPLIERS
UNION ALL SELECT 'PRODUCTS',  COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTS
UNION ALL SELECT 'BATCHES',   COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PRODUCTION_BATCHES
UNION ALL SELECT 'SHIPMENTS', COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.SHIPMENTS
UNION ALL SELECT 'INVENTORY', COUNT(*) FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.MATERIAL_INVENTORY;
```

Expected: 6 / 12 / 17 / 15 / 13 / 17

### Step 2: Update ROUTING_AGENT

Execute `references/update-agent-supply-chain.sql` — adds `pharma_supply_chain` Cortex Analyst tool to the agent alongside all existing tools.

**Verify:**
```sql
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;

-- Quick test
SELECT * FROM FLEET_INTELLIGENCE.PHARMA_SUPPLY_CHAIN.PHARMA_SUPPLY_CHAIN_SV
WHERE material_stock_status = 'CRITICAL'
LIMIT 5;
```

### Step 3: Upload Updated agent-demos.json

```sql
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM '<WORKSPACE_STAGE_URI>'
FILES=('agent-demos.json');
```

## Key Insights in the Data

| Issue | Product | Detail |
|-------|---------|--------|
| Batch on critical hold | Enhertu (T-DXd) | MVI-2024-002 — 4 critical deviations, $2.35M at risk |
| Temperature excursion | Fasenra (Benralizumab) | Inbound shipment temp breach — batch may need rejection |
| Probation supplier | Wuxi Biologics | Supplies Imfinzi (Durvalumab) — critical oncology biologic |
| Single-source risk | Soliris (Eculizumab) | Only Lonza as supplier — no backup for $5.8M shipment |
| API critically low | Tagrisso (Osimertinib) | Only 18 days coverage at Macclesfield |
| Customs hold | Enhertu API | 12-day delay — already critically low stock |

## End-to-End Demo Story

Prompt 5 ("End-to-end risk") connects both layers:
1. **Upstream**: Enhertu API delayed in customs, batch on hold at Mount Vernon, Wuxi Biologics on probation
2. **Downstream**: Injectable products critically low at Walgreens Mission (pharmacy inventory)
3. **Result**: Agent identifies patient impact risk and recommends urgent actions across both layers

> **After running this skill**, re-run `$setup-agent-playground` (Step 2: `references/configure-agent.sql`) to register the new tools with the Routing Agent.
