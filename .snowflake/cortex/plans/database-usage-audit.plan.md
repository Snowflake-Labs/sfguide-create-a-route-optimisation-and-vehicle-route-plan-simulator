# Database Usage Audit

## Objective
Verify that **no skills store data** (tables, views, dynamic tables, stages with user data) in databases other than `SYNTHETIC_DATASETS` and `FLEET_INTELLIGENCE`.

---

## Audit Results

### Compliant: Data Storage Databases

| Database | Usage | Skills |
|----------|-------|--------|
| `FLEET_INTELLIGENCE` | Primary analytics DB with 9 schemas | route-optimization, fleet-intelligence-taxis, fleet-intelligence-food-delivery, retail-catchment, route-deviation, dwell-analysis, travel-time-matrix, routing-agent, synthetic-datasets-generator |
| `SYNTHETIC_DATASETS` | Source telemetry data | synthetic-datasets-generator, route-deviation (read), dwell-analysis (read) |

These two are used correctly across all skills. No issues.

---

### No Action Required: Read-Only / External Databases

These databases are **not created by skills for data storage** -- they are external dependencies:

| Database | Type | Usage |
|----------|------|-------|
| `OVERTURE_MAPS__PLACES` | Marketplace shared DB | Read-only POI data. Created via `CREATE DATABASE FROM LISTING`. Used by 4 skills. |
| `OVERTURE_MAPS__ADDRESSES` | Marketplace shared DB | Read-only address data. Created via `CREATE DATABASE FROM LISTING`. Used by 3 skills. |
| `OPENROUTESERVICE_NATIVE_APP` | Installed native app | Function calls only (`CORE.DIRECTIONS`, `CORE.ISOCHRONES`, etc.). No data stored. |

**Verdict:** These are external dependencies (Marketplace data, native app functions). They don't store skill-generated data. No changes needed.

---

### Flagged: Databases Outside the Two Allowed

#### 1. `OPENROUTESERVICE_SETUP` -- build-routing-solution

- **File:** [`.cortex/skills/build-routing-solution/SKILL.md`](.cortex/skills/build-routing-solution/SKILL.md)
- **Objects:** Stages (`ORS_SPCS_STAGE`, `ORS_GRAPHS_SPCS_STAGE`, `ORS_ELEVATION_CACHE_SPCS_STAGE`), Image Repository (`IMAGE_REPOSITORY`)
- **Purpose:** ORS native app build infrastructure (Docker images, graph data, elevation cache)
- **Assessment:** This is **deployment infrastructure**, not data storage. The stages hold Docker images and OSM graph files for SPCS. These are build artifacts, not analytical data.
- **Recommendation:** **Acceptable as-is.** This database is purpose-built for ORS deployment and is separate from data pipelines. It is listed in the cleanup section of the skill.

#### 2. `FLEET_INTELLIGENCE_SETUP` -- fleet-intelligence-food-delivery

- **File:** [`.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md`](.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md) (line 42-51)
- **Objects:** Image Repository (`FLEET_INTEL_REPO`), Stage
- **Purpose:** Docker image staging for the React native app deployed to SPCS
- **Assessment:** **Deployment infrastructure**, similar to OPENROUTESERVICE_SETUP. Holds Docker images, not analytical data.
- **Recommendation:** **Acceptable as-is** if we treat deployment infra as separate from data storage. Alternatively, this image repo could be moved into `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY` schema to consolidate.

#### 3. `FLEET_INTELLIGENCE_PKG` -- fleet-intelligence-food-delivery

- **File:** [`.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md`](.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md) (line 79-137)
- **Objects:** Application package with `stage_content` schema
- **Purpose:** Snowflake Application Package for the native app
- **Assessment:** **Application package** -- this is a Snowflake native construct required for native app distribution. It cannot be placed inside another database.
- **Recommendation:** **Acceptable as-is.** Application packages are a special Snowflake object type with their own namespace requirements.

#### 4. `FLEET_INTELLIGENCE_APP` -- fleet-intelligence-food-delivery

- **File:** [`.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md`](.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md) (line 136-259)
- **Objects:** Installed native app with services, functions
- **Assessment:** **Installed application** -- created by `CREATE APPLICATION` from the package. This is the running app instance.
- **Recommendation:** **Acceptable as-is.** Installed apps are separate database objects by design.

#### 5. `OPEN_ROUTE_SERVICE_SAN_FRANCISCO` -- retail-catchment (legacy)

- **File:** [`.cortex/skills/retail-catchment/assets/streamlit/retail_catchment.py`](.cortex/skills/retail-catchment/assets/streamlit/retail_catchment.py) (line 72)
- **Context:** Listed as a fallback app name: `['OPEN_ROUTE_SERVICE_SAN_FRANCISCO', 'OPENROUTESERVICE_NATIVE_APP']`
- **Assessment:** **Legacy reference** to an old ORS app name. Not a data storage database.
- **Recommendation:** **Remove the legacy name.** This fallback is outdated and should only reference `OPENROUTESERVICE_NATIVE_APP`.

---

## Summary of Findings

| Database | Category | Stores Data? | Action |
|----------|----------|-------------|--------|
| `FLEET_INTELLIGENCE` | Allowed | Yes | None |
| `SYNTHETIC_DATASETS` | Allowed | Yes | None |
| `OVERTURE_MAPS__PLACES` | Marketplace (read-only) | No (external) | None |
| `OVERTURE_MAPS__ADDRESSES` | Marketplace (read-only) | No (external) | None |
| `OPENROUTESERVICE_NATIVE_APP` | Native app (functions) | No | None |
| `OPENROUTESERVICE_SETUP` | Deployment infra | Build artifacts only | Acceptable (infra) |
| `FLEET_INTELLIGENCE_SETUP` | Deployment infra | Docker images only | Acceptable (infra) or consolidate into FLEET_INTELLIGENCE |
| `FLEET_INTELLIGENCE_PKG` | App package | App code only | Acceptable (Snowflake requirement) |
| `FLEET_INTELLIGENCE_APP` | Installed app | App runtime | Acceptable (Snowflake requirement) |
| `OPEN_ROUTE_SERVICE_SAN_FRANCISCO` | Legacy reference | No | **Remove legacy fallback** |

**Conclusion:** No skills store analytical/business data outside `SYNTHETIC_DATASETS` or `FLEET_INTELLIGENCE`. The other databases fall into three categories:
1. **Read-only external sources** (Marketplace, ORS native app) -- no concern
2. **Deployment infrastructure** (OPENROUTESERVICE_SETUP, FLEET_INTELLIGENCE_SETUP) -- Docker images and build artifacts, not data
3. **Native app constructs** (FLEET_INTELLIGENCE_PKG, FLEET_INTELLIGENCE_APP) -- required by Snowflake's app framework

The only actionable item is removing the legacy `OPEN_ROUTE_SERVICE_SAN_FRANCISCO` fallback from the retail-catchment Streamlit app.

## Implementation

### Task 1: Remove legacy ORS app name from retail-catchment

In [`.cortex/skills/retail-catchment/assets/streamlit/retail_catchment.py`](.cortex/skills/retail-catchment/assets/streamlit/retail_catchment.py) line 72, change:
```python
['OPEN_ROUTE_SERVICE_SAN_FRANCISCO', 'OPENROUTESERVICE_NATIVE_APP']
```
to:
```python
['OPENROUTESERVICE_NATIVE_APP']
```

### Task 2 (Optional): Consolidate FLEET_INTELLIGENCE_SETUP

If strict consolidation is desired, the image repository in `FLEET_INTELLIGENCE_SETUP.PUBLIC.FLEET_INTEL_REPO` could be moved to `FLEET_INTELLIGENCE.FLEET_INTELLIGENCE_FOOD_DELIVERY.FLEET_INTEL_REPO`. This would require updating:
- [`.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md`](.cortex/skills/fleet-intelligence-food-delivery/references/native-app-deployment.md) (lines 42-51)
- [`.cortex/skills/fleet-intelligence-food-delivery/SKILL.md`](.cortex/skills/fleet-intelligence-food-delivery/SKILL.md) cleanup section
