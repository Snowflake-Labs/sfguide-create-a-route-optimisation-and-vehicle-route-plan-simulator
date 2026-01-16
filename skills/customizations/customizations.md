---
name: customizations
description: "Route customization requests to the correct skill. Use when: changing location, changing map, changing vehicle, changing industry, customizing deployment. Triggers: change location, change map, change vehicle, customize, change industry."
---

# Customization Router

This skill routes customization requests to the correct lab skill based on what you want to customize.

## Quick Reference

| What You Want to Change | Correct Skill | What It Does |
|------------------------|---------------|--------------|
| **Map/Location** | `oss-install-openrouteservice-native-app/skills/customizations/location` | Downloads new map, rebuilds routing graphs |
| **Vehicle Profiles** | `oss-install-openrouteservice-native-app/skills/customizations/vehicles` | Changes routing profiles (car, truck, bicycle, etc.), rebuilds graphs |
| **Industry Categories** | `oss-deploy-route-optimization-demo/skills/customizations/industries` | Updates product types, customer types for demo |
| **Streamlit Apps** | `oss-deploy-route-optimization-demo/skills/customizations/streamlits` | Updates sample coordinates in apps (run AFTER location change) |

## Workflow

### Step 1: Determine What to Customize

**Ask the user:**

"What would you like to customize?"

1. **Location/Map** - Change the geographic region (e.g., San Francisco → Paris)
2. **Vehicle Profiles** - Enable/disable routing profiles (car, truck, bicycle, walking)
3. **Industries** - Change demo industry categories (Food, Healthcare, Cosmetics)
4. **Streamlit coordinates only** - Just update sample addresses (no map change)

### Step 2: Route to Correct Skill

**If user wants to change LOCATION or MAP:**

> This requires downloading a new map and rebuilding the routing graphs. This is handled by the OpenRouteService installation lab.

Run this skill:
```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/location
```

After the location skill completes, also run:
```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/vehicles
```

Then update the Streamlit apps:
```
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/streamlits
```

---

**If user wants to change VEHICLE PROFILES:**

> This updates which routing profiles are available and rebuilds the graphs.

Run this skill:
```
use the local skill from oss-install-openrouteservice-native-app/skills/customizations/vehicles
```

Then update the Streamlit apps to reflect new profiles:
```
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/streamlits
```

---

**If user wants to change INDUSTRIES:**

> This only affects the demo simulator categories, not the routing engine.

Run this skill:
```
use the local skill from oss-deploy-route-optimization-demo/skills/customizations/industries
```

---

**If user wants to update STREAMLIT coordinates only:**

> This updates sample addresses in the apps without changing the map.

Run this skill:
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
