# Create a Route Optimisation and Vehicle Route Plan Simulator

## Overview

This project deploys OpenRouteService as a Snowflake Native App with Snowpark Container Services (SPCS). It provides route optimization, directions, and isochrone calculations for configurable geographic regions.

## Installation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         INSTALLATION FLOW                                    │
└─────────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│  CHECK PREREQUISITES                                               │
│  skills/check-prerequisites                                        │
│                                                                    │
│  Checks for:                                                       │
│  • VS Code, Cortex Code CLI, Docker/Podman, Snowflake CLI, Git   │
│  • Snowflake connection configuration                              │
│  • ACCOUNTADMIN access and SPCS enabled                            │
│                                                                    │
│  Guides installation of any missing dependencies                   │
└────────┬──────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  DEPLOY APP     │  ←── skills/deploy-route-optimizer
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Creates:                                                        │
│  • Application Package (OPENROUTESERVICE_NATIVE_APP_PKG)        │
│  • Native App (OPENROUTESERVICE_NATIVE_APP)                     │
│  • Compute Pool for SPCS services                               │
│  • 4 Container Services:                                         │
│    - ORS_SERVICE (OpenRouteService engine)                      │
│    - VROOM_SERVICE (Route optimization)                         │
│    - ROUTING_GATEWAY_SERVICE (API gateway)                      │
│    - DOWNLOADER (Map data manager)                              │
│  • Default Map: San Francisco                                    │
└────────┬────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│  LAUNCH APP IN UI   │  ←── Required for first-time activation
└────────┬────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│   OPTIONAL: CUSTOMIZE YOUR DEPLOYMENT                            │
│   skills/customizations                                          │
│                                                                  │
│  Modular sub-skills for flexible customization:                 │
│  • location.md     - Download new map, rebuild routing graphs   │
│  • vehicles.md     - Configure routing profiles                 │
│  • industries.md   - Customize industry categories              │
│  • streamlits.md   - Update Function Tester + Simulator         │
│  • aisql-notebook.md - Update AI prompts for your region        │
│  • carto-notebook.md - Update POI data source                   │
│                                                                  │
│  Main orchestrator asks what you want to customize and          │
│  runs only the relevant sub-skills                              │
│                                                                  │
│  ⚠️  Run this BEFORE deploy-demo if you want a custom region     │
└────────┬────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│   OPTIONAL: DEPLOY DEMO                                          │
│   skills/deploy-demo                                             │
│                                                                  │
│  Deploys notebooks and Streamlit with customized locations:     │
│  • Gets Overture Maps POI data from Snowflake Marketplace       │
│  • Creates AISQL Notebook in Snowflake                          │
│  • Deploys Route Simulator Streamlit app                        │
│                                                                  │
│  ⚠️  Run AFTER customize map to use your chosen region           │
│     (Otherwise defaults to San Francisco)                        │
└────────┬────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  READY TO USE                                                    │
│                                                                  │
│  Native App Functions:                                           │
│  • DIRECTIONS(profile, coordinates) - Get route directions      │
│  • OPTIMIZATION(jobs, vehicles) - Optimize vehicle routes       │
│  • ISOCHRONES(profile, lon, lat, minutes) - Travel time polygons│
│                                                                  │
│  Streamlit Apps:                                                 │
│  • Function Tester - Test routing functions interactively       │
│  • Route Simulator - Full vehicle routing simulation            │
│                                                                  │
│  Notebooks:                                                      │
│  • routing_functions_aisql.ipynb - AI-powered route demos       │
│  • add_carto_data.ipynb - Load POI data from Marketplace        │
└─────────────────────────────────────────────────────────────────┘

                              · · ·

┌─────────────────────────────────────────────────────────────────┐
│  UNINSTALL (When needed)                                         │
│  skills/uninstall-route-optimizer                                │
│                                                                  │
│  Removes all resources for fresh redeployment:                  │
│  • Native App (OPENROUTESERVICE_NATIVE_APP)                     │
│  • Application Package (OPENROUTESERVICE_NATIVE_APP_PKG)        │
│  • Setup Database (OPENROUTESERVICE_SETUP)                      │
│  • Compute Pool and Services                                     │
│  • Optional: Warehouse, local container images                   │
└─────────────────────────────────────────────────────────────────┘
```

### Quick Start Commands

```bash
# Step 0 (Recommended): Check and install prerequisites
use the local skill from skills/check-prerequisites

# Step 1: Deploy the Route Optimizer Native App
use the local skill from skills/deploy-route-optimizer

# Step 2 (Optional): Customize location, vehicles, and/or industries
# ⚠️ Run this BEFORE deploy-demo if you want customizations
# The orchestrator asks yes/no for each: location, vehicles, industries
# Then runs only the relevant sub-skills
use the local skill from skills/customizations

# Step 3 (Optional): Deploy demo notebooks and Streamlit
# ⚠️ Run AFTER customize-map to use your chosen region (otherwise defaults to San Francisco)
use the local skill from skills/deploy-demo

# Uninstall: Remove app and all dependencies (when needed)
use the local skill from skills/uninstall-route-optimizer
```

## Prerequisites

Before getting started, ensure you have the following installed:

### 1. Visual Studio Code (VS Code)
- **Required for:** Running Cortex Code CLI as an integrated terminal experience
- **Installation:** [Download VS Code](https://code.visualstudio.com/download)
- Open this project folder in VS Code before running Cortex Code commands

### 2. Cortex Code CLI
- **Installation:** See [Cortex Code documentation](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-code)
- Cortex Code is Snowflake's AI-powered CLI that enables natural language interactions with your codebase and Snowflake resources

### 3. Container Runtime (Docker or Podman)
- **Required for:** Building and pushing container images to Snowflake
- **Options (install one):**
  - **Podman** (recommended):
    - macOS: `brew install podman`
    - Windows: [Podman Desktop](https://podman-desktop.io/downloads)
    - Linux: `sudo apt install podman` or `sudo dnf install podman`
  - **Docker**:
    - macOS: [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
    - Windows: [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/)
    - Linux: [Docker Engine](https://docs.docker.com/engine/install/)
- Ensure the container runtime is running before deploying the app

### 4. Snowflake Account
- Access to a Snowflake account with ACCOUNTADMIN privileges (or appropriate roles)
- Snowpark Container Services enabled
- Sufficient compute resources for running SPCS services

### 5. Snowflake CLI (snow)
- Install via: `pip install snowflake-cli-labs`
- Configure a connection: `snow connection add`

### 6. Git (Optional)
- **Required for:** Cloning the repository (alternatively, download as ZIP)
- **Installation:**
  - macOS: `brew install git` or [Download](https://git-scm.com/download/mac)
  - Windows: [Git for Windows](https://git-scm.com/download/win)
  - Linux: `sudo apt install git` or `sudo yum install git`
- Verify installation: `git --version`

### 7. GitHub CLI (Optional)
- **Required for:** Managing GitHub operations from the command line
- **Installation:** [GitHub CLI](https://cli.github.com/)
  - macOS: `brew install gh`
  - Windows: `winget install --id GitHub.cli`
  - Linux: See [installation docs](https://github.com/cli/cli/blob/trunk/docs/install_linux.md)
- Authenticate: `gh auth login`

## Step-By-Step Guide

### 0. (Recommended) Check Prerequisites
- In Cortex Code CLI type: `use the local skill from skills/check-prerequisites`
- This will check for all required dependencies (VS Code, Cortex Code CLI, Docker/Podman, Snowflake CLI, Git)
- It will guide you through installing any missing tools
- It also verifies your Snowflake connection is configured correctly

### 1. Deploy App
- Go to the working directory of the project
- In Cortex Code CLI type: `use the local skill from skills/deploy-route-optimizer`
- After deployment, the link to the app will be provided. For first time use, you must launch the application in the UI
- The default map installed is for San Francisco

### 2. (Optional) Customize Your Deployment
- **Run this BEFORE deploy-demo if you want any customizations**
- After the app is deployed, you can customize location, vehicles, and/or industries
- Type in Cortex Code CLI: `use the local skill from skills/customizations`
- The orchestrator skill asks three yes/no questions:
  - **Location?** - Change map region (e.g., San Francisco → Paris)
  - **Vehicles?** - Modify routing profiles (add walking, wheelchair, etc.)
  - **Industries?** - Change industry categories (Food → Beverages, etc.)
- Based on your answers, it runs only the relevant sub-skills:
  - `location.md` - Downloads map, rebuilds routing graphs
  - `vehicles.md` - Configures routing profiles
  - `industries.md` - Customizes industry categories
  - `streamlits.md` - Updates Function Tester & Simulator
  - `aisql-notebook.md` - Updates AI prompts for your region
  - `carto-notebook.md` - Updates POI data source
- If you only change industries, no map download or app redeployment is needed

### 3. (Optional) Deploy Demo Notebook and Streamlit
- **Run AFTER customize-map to use your chosen region** (otherwise defaults to San Francisco)
- Type in Cortex Code CLI: `use the local skill from skills/deploy-demo`
- This deploys the customized notebooks and Streamlit apps to Snowflake

## Customization Skills

The customization system uses a **modular architecture** with a main orchestrator and individual sub-skills:

```
skills/customizations/
├── customizations.md    <- Main orchestrator (entry point)
├── location.md          <- Download new map, rebuild graphs
├── vehicles.md          <- Configure routing profiles
├── industries.md        <- Customize industry categories
├── streamlits.md        <- Update Function Tester & Simulator
├── aisql-notebook.md    <- Update AI prompts for your region
└── carto-notebook.md    <- Update POI data source
```

### How It Works

1. **Run the main skill:** `use the local skill from skills/customizations`
2. **Answer three yes/no questions:**
   - Customize LOCATION? (map region)
   - Customize VEHICLES? (routing profiles)
   - Customize INDUSTRIES? (demo categories)
3. **Orchestrator determines which sub-skills to run**
4. **Sub-skills execute in the correct order**
5. **Changes are applied to local files**
6. **Option to chain to deploy-demo**

### Decision Tree

| Question | If YES | If NO |
|----------|--------|-------|
| **Customize LOCATION?** | Downloads new map, uploads to stage, rebuilds graphs | Skips map download entirely |
| **Customize VEHICLES?** | Modifies routing profiles, rebuilds graphs | Keeps default profiles |
| **Customize INDUSTRIES?** | Modifies industry categories in notebooks | Keeps default industries |

### Which Sub-Skills Run

| User Choice | Sub-Skills Executed |
|-------------|---------------------|
| Location = YES | `location` → `vehicles` → `streamlits` → `aisql-notebook` → `carto-notebook` → **deploy-route-optimizer** → **deploy-demo** |
| Vehicles = YES | `vehicles` → `streamlits` → `aisql-notebook` → `carto-notebook` → **deploy-route-optimizer** → **deploy-demo** |
| Industries = YES | `industries` → `streamlits` → `aisql-notebook` → `carto-notebook` → **deploy-demo** |
| Location/Vehicles + Industries | All relevant + **deploy-route-optimizer** → **deploy-demo** |
| Nothing | No sub-skills (exit) |

> **IMPORTANT:** 
> - For ANY customization: All Streamlits and notebooks are updated, and `deploy-demo` MUST be run
> - For Location/Vehicles changes: `deploy-route-optimizer` MUST also be run to push updated `function_tester.py` to the Native App (images don't need rebuilding)

### Sub-Skill Details

| Sub-Skill | Purpose | What It Updates |
|-----------|---------|-----------------|
| `location.md` | Change map region | Downloads OSM map, uploads to stage, rebuilds routing graphs |
| `vehicles.md` | Configure profiles | Updates `ors-config.yml` with enabled/disabled profiles |
| `industries.md` | Customize demo | Modifies industry categories (products, customers, vehicle skills) |
| `streamlits.md` | Update apps | Sets region-specific coordinates in Function Tester & Simulator |
| `aisql-notebook.md` | Update AI prompts | Changes city references in AI_COMPLETE calls |
| `carto-notebook.md` | Update POI source | Modifies geohash filter for your region |

### Running Individual Sub-Skills

You can also run sub-skills directly for specific customizations:

```bash
use the local skill from skills/customizations/location
use the local skill from skills/customizations/vehicles
use the local skill from skills/customizations/industries
use the local skill from skills/customizations/streamlits
use the local skill from skills/customizations/aisql-notebook
use the local skill from skills/customizations/carto-notebook
```

### Routing Profiles

| Profile | Description |
|---------|-------------|
| `driving-car` | Standard passenger vehicle routing |
| `driving-hgv` | Heavy goods vehicle with truck restrictions |
| `cycling-road` | Road bicycle routing |
| `cycling-regular` | Regular bicycle routing |
| `cycling-mountain` | Mountain bike routing |
| `foot-walking` | Pedestrian walking |
| `foot-hiking` | Hiking trails |
| `wheelchair` | Wheelchair accessible routes |

**Note:** Enabling more profiles increases graph build time and resource usage.

## Customizing to a Different Region

When you run the customization skill, changes are made directly to your local files:

- `Native_app/provider_setup/staged_files/ors-config.yml` - Map file and routing profiles
- `Native_app/services/openrouteservice/openrouteservice.yaml` - Volume paths for map data
- `Native_app/code_artifacts/streamlit/pages/function_tester.py` - Function Tester coordinates
- `Streamlit/routing.py` - Simulator coordinates
- `Notebook/routing_functions_aisql.ipynb` - AI prompts for your region
- `Notebook/add_carto_data.ipynb` - POI data source for your region

**Tip:** If you want to preserve the original San Francisco configuration, make a backup of these files before customizing.

To customize to a new region:

1. Run: `use the local skill from oss-install-openrouteservice-native-app/skills/customizations`
2. Answer YES to customize location
3. Select your desired region
4. The skill will automatically:
   - Download the map (via `location.md`)
   - Update all configuration files (via `vehicles.md`)
   - Rebuild the routing graphs

## Available Skills

### Main Skills

| Skill | Description | Command |
|-------|-------------|---------|
| `check-prerequisites` | Check and install required dependencies | `use the local skill from skills/check-prerequisites` |
| `deploy-route-optimizer` | Deploy the ORS Native App | `use the local skill from skills/deploy-route-optimizer` |
| `customizations` | Orchestrate customizations (location, vehicles, industries) | `use the local skill from skills/customizations` |
| `deploy-demo` | Deploy demo notebooks and Streamlit apps | `use the local skill from skills/deploy-demo` |
| `uninstall-route-optimizer` | Remove app and clean up resources | `use the local skill from skills/uninstall-route-optimizer` |

### Customization Sub-Skills

| Sub-Skill | Description | Command |
|-----------|-------------|---------|
| `location` | Download new map, rebuild routing graphs | `use the local skill from skills/customizations/location` |
| `vehicles` | Configure routing profiles | `use the local skill from skills/customizations/vehicles` |
| `industries` | Customize industry categories for demo | `use the local skill from skills/customizations/industries` |
| `streamlits` | Update Function Tester & Simulator coordinates | `use the local skill from skills/customizations/streamlits` |
| `aisql-notebook` | Update AI prompts for your region | `use the local skill from skills/customizations/aisql-notebook` |
| `carto-notebook` | Update POI data source for your region | `use the local skill from skills/customizations/carto-notebook` |

## Project Structure

```
├── Native_app/
│   ├── code_artifacts/
│   │   └── streamlit/
│   │       └── pages/
│   │           └── function_tester.py    # Function tester with region coordinates
│   ├── provider_setup/
│   │   └── staged_files/
│   │       └── ors-config.yml            # ORS configuration with map and profiles
│   └── services/
│       └── openrouteservice/
│           └── openrouteservice.yaml     # Service spec with volume paths
├── Notebook/
│   ├── routing_functions_aisql.ipynb     # AI-powered route demos
│   └── add_carto_data.ipynb              # POI data from Marketplace
├── Streamlit/
│   └── routing.py                        # Route Optimization Simulator
├── skills/
│   ├── check-prerequisites/              # Dependency checking skill
│   │   └── check-prerequisites.md
│   ├── deploy-route-optimizer/           # App deployment skill
│   │   └── deploy-route-optimizer.md
│   ├── customizations/                   # Modular customization skills
│   │   ├── customizations.md             # Main orchestrator
│   │   ├── location.md                   # Map region customization
│   │   ├── vehicles.md                   # Routing profiles
│   │   ├── industries.md                 # Industry categories
│   │   ├── streamlits.md                 # Streamlit app updates
│   │   ├── aisql-notebook.md             # AISQL notebook updates
│   │   └── carto-notebook.md             # Carto notebook updates
│   ├── deploy-demo/                      # Demo deployment skill
│   │   └── deploy-demo.md
│   └── uninstall-route-optimizer/        # Cleanup skill
│       └── uninstall-route-optimizer.md
└── README.md
```
