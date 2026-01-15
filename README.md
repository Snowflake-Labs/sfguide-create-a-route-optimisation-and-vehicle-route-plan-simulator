# Create a Route Optimisation and Vehicle Route Plan Simulator

## Overview

This project deploys OpenRouteService as a Snowflake Native App with Snowpark Container Services (SPCS). It provides route optimization, directions, and isochrone calculations for configurable geographic regions.

## Installation Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         INSTALLATION FLOW                                    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐
│  PREREQUISITES  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  1. Install VS Code, Cortex Code CLI, Docker/Podman, Snowflake CLI, Git    │
│  2. Configure Snowflake connection: snow connection add                      │
│  3. Ensure ACCOUNTADMIN access and SPCS enabled                              │
└────────┬────────────────────────────────────────────────────────────────────┘
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
```

### Quick Start Commands

```bash
# Step 1: Deploy the Route Optimizer Native App
use the local skill from skills/deploy-route-optimizer

# Step 2 (Optional): Customize the map region
# ⚠️ Run this BEFORE deploy-demo if you want a custom region
use the local skill from skills/ors-map-customization

# Step 3 (Optional): Deploy demo notebooks and Streamlit
# ⚠️ Run AFTER customize-map to use your chosen region (otherwise defaults to San Francisco)
use the local skill from skills/deploy-demo
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

### 1. Deploy App
- Go to the working directory of the project
- In Cortex Code CLI type: `use the local skill from skills/deploy-route-optimizer`
- After deployment, the link to the app will be provided. For first time use, you must launch the application in the UI
- The default map installed is for San Francisco

### 2. (Optional) Select a Custom Map
- **Run this BEFORE deploy-demo if you want a custom region**
- After the app is deployed, you can select a custom map
- Type in Cortex Code CLI: `use the local skill from skills/ors-map-customization`
- Follow the prompts to select your region (e.g., Great Britain, Germany, France, etc.)
- It is recommended to use the smallest map possible for your use case; larger maps require more compute power
- This skill customizes all notebooks and Streamlit apps with your chosen location

### 3. (Optional) Deploy Demo Notebook and Streamlit
- **Run AFTER customize-map to use your chosen region** (otherwise defaults to San Francisco)
- Type in Cortex Code CLI: `use the local skill from skills/deploy-demo`
- This deploys the customized notebooks and Streamlit apps to Snowflake

## Map Customization Skill

The `ors-map-customization` skill provides a complete workflow to:

1. **Download map data** from OpenStreetMap (Geofabrik)
2. **Configure routing profiles** (driving-car, driving-hgv, cycling-road, etc.)
3. **Update service configuration** to use the new map region
4. **Customize the Function Tester** Streamlit app with region-specific locations
5. **Manage changes via Git branches** to preserve the original configuration

### Workflow Steps

| Step | Description |
|------|-------------|
| 1 | Setup notebook for map downloads |
| 2 | Download OSM map data for target region |
| 3 | Update `ors-config.yml` with map file and routing profiles |
| 4 | Update `openrouteservice.yaml` with region volume paths |
| 5 | Resume all ORS services |
| 6 | Customize Function Tester with region-specific coordinates |
| 7 | Customize AISQL Notebook with city-specific AI prompts |
| 8 | Customize Add Carto Data notebook with region geohash |
| 9 | Create Git feature branch and commit all customizations |
| 10 | Deploy updated Streamlit app |

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
| `deploy-route-optimizer` | Deploy the ORS Native App | `use the local skill from skills/deploy-route-optimizer` |
| `ors-map-customization` | Change map region and customize app | `use the local skill from skills/ors-map-customization` |
| `deploy-demo` | Deploy demo notebook and streamlit | `use the local skill from skills/deploy-demo` |

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
