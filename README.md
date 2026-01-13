# Create a Route Optimisation and Vehicle Route Plan Simulator

## Overview

This project deploys OpenRouteService as a Snowflake Native App with Snowpark Container Services (SPCS). It provides route optimization, directions, and isochrone calculations for configurable geographic regions.

## Step-By-Step Guide

### 1. Deploy App
- Go to the working directory of the project
- In Cortex Code CLI type: `use the local skill from skills/deploy-route-optimizer`
- After deployment, the link to the app will be provided. For first time use, you must launch the application in the UI
- The default map installed is for San Francisco

### 2. (Optional) Select a Custom Map
- After the app is deployed, you can select a custom map
- Type in Cortex Code CLI: `use the local skill from skills/ors-map-customization`
- Follow the prompts to select your region (e.g., Great Britain, Germany, France, etc.)
- It is recommended to use the smallest map possible for your use case; larger maps require more compute power

### 3. (Optional) Deploy Demo Notebook and Streamlit
- Prerequisite: Custom map installed (e.g., New York)
- Type in Cortex Code CLI: `use the local skill from skills/deploy-demo`

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
| 6 | Create Git feature branch for customizations |
| 7 | Customize Function Tester with region-specific coordinates |
| 8 | Deploy updated Streamlit app |
| 9 | Commit all changes to feature branch |

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
