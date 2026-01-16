---
name: customize-aisql-notebook
description: "Update the AISQL notebook with region-specific AI prompts. Use when: changing map region to generate sample data for new location. Triggers: customize notebook, update aisql, change notebook location."
---

# Customize AISQL Notebook

Updates the routing_functions_aisql.ipynb notebook to generate AI sample data for your chosen region.

## Prerequisites

- Active Snowflake connection
- Access to `Notebook/routing_functions_aisql.ipynb`
- Know the target city for sample data generation

## Input Parameters

- `<NOTEBOOK_CITY>`: The city to use for AI-generated sample data (e.g., "London", "Paris", "Berlin")
  - For country/state maps, use a major city within that region
  - For city maps, use that city directly

## Why This Matters

The AISQL notebook uses Cortex AI to generate realistic sample data:
- Restaurants, hotels, suppliers
- Customer addresses
- Delivery jobs with locations

All generated coordinates must be within the routing map boundaries. If the map covers "Great Britain" but the AI generates addresses in "San Francisco", the routes will fail.

## Workflow

### Step 1: Identify Cells to Update

**Goal:** Find all AI prompts that reference locations

**Actions:**

1. **Read** `Notebook/routing_functions_aisql.ipynb`

2. **Identify** cells with location-specific AI prompts:

   | Cell Name | Current Reference | Purpose |
   |-----------|-------------------|---------|
   | `simple_directions_data` | "Mission District", "Financial District", "SAN FRANCISCO" | Generate hotel + restaurant |
   | `ten_random` | "San Francisco" | Generate 10 restaurants |
   | `gen_supplier` | "San Francisco" | Generate food supplier |
   | `one_vehicle_optimisation` | "San Francisco" | Generate delivery jobs |
   | `service_these_people` | "San Francisco" | Generate 40 customer addresses |
   | `takeawaydeliveries` | "San Francisco" | Generate takeaway deliveries |
   | `geocode_summit_address` | "450 Concar Dr, San Mateo, CA" | Snowflake office for isochrone |
   | `isochrones_try` | Same SF address | Isochrone demo |

**Output:** List of cells requiring updates

### Step 2: Research Target City

**Goal:** Gather location details for the new city

**Actions:**

1. **Identify** two distinct districts/neighborhoods in `<NOTEBOOK_CITY>`:
   - `<DISTRICT_1>`: e.g., "Westminster" for London
   - `<DISTRICT_2>`: e.g., "Canary Wharf" for London

2. **Find** a notable address for isochrone demo:
   - Snowflake office in the city, OR
   - A well-known landmark

**Output:** City details gathered

### Step 3: Update AI Prompts

**Goal:** Replace all San Francisco references with new city

**Actions:**

1. **Update** `simple_directions_data` cell:
   - From: `'Return 1 hotel in the Mission District and 1 restaurant in the Financial District IN SAN FRANCISCO.'`
   - To: `'Return 1 hotel in <DISTRICT_1> and 1 restaurant in <DISTRICT_2> IN <NOTEBOOK_CITY>.'`

2. **Update** `ten_random` cell:
   - From: `'Return 10 restaurants in San Francisco.'`
   - To: `'Return 10 restaurants in <NOTEBOOK_CITY>.'`

3. **Update** `gen_supplier` cell:
   - From: `'give me a location in San Francisco that sells food to restaurants.'`
   - To: `'give me a location in <NOTEBOOK_CITY> that sells food to restaurants.'`

4. **Update** `one_vehicle_optimisation` cell:
   - From: `'Return 10 delivery jobs with 1 available vehicle in San Francisco.'`
   - To: `'Return 10 delivery jobs with 1 available vehicle in <NOTEBOOK_CITY>.'`

5. **Update** `service_these_people` cell:
   - From: `'give me 40 random residential locations in San Francisco'`
   - To: `'give me 40 random residential locations in <NOTEBOOK_CITY>'`

6. **Update** `takeawaydeliveries` cell:
   - From: `'in San Francisco based on the following template'`
   - To: `'in <NOTEBOOK_CITY> based on the following template'`

7. **Update** `geocode_summit_address` and `isochrones_try` cells:
   - Replace SF Snowflake office address with `<NOTEBOOK_CITY>` address
   - Update table name from `GEOCODE_SF_OFFICE` if desired

**Output:** All AI prompts updated

### Step 4: Update Markdown Descriptions

**Goal:** Update notebook documentation to match

**Actions:**

1. **Update** `title` cell:
   - Mention `<NOTEBOOK_CITY>` in the title

2. **Update** `heading_simple_directions` cell:
   - Change "San Francisco" references to `<NOTEBOOK_CITY>`

3. **Update** `create_synthetic_jobs_and_vehicle` cell:
   - Change "San Francisco" to `<NOTEBOOK_CITY>`

4. **Update** `head_multi_vehicles` cell:
   - Change "San Francisco" to `<NOTEBOOK_CITY>`

5. **Update** `optimal_base_table` cell:
   - Change "SAN FRANCISCO" to `<NOTEBOOK_CITY>` in heading

**Output:** Markdown descriptions updated

### Step 5: Upload Notebook

**Goal:** Deploy updated notebook to Snowflake

**Actions:**

1. **Upload** to stage:
   ```bash
   snow stage copy "Notebook/routing_functions_aisql.ipynb" @VEHICLE_ROUTING_SIMULATOR.NOTEBOOKS.notebook --overwrite
   ```

2. **Verify** upload succeeded

**Output:** Notebook deployed

## Example Updates for London

| Cell | Before | After |
|------|--------|-------|
| `simple_directions_data` | "Mission District", "Financial District", "SAN FRANCISCO" | "Westminster", "Canary Wharf", "LONDON" |
| `ten_random` | "San Francisco" | "London" |
| `gen_supplier` | "San Francisco" | "London" |
| `geocode_summit_address` | "450 Concar Dr, San Mateo, CA" | "1 Canada Square, London E14" |

## Stopping Points

- ✋ After Step 3: Review all prompt changes with user
- ✋ After Step 5: Verify notebook uploaded successfully

## Output

AISQL notebook customized for `<NOTEBOOK_CITY>`. When run, it will generate sample data (restaurants, customers, delivery jobs) within the specified city.
