---
name: ors-customizations
description: "Customize OpenRouteService map region or vehicle profiles. Use when: changing location, changing map, adding vehicles, removing profiles. Triggers: change location, change map, change vehicle, customize ors."
---

# OpenRouteService Customizations

Main entry point for customizing your OpenRouteService Native App. This skill handles map region changes and vehicle profile configuration.

> **_IMPORTANT:_** These skills download maps and rebuild routing graphs. After running these, you should also update the Streamlit apps using the demo customization skills.

## Customization Options

| Component | Skill | Description |
|-----------|-------|-------------|
| **Location** | `location.md` | Download new map, update config, rebuild routing graphs |
| **Vehicle Types** | `vehicles.md` | Enable/disable routing profiles, rebuild graphs |

## What Happens When You Change Location or Vehicles

### Location Change
1. **Download Map** - Downloads OSM data from Geofabrik for your region
2. **Update Config** - Modifies `ors-config.yml` to point to new map
3. **Update Service Spec** - Reconfigures the ORS service for new region
4. **Rebuild Graphs** - Restarts services to build routing graphs (can take 30+ minutes for large maps)

### Vehicle Change
1. **Update Config** - Modifies `ors-config.yml` to enable/disable profiles
2. **Rebuild Graphs** - Restarts ORS service to build graphs for new profiles

## Workflow

### Step 1: Determine What to Customize

**Ask the user:**

1. **"Do you want to change the MAP REGION (location)?"**
   - Examples: San Francisco → Paris, London, New York, etc.
   - If YES → Run `location.md`

2. **"Do you want to change VEHICLE PROFILES?"**
   - Examples: Add walking, wheelchair; remove HGV
   - If YES → Run `vehicles.md`

### Step 2: Execute ORS Skills

**If Location = YES:**
```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/location
```

**If Vehicles = YES (or Location = YES):**
```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/vehicles
```

> **_NOTE:_** When changing location, you should also review vehicle profiles since you may want different profiles for different regions.

### Step 3: Update Demo Components

After the ORS changes are complete, inform the user they should update the demo components:

```
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/streamlits
```

This updates:
- **Function Tester** - New sample addresses for the region
- **Simulator** - New default location for searches

### Step 4: Redeploy

After all customizations:

1. **Redeploy Native App** (for Function Tester updates):
   ```
   use the local skill from oss-install-openrouteservice-native-app/skills/deploy-route-optimizer
   ```

2. **Redeploy Demo** (for Simulator and notebook updates):
   ```
   use the local skill from oss-deploy-route-optimization-demo/skills/deploy-demo
   ```

## Running Individual Skills

```bash
# Change map region (downloads map, rebuilds graphs)
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/location

# Change vehicle profiles (rebuilds graphs)
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/vehicles
```

## Graph Build Times

| Map Size | Profiles | Approximate Build Time |
|----------|----------|------------------------|
| City (< 100MB) | 2-3 | 5-15 minutes |
| State (100MB - 1GB) | 2-3 | 30-60 minutes |
| Country (1GB - 5GB) | 2-3 | 1-3 hours |
| Large country (5GB+) | 2-3 | 3-8 hours |

> **_TIP:_** More profiles = longer build time. Start with just the profiles you need.

## Output

OpenRouteService configured with new map region and/or vehicle profiles. Routing graphs rebuilding.
