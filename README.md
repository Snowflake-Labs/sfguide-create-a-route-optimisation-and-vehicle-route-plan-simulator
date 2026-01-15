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
│   OPTIONAL: CUSTOMIZE MAP                                        │
│   skills/ors-map-customization                                   │
│                                                                  │
│  1. Download OSM map (Geofabrik)                                │
│  2. Configure routing profiles                                   │
│  3. Update service configuration                                 │
│  4. Resume services with new map                                 │
│  5. Customize Function Tester (region coordinates)              │
│  6. Customize AISQL Notebook (city-specific prompts)            │
│  7. Customize Add Carto Data (region geohash)                   │
│  8. Create Git feature branch                                    │
│  9. Deploy updated Streamlit                                     │
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
# The skill asks yes/no for each: location, vehicles, industries
use the local skill from skills/ors-map-customization

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
- **Status:** Currently in Private Preview
- **Installation:** TBA (To Be Announced)
- Cortex Code is Snowflake's AI-powered CLI that enables natural language interactions with your codebase and Snowflake resources
- Contact your Snowflake account team for access during Private Preview

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

### 6. Git
- **Required for:** Version control and managing region-specific configurations via branches
- **Installation:**
  - macOS: `brew install git` or [Download](https://git-scm.com/download/mac)
  - Windows: [Git for Windows](https://git-scm.com/download/win)
  - Linux: `sudo apt install git` or `sudo yum install git`
- Verify installation: `git --version`

### 7. GitHub CLI (Optional)
- **Required for:** Forking repositories and managing GitHub operations from the command line
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
- Type in Cortex Code CLI: `use the local skill from skills/ors-map-customization`
- The skill asks three yes/no questions:
  - **Location?** - Change map region (e.g., San Francisco → Paris)
  - **Vehicles?** - Modify routing profiles (add walking, wheelchair, etc.)
  - **Industries?** - Change industry categories (Food → Beverages, etc.)
- Only the steps for your chosen customizations will run
- If you only change industries, no map download or app redeployment is needed

### 3. (Optional) Deploy Demo Notebook and Streamlit
- **Run AFTER customize-map to use your chosen region** (otherwise defaults to San Francisco)
- Type in Cortex Code CLI: `use the local skill from skills/deploy-demo`
- This deploys the customized notebooks and Streamlit apps to Snowflake

## Customization Skill

The `ors-map-customization` skill provides a flexible workflow to customize your deployment. It starts by asking **three yes/no questions** to determine what to customize:

### Decision Tree

| Question | If YES | If NO |
|----------|--------|-------|
| **Customize LOCATION?** | Downloads new map, uploads to stage, rebuilds graphs | Skips map download entirely |
| **Customize VEHICLES?** | Modifies routing profiles, rebuilds graphs | Keeps default profiles |
| **Customize INDUSTRIES?** | Modifies industry categories in notebooks | Keeps default industries |

### What Gets Updated

| Your Choices | Actions Taken |
|--------------|---------------|
| Location = YES | Steps 1-5 (download map, upload, rebuild graphs) |
| Vehicles = YES | Steps 3-5 (modify profiles, rebuild graphs) |
| Industries = YES | Step 8b (modify notebooks) |
| Location OR Vehicles = YES | Steps 6, 10 (update Function Tester, redeploy app) |
| Industries ONLY | Only demo content updated - no app redeployment needed |

### Workflow Steps

| Step | Description | When Run |
|------|-------------|----------|
| 0 | Ask yes/no questions to determine scope | Always |
| 1 | Setup notebook for map downloads | Location = YES |
| 2 | Download OSM map data for target region | Location = YES |
| 3 | Update `ors-config.yml` with map file and routing profiles | Location OR Vehicles = YES |
| 4 | Update `openrouteservice.yaml` with region volume paths | Location OR Vehicles = YES |
| 5 | Resume all ORS services | Location OR Vehicles = YES |
| 6 | Customize Function Tester with region-specific coordinates | Location OR Vehicles = YES |
| 7 | Customize AISQL Notebook with city-specific AI prompts | Any = YES |
| 8 | Customize Add Carto Data notebook with region geohash | Any = YES |
| 8b | Customize industry categories | Industries = YES |
| 9 | Create Git feature branch and commit all customizations | Any = YES |
| 10 | Deploy updated Streamlit app | Location OR Vehicles = YES |
| 11 | Chain to deploy-demo | Any = YES |

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

## Git Branching Strategy

This project uses a branching strategy to manage multiple map configurations while preserving the original San Francisco setup.

### Branch Structure

```
main                           <- Original San Francisco configuration
├── feature/ors-great-britain  <- Great Britain customizations
├── feature/ors-germany        <- Germany customizations
└── feature/ors-<region>       <- Other region customizations
```

### How It Works

1. **`main` branch** always contains the original San Francisco configuration
2. When you run the map customization skill, it creates a **feature branch** (e.g., `feature/ors-great-britain`)
3. All configuration changes are committed to the feature branch:
   - `Native_app/provider_setup/staged_files/ors-config.yml` - Map file and routing profiles
   - `Native_app/services/openrouteservice/openrouteservice.yaml` - Volume paths for map data
   - `Native_app/code_artifacts/streamlit/pages/function_tester.py` - Region-specific coordinates

### Switching Between Regions

To switch to a different map configuration:

```bash
# Switch to San Francisco (original)
git checkout main

# Switch to Great Britain
git checkout feature/ors-great-britain

# Switch to another region
git checkout feature/ors-<region-name>
```

**Note:** After switching branches, you'll need to:
1. Upload the config files to Snowflake stages
2. Update the ORS service specification
3. Upgrade the Native App

Or simply run the map customization skill again for the desired region.

### Creating a New Region Configuration

1. Start from the `main` branch: `git checkout main`
2. Run: `use the local skill from skills/ors-map-customization`
3. Select your desired region
4. The skill will automatically:
   - Create a new feature branch
   - Download the map (if needed)
   - Update all configuration files
   - Customize the Function Tester with local coordinates
   - Commit changes to the feature branch

## Available Skills

| Skill | Description | Command |
|-------|-------------|---------|
| `check-prerequisites` | Check and install required dependencies | `use the local skill from skills/check-prerequisites` |
| `deploy-route-optimizer` | Deploy the ORS Native App | `use the local skill from skills/deploy-route-optimizer` |
| `ors-map-customization` | Change map region and customize app | `use the local skill from skills/ors-map-customization` |
| `deploy-demo` | Deploy demo notebook and streamlit | `use the local skill from skills/deploy-demo` |
| `customize-function-tester` | Update Function Tester coordinates | `use the local skill from skills/customize-function-tester` |
| `uninstall-route-optimizer` | Remove app and clean up resources | `use the local skill from skills/uninstall-route-optimizer` |

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
├── skills/
│   ├── deploy-route-optimizer/           # Deployment skill
│   ├── ors-map-customization/            # Map customization skill
│   └── deploy-demo/                      # Demo deployment skill
└── README.md
```
