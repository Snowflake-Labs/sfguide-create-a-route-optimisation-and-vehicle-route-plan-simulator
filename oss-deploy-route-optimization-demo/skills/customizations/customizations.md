---
name: demo-customizations
description: "Customize demo-specific settings like industries. NOT for changing location or vehicles - use oss-install-openrouteservice-native-app skills for that. Triggers: customize demo, change demo industries, customize industries."
---

# Demo Customizations

Customize demo-specific settings. This skill is ONLY for demo components (industries, notebooks).

> **_STOP - FOR LOCATION OR VEHICLE CHANGES:_**
> 
> ❌ **DO NOT USE THIS SKILL** to change the map location or vehicle profiles.
> 
> ✅ **To change location**, use:
> ```
> use the local skill from oss-install-openrouteservice-native-app/skills/customizations/location
> ```
> 
> ✅ **To change vehicles**, use:
> ```
> use the local skill from oss-install-openrouteservice-native-app/skills/customizations/vehicles
> ```

## Prerequisites

- Demo must be installed (`VEHICLE_ROUTING_SIMULATOR` database exists)
- OpenRouteService Native App deployed and running

## Demo Customization Options

| Component | Skill | Description |
|-----------|-------|-------------|
| **Industries** | `industries.md` | Customize industry categories (product types, customers) |
| **AISQL Notebook** | `aisql-notebook.md` | Update AI prompts for sample data generation |
| **Carto Notebook** | `carto-notebook.md` | Update POI data source |

## Workflow

### Step 1: Determine Customization Scope

**Goal:** Ask user what they want to customize to determine which sub-skills to run

**Actions:**

1. **Ask the user three yes/no questions:**

   **Question 1: "Do you want to customize the LOCATION (map region)?"**
   - Examples: Change from San Francisco to Paris, London, Tokyo, etc.
   - If YES → Will run: `location.md`, `vehicles.md`
   
   **Question 2: "Do you want to customize VEHICLE TYPES (routing profiles)?"**
   - Examples: Add walking, wheelchair, electric bicycle; remove truck
   - If YES → Will run: `vehicles.md`
   
   **Question 3: "Do you want to customize INDUSTRIES for the demo?"**
   - Examples: Change from Food/Healthcare/Cosmetics to Beverages/Electronics/Pharmaceuticals
   - If YES → Will run: `industries.md`

   **For ANY customization (Location, Vehicles, or Industries = YES):**
   - Will ALWAYS run: `streamlits.md`, `aisql-notebook.md`, `carto-notebook.md`
   - Will ALWAYS require: `deploy-demo` to apply changes to Snowflake

2. **Determine the execution plan based on answers:**

   | User Choice | Sub-Skills to Run |
   |-------------|-------------------|
   | Location = YES | `location.md` → `vehicles.md` → `streamlits.md` → `aisql-notebook.md` → `carto-notebook.md` → **deploy-route-optimizer** → `deploy-demo` |
   | Vehicles = YES | `vehicles.md` → `streamlits.md` → `aisql-notebook.md` → `carto-notebook.md` → **deploy-route-optimizer** → `deploy-demo` |
   | Industries only = YES | `industries.md` → `streamlits.md` → `aisql-notebook.md` → `carto-notebook.md` → `deploy-demo` |
   | Location OR Vehicles + Industries | All relevant sub-skills → **deploy-route-optimizer** → `deploy-demo` |
   | ALL = NO | Inform user nothing to customize, exit |

   > **NOTE:** When Location or Vehicles change, `deploy-route-optimizer` must be run to push the updated `function_tester.py` to the Native App. Images don't need to be rebuilt - only the app code is updated.

3. **Get the target region/city name:**
   - If Location = YES: Ask user for the target region (e.g., "Paris", "Great Britain", "New York")
   - Store as `<REGION_NAME>` for use in sub-skills
   
   - If the map region is country/state-wide, ask which major city to use for sample data
   - Store as `<NOTEBOOK_CITY>` for use in notebook customizations

4. **Summarize the plan to user:**
   - "Based on your choices, I will run the following customizations:"
   - List what will be customized
   - List what will NOT change
   - Ask for confirmation before proceeding

**Output:** Customization scope determined, user confirmed plan

### Step 2: Execute Sub-Skills

**Goal:** Run the appropriate sub-skills based on user choices

**Actions:**

Execute the sub-skills in this order:

1. **If Location = YES:**
   - Run `oss-install-openrouteservice-native-app/skills/customizations/location.md` with `<REGION_NAME>`
   - This downloads the new map, updates ors-config.yml, and triggers graph rebuild

2. **If Location = YES OR Vehicles = YES:**
   - Run `oss-install-openrouteservice-native-app/skills/customizations/vehicles.md` with `<REGION_NAME>`
   - This configures routing profiles in ors-config.yml and triggers graph rebuild

3. **If Industries = YES:**
   - Run `oss-deploy-route-optimization-demo/skills/customizations/industries.md`
   - This customizes industry categories in the demo

4. **ALWAYS run (for any customization):**
   - Run `oss-deploy-route-optimization-demo/skills/customizations/streamlits.md` with `<REGION_NAME>` and `<NOTEBOOK_CITY>`
   - This updates Function Tester and Simulator with region-specific coordinates

5. **ALWAYS run (for any customization):**
   - Run `oss-deploy-route-optimization-demo/skills/customizations/aisql-notebook.md` with `<NOTEBOOK_CITY>`
   - This updates AI prompts in the AISQL notebook

6. **ALWAYS run (for any customization):**
   - Run `oss-deploy-route-optimization-demo/skills/customizations/carto-notebook.md` with `<NOTEBOOK_CITY>`
   - This updates POI data source and geohash filter

**Output:** All relevant sub-skills executed

### Step 3: Deploy Updates

**Goal:** Apply customizations to Snowflake

**Actions:**

1. **If Location OR Vehicles changed:**
   - Run `deploy-route-optimizer` to push the updated `function_tester.py` to the Native App
   - Images do NOT need to be rebuilt - only the app code is updated
   - Run: `use the local skill from skills/deploy-route-optimizer`
   - Resume services to rebuild graphs (if location changed)

2. **ALWAYS run `deploy-demo`** to apply changes:
   - This is required for ANY customization (location, vehicles, or industries)
   - The notebooks and Simulator Streamlit must be re-deployed to reflect the changes
   - Run: `use the local skill from skills/deploy-demo`

**Output:** Customizations deployed to Snowflake

## Running Individual Sub-Skills

Users can also run individual customizations directly:

**ORS Skills (map and graph changes):**
```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/location
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/vehicles
```

**Demo Skills (app and notebook changes):**
```
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/industries
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/streamlits
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/aisql-notebook
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/carto-notebook
```

> **_WARNING:_** If you run `location` or `vehicles` individually, you MUST also run the `streamlits` skill afterward to update the Streamlit apps with the new configuration.

## Output

Customized OpenRouteService deployment based on user choices with all relevant components updated consistently.
