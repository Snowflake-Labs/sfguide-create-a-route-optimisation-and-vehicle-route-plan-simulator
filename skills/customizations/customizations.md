---
name: customizations
description: "Route customization requests to the correct skill. Use when: changing location, changing map, changing vehicle, changing industry, customizing deployment. Triggers: change location, change map, change vehicle, customize, change industry."
---

# Customization Router

This skill routes customization requests to the correct lab skill based on what you want to customize.

## Quick Reference

| What You Want to Change | Correct Skill | What It Does |
|------------------------|---------------|--------------|
| **Map/Location** | `oss-install-openrouteservice-native-app/skills/customizations/location` | Downloads new map, updates Function Tester, upgrades Native App, rebuilds graphs |
| **Vehicle Profiles** | `oss-install-openrouteservice-native-app/skills/customizations/vehicles` | Changes routing profiles, updates Function Tester, rebuilds graphs |
| **Industry Categories** | `oss-deploy-route-optimization-demo/skills/customizations/industries` | Updates product types, customer types for demo |
| **Demo Streamlit (Simulator)** | `oss-deploy-route-optimization-demo/skills/customizations/streamlits` | Updates Simulator coordinates (only if demo installed) |

> **_NOTE:_** The **Function Tester** is part of the Native App and is automatically updated when you change location or vehicles. The **Simulator** is part of the demo and only needs updating if the demo is installed.

## Workflow

### Step 1: Determine What to Customize

**Ask the user:**

"What would you like to customize?"

1. **Location/Map** - Change the geographic region (e.g., San Francisco → Paris)
2. **Vehicle Profiles** - Enable/disable routing profiles (car, truck, bicycle, walking)
3. **Industries** - Change demo industry categories (Food, Healthcare, Cosmetics)
4. **Streamlit coordinates only** - Just update sample addresses (no map change)

### Step 2: Check if Demo is Installed

Before updating demo components, check if the demo database exists:

```sql
SHOW DATABASES LIKE 'VEHICLE_ROUTING_SIMULATOR';
```

- **If the database EXISTS:** Demo is installed, you may update demo components after ORS changes
- **If the database does NOT exist:** Demo is NOT installed - **DO NOT attempt to update any demo files** (routing.py, notebooks, etc.). The demo will automatically use the correct configuration when it is deployed later.

### Step 3: Route to Correct Skill

**If user wants to change LOCATION or MAP:**

> This requires downloading a new map and rebuilding the routing graphs. This is handled by the OpenRouteService installation lab.

Run the location skill (this handles everything for the Native App):
```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/location
```

This skill will:
- Download the new map
- Update ors-config.yml
- Update service specifications
- Rebuild routing graphs
- Update Function Tester with new addresses
- Upgrade the Native App

> **_IMPORTANT:_** Do NOT attempt to update demo files (routing.py, notebooks, etc.) if the demo is not installed. When the demo IS deployed later, the `deploy-demo` skill will automatically read the current ORS configuration and apply the correct region settings.

---

**If user wants to change VEHICLE PROFILES:**

> This updates which routing profiles are available and rebuilds the graphs.

Run the vehicles skill:
```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/vehicles
```

This skill will:
- Update ors-config.yml with new profiles
- Rebuild routing graphs
- Update Function Tester with new profile options
- Upgrade the Native App

> **_IMPORTANT:_** Do NOT attempt to update demo files if the demo is not installed. The demo will pick up the correct profiles when deployed.

---

**If user wants to change INDUSTRIES:**

> This only affects the demo simulator categories, not the routing engine. Requires demo to be installed.

1. First verify demo is installed (check for `VEHICLE_ROUTING_SIMULATOR` database)
2. If installed, run:
```
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/industries
```

---

**If user wants to update STREAMLIT coordinates only:**

> This updates sample addresses in the apps without changing the map. Requires demo to be installed.

1. First verify demo is installed (check for `VEHICLE_ROUTING_SIMULATOR` database)
2. If installed, run:
```
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/streamlits
```

## Important Notes

> **_CRITICAL:_** If changing location or vehicles, you MUST use the ORS lab skills (`oss-install-openrouteservice-native-app/skills/customizations/`). These skills:
> - Download the actual map data
> - Update the ORS configuration
> - Rebuild the routing graphs
>
> The demo lab's `streamlits.md` skill ONLY updates the Streamlit app files - it does NOT download maps or rebuild graphs.

## Summary of Skill Locations

**OpenRouteService Lab** (`oss-install-openrouteservice-native-app/skills/`):
- `customizations/location.md` - Download maps, update config
- `customizations/vehicles.md` - Change routing profiles

**Demo Lab** (`oss-deploy-route-optimization-demo/skills/`):
- `customizations/industries.md` - Change demo industries
- `customizations/streamlits.md` - Update Streamlit coordinates
- `customizations/aisql-notebook.md` - Update AI prompts
- `customizations/carto-notebook.md` - Update POI data source
