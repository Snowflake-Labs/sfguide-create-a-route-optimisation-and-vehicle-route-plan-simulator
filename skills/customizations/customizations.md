---
name: customizations
description: "Customize your OpenRouteService deployment. Use when: changing location, modifying vehicle profiles, customizing industries, updating notebooks, or configuring Streamlit apps. Triggers: customize, customize deployment, change settings."
---

# OpenRouteService Customizations

Main entry point for customizing your OpenRouteService deployment. This skill determines what you want to customize and runs the appropriate sub-skills.

## Prerequisites

- Active Snowflake connection with access to:
  - `OPENROUTESERVICE_SETUP` database
  - `OPENROUTESERVICE_NATIVE_APP` application
- OpenRouteService Native App deployed and running
- Services in `OPENROUTESERVICE_NATIVE_APP.CORE` schema

## Customization Options

| Component | Skill File | Description |
|-----------|------------|-------------|
| **Location** | `location.md` | Change map region (download new map, rebuild routing graphs) |
| **Vehicle Types** | `vehicles.md` | Enable/disable routing profiles (car, truck, bicycle, walking, etc.) |
| **Industries** | `industries.md` | Customize industry categories for the demo (product types, customers) |
| **Streamlit Apps** | `streamlits.md` | Update Function Tester & Simulator with region-specific coordinates |
| **AISQL Notebook** | `aisql-notebook.md` | Update AI prompts to generate data for your region |
| **Carto Notebook** | `carto-notebook.md` | Update POI data source for your region |

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
   | Location = YES | `location.md` → `vehicles.md` → `streamlits.md` → `aisql-notebook.md` → `carto-notebook.md` → `deploy-demo` |
   | Vehicles = YES | `vehicles.md` → `streamlits.md` → `aisql-notebook.md` → `carto-notebook.md` → `deploy-demo` |
   | Industries = YES | `industries.md` → `streamlits.md` → `aisql-notebook.md` → `carto-notebook.md` → `deploy-demo` |
   | Any combination | All relevant sub-skills + `streamlits.md` + `aisql-notebook.md` + `carto-notebook.md` → `deploy-demo` |
   | ALL = NO | Inform user nothing to customize, exit |

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
   - Run `location.md` with `<REGION_NAME>`
   - This downloads the map, updates config, and rebuilds routing graphs

2. **If Location = YES OR Vehicles = YES:**
   - Run `vehicles.md` with `<REGION_NAME>`
   - This configures routing profiles in ors-config.yml

3. **If Industries = YES:**
   - Run `industries.md`
   - This customizes industry categories in the demo

4. **ALWAYS run (for any customization):**
   - Run `streamlits.md` with `<REGION_NAME>` and `<NOTEBOOK_CITY>`
   - This updates Function Tester and Simulator with region-specific coordinates

5. **ALWAYS run (for any customization):**
   - Run `aisql-notebook.md` with `<NOTEBOOK_CITY>`
   - This updates AI prompts in the AISQL notebook

6. **ALWAYS run (for any customization):**
   - Run `carto-notebook.md` with `<NOTEBOOK_CITY>`
   - This updates POI data source and geohash filter

**Output:** All relevant sub-skills executed

### Step 3: Save Customizations

**Goal:** Save all customizations - either to Git or locally

**Actions:**

1. **Check** if Git is available:
   ```bash
   git status
   ```

2. **If Git is NOT available:**
   - Inform user that customizations have been made to local files
   - Recommend keeping a backup if they want to restore defaults later
   - Skip to Step 4

3. **If Git IS available:**
   - Ask user if they want to save to a feature branch
   - If YES:
     ```bash
     git checkout -b feature/ors-<REGION_NAME>
     git add Native_app/provider_setup/staged_files/ors-config.yml
     git add Native_app/services/openrouteservice/openrouteservice.yaml
     git add Native_app/code_artifacts/streamlit/pages/function_tester.py
     git add Notebook/routing_functions_aisql.ipynb
     git add Notebook/add_carto_data.ipynb
     git add Streamlit/routing.py
     git commit -m "Customize ORS deployment for <REGION_NAME>"
     ```
   - Inform user about branch management

**Output:** Customizations saved

### Step 4: Deploy Updates

**Goal:** Apply customizations to Snowflake

**Actions:**

1. **If Location or Vehicles changed:**
   - Upload updated files and upgrade Native App
   - Resume services to rebuild graphs

2. **ALWAYS run `deploy-demo`** to apply changes:
   - This is required for ANY customization (location, vehicles, or industries)
   - The notebooks and Streamlit apps must be re-deployed to reflect the changes
   - Run: `use the local skill from skills/deploy-demo`

**Output:** Customizations deployed to Snowflake

## Running Individual Sub-Skills

Users can also run individual customizations directly:

```
use the local skill from skills/customizations/location
use the local skill from skills/customizations/vehicles
use the local skill from skills/customizations/industries
use the local skill from skills/customizations/streamlits
use the local skill from skills/customizations/aisql-notebook
use the local skill from skills/customizations/carto-notebook
```

## Output

Customized OpenRouteService deployment based on user choices with all relevant components updated consistently.
