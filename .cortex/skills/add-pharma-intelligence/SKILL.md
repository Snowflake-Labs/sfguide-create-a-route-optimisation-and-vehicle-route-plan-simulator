---
name: add-pharma-intelligence
description: "Add Pharma Supply Intelligence to the Routing Agent: inventory management, wastage analysis, demographic demand forecasting, and replenishment planning for 6 SF pharmacy partners. Creates 3 synthetic data tables, 3 stored procedure tools, a Cortex Analyst semantic view, and updates the ROUTING_AGENT. Use when: adding pharma supply chain analytics, wastage analysis, demand forecasting, replenishment planning, manufacturing intelligence. Prerequisites: routing-agent must be deployed. Triggers: pharma supply, inventory, wastage, demand forecast, replenishment, manufacturing, stock analysis, expiry, cold chain analytics."
depends_on:
  - routing-agent
metadata:
  author: Snowflake SIT-IS
  version: 1.0.0
  category: intelligence-agent
---

# Add Pharma Supply Intelligence

Extends the Routing Agent with pharmaceutical supply chain analytics — linking population health demographics to drug demand forecasting, inventory management, wastage analysis, and replenishment planning.

**The story:** A pharmaceutical manufacturer distributes to 6 pharmacy partners across San Francisco. The key challenge is not routing (handled by the distribution partner) but **intelligence**: which products are wasting, whether the right product mix is stocked for each pharmacy's catchment demographics, and what to manufacture next.

## What Gets Created

| Object | Purpose |
|--------|---------|
| `SF_INVENTORY` | 150-row synthetic table: current stock, expiry, wastage per pharmacy per drug |
| `SF_DEMAND_FORECAST` | Monthly forecast from demographic model (pop × morbidity% × units_per_1000) |
| `SF_REPLENISHMENT_ORDERS` | Prioritised manufacturing/dispatch plan |
| `TOOL_INVENTORY_STATUS` | Agent tool: stock status, near-expiry, wastage alerts |
| `TOOL_DEMAND_FORECAST` | Agent tool: demographic demand forecast for a pharmacy |
| `TOOL_REPLENISHMENT_PLAN` | Agent tool: prioritised replenishment by delivery type |
| `PHARMA_ANALYTICS_VIEW` | Cortex Analyst semantic view for text-to-SQL analytics |
| Updated `ROUTING_AGENT` | Agent with 3 new tools + `pharma_analytics` Cortex Analyst tool |
| Updated `agent-demos.json` | New "Pharma Supply Intelligence" scenario |

## Prerequisites

- `$routing-agent` deployed (ROUTING_AGENT exists in `FLEET_INTELLIGENCE.ROUTING_AGENT`)
- `$setup-agent-playground` run (SF_DRUG_FORMULARY, SF_TOP_PHARMACIES, SF_HEALTH_DEMOGRAPHICS must exist)
- ROUTING_ANALYTICS warehouse available
- ACCOUNTADMIN role

## Data Model

```
SF_TOP_PHARMACIES (6 rows)
    ↓
SF_INVENTORY (150 rows: 6 × 25 drugs)  ←→  SF_DRUG_FORMULARY (25 drugs)
    ↓
SF_DEMAND_FORECAST (150 rows)           ←→  SF_HEALTH_DEMOGRAPHICS (55 neighborhoods)
    ↓
SF_REPLENISHMENT_ORDERS (variable)
    ↓
PHARMA_ANALYTICS_VIEW (semantic view joining all tables)
```

**Demand model:** `forecast_units = catchment_population × (morbidity_rate / 100) × units_per_1000 / 1000`

## Workflow

### Step 1: Deploy Data Tables

Execute `references/deploy-pharma-data.sql`:

```sql
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ROUTING_ANALYTICS;
```

Run the full file. This creates SF_INVENTORY, SF_DEMAND_FORECAST (computed from demographics), and SF_REPLENISHMENT_ORDERS.

**Verify:**
```sql
SELECT 'SF_INVENTORY' AS tbl, COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_INVENTORY
UNION ALL SELECT 'SF_DEMAND_FORECAST', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_DEMAND_FORECAST
UNION ALL SELECT 'SF_REPLENISHMENT_ORDERS', COUNT(*) FROM FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.SF_REPLENISHMENT_ORDERS;
```

**Expected:** 150 / 150 / ~40–60 rows respectively.

### Step 2: Deploy Tools, Semantic View, and Updated Agent

Execute `references/deploy-pharma-tools.sql` — creates all 3 stored procedures, the semantic view, and recreates the ROUTING_AGENT with all tools.

**Verify tools:**
```sql
CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_INVENTORY_STATUS(NULL);
CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DEMAND_FORECAST('Walgreens Castro', NULL);
CALL FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_REPLENISHMENT_PLAN('URGENT');
```

**Verify semantic view:**
```sql
SELECT pharmacy_name, SUM(wastage_value_usd) AS total_wastage
FROM FLEET_INTELLIGENCE.ROUTING_AGENT.PHARMA_ANALYTICS_VIEW
GROUP BY pharmacy_name
ORDER BY total_wastage DESC;
```

**Verify agent:**
```sql
SHOW AGENTS IN SCHEMA FLEET_INTELLIGENCE.ROUTING_AGENT;
```

### Step 3: Update Agent Playground Config

Upload the updated `agent-demos.json` (which now includes the "Pharma Supply Intelligence" scenario) to the ORS stage:

```sql
COPY FILES INTO @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/
FROM '<WORKSPACE_STAGE_URI>'
FILES=('agent-demos.json');
```

**Verify:**
```sql
SELECT $1 FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json
  (FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.JSON_FORMAT');
```

Expected: JSON with 6 scenarios including `"id": "pharma_supply"`.

## Demo Scenario Flow

The 5 prompts tell a complete story:

1. **Wastage alert** → agent calls `TOOL_INVENTORY_STATUS` → shows CRITICAL items, near-expiry, total wastage cost
2. **Cold chain wastage** → agent calls `TOOL_INVENTORY_STATUS` filtered to cold chain → highlights expensive insulin/Ozempic waste
3. **Demand forecast** → agent calls `TOOL_DEMAND_FORECAST` for Mission → shows demographic mismatch (high need, low stock)
4. **Replenishment plan** → agent calls `TOOL_REPLENISHMENT_PLAN(URGENT)` → prioritised manufacturing order (cold chain first)
5. **Redistribute stock** → agent calls `TOOL_REPLENISHMENT_PLAN` then `TOOL_ROUTE_OPTIMIZATION` → plans van route to move expiring stock from CVS Market St (overstocked) to Walgreens Mission (critically low)

## Key Insights in the Data

The synthetic data is designed to surface realistic supply chain problems:

| Problem | Pharmacy | Drug | Story |
|---------|----------|------|-------|
| Wrong product mix | CVS Market St | Insulin, Ozempic | Young/tech demographic — chronic disease drugs overstocked, wasting |
| Under-supply | Walgreens Mission | All categories | Underserved area, chronic under-ordering, 85% fill rate |
| Near-expiry waste | Rite Aid Clement | Budesonide | 5 days to expiry, 14 units wasted |
| Cold chain overstocked | CVS Market St | Insulin Lispro | 70 units on hand vs ~20 needed, $640 waste |
| Critically low | Walgreens Mission | Nitroglycerin | 2 units, 8 days to expiry — emergency restock needed |

> **After running this skill**, re-run `$setup-agent-playground` (Step 2: `references/configure-agent.sql`) to register the new tools with the Routing Agent.
