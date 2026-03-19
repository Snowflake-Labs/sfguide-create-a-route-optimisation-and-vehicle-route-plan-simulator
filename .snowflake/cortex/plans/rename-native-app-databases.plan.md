# Plan: Rename Native App Databases

## Objective

Rename three databases used by the `fleet-intelligence-food-delivery` skill:

| Old Name | New Name |
|----------|----------|
| `FLEET_INTELLIGENCE_PKG` | `OPENROUTESERVICE_PKG` |
| `FLEET_INTELLIGENCE_APP` | `OPENROUTESERVICE_APP` |
| `FLEET_INTELLIGENCE_SETUP` | `OPENROUTESERVICE_SETUP` |

---

## Files to Modify

### 1. [`.cortex/skills/fleet-intelligence-food-delivery/SKILL.md`](.cortex/skills/fleet-intelligence-food-delivery/SKILL.md)

Lines 233-238 in the Cleanup section:
- `FLEET_INTELLIGENCE_APP` -> `OPENROUTESERVICE_APP` (line 233)
- `FLEET_INTELLIGENCE_PKG` -> `OPENROUTESERVICE_PKG` (line 234)
- `FLEET_INTELLIGENCE_SETUP` -> `OPENROUTESERVICE_SETUP` (lines 237-238)

### 2. [`.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md`](.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md)

This is the main file with ~51 occurrences:
- `FLEET_INTELLIGENCE_PKG` -> `OPENROUTESERVICE_PKG` (22 occurrences)
- `FLEET_INTELLIGENCE_APP` -> `OPENROUTESERVICE_APP` (25 occurrences)
- `FLEET_INTELLIGENCE_SETUP` -> `OPENROUTESERVICE_SETUP` (4 occurrences)

### 3. [`.cortex/skills/fleet-intelligence-food-delivery/references/travel-time-integration.md`](.cortex/skills/fleet-intelligence-food-delivery/references/travel-time-integration.md)

Line 272:
- `FLEET_INTELLIGENCE_APP.DATA.MATRIX_PROGRESS()` -> `OPENROUTESERVICE_APP.DATA.MATRIX_PROGRESS()`

### 4. [`.cortex/skills/fleet-intelligence-food-delivery/assets/react-app/server/index.ts`](.cortex/skills/fleet-intelligence-food-delivery/assets/react-app/server/index.ts)

Line 25:
- `'FLEET_INTELLIGENCE_APP'` -> `'OPENROUTESERVICE_APP'`

### 5. [`.cortex/skills/fleet-intelligence-food-delivery/assets/react-app/native-app/setup_script.sql`](.cortex/skills/fleet-intelligence-food-delivery/assets/react-app/native-app/setup_script.sql)

Lines 1733-1775 (all commented out, but should still be updated for consistency):
- `FLEET_INTELLIGENCE_APP` -> `OPENROUTESERVICE_APP` (13 occurrences)

### 6. [`.cortex/skills/fleet-intelligence-food-delivery/assets/react-app/native-app/services/fleet_intelligence_service.yaml`](.cortex/skills/fleet-intelligence-food-delivery/assets/react-app/native-app/services/fleet_intelligence_service.yaml)

Line 3 (image path):
- `/fleet_intelligence_setup/public/fleet_intel_repo/` -> `/openrouteservice_setup/public/fleet_intel_repo/`

### 7. [`.cortex/skills/fleet-intelligence-food-delivery/assets/react-app/native-app/manifest.yml`](.cortex/skills/fleet-intelligence-food-delivery/assets/react-app/native-app/manifest.yml)

Line 7 (image path):
- `/fleet_intelligence_setup/public/fleet_intel_repo/` -> `/openrouteservice_setup/public/fleet_intel_repo/`

---

## Files NOT Modified (acceptable)

- **`archive/...`** -- Archived files, no changes needed
- **Plan files** (`.snowflake/cortex/plans/`) -- Auto-generated, will be superseded

---

## Approach

Use `replace_all` edits for each of the three renames in each file. This is a straightforward find-and-replace with no logic changes.
