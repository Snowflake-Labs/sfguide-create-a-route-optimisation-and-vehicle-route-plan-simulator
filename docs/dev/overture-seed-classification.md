# Overture seed classification (roadmap note)

> **SUPERSEDED by [`data-studio-universal-generation.md`](data-studio-universal-generation.md).**
> This note concluded "do not attempt a broad migration" because demographics, hazard,
> and business data "have no Overture analog". That conclusion has been **reversed**: free
> Snowflake Marketplace datasets (Census demographics, FEMA hazard/disasters) fill those
> gaps, and the new direction makes **Data Studio the single generator for all data**
> (the first Data Studio run becomes the install seed). The classification table below is
> retained as the historical starting skeleton, but the live verdicts now live in the
> superseding doc.

When asking "can we replace static seed X with Overture Maps data?", use this
classification. The short answer: **Overture is reference map data** (where things
are — places, addresses, roads, buildings, admin boundaries). It does **not**
contain demographics, time-series telemetry, external risk indices, or
business/commercial data. So only *location* seeds are Overture-replaceable; the
rest are either generated *from* Overture already or have no Overture analog.

Overture themes available in this repo (imported by `analytic_layer.sql`):
`OVERTURE_MAPS__PLACES`, `__ADDRESSES`, `__TRANSPORTATION`, `__BUILDINGS`,
`__DIVISIONS`, `__BASE`.

## Classification

| Static seed | Content type | Overture-replaceable? | Theme / note |
|---|---|---|---|
| `DEMO_DELIVERY_STOPS`, `DEMO_KEY_SITES` (pharmacies) | POIs | **Done** | Replaced by live `CATCHMENT.POIS` (Places). See below. |
| `DEMO_DEPOT` | depot point | **Done** | Computed as POI centroid; no seed. |
| `DEMO_AREA_DEMOGRAPHICS` (population, morbidity %, income) | demographics | **No** | Overture has no demographics. Proxied by POI/address density (catchment) or a Marketplace demographics dataset. |
| `DEMO_DEMAND_CATALOG` (drug catalog) | business catalog | **No** | Pure demo content; replaced by neutral category-derived handling tiers. |
| `careconnect_centers_geocoded.csv` (PACE centers) | POIs | **Yes (not done)** | Could come from Places (health/social_facility); curated named anchors are intentional for the emergency-response demo. |
| emergency participant addresses | addresses | **Already Overture** | The emergency-response skill samples Overture Addresses within isochrones today. |
| FEMA NRI ZIP/county risk | external risk index | **No** | FEMA external dataset. |
| `region_catalog` boundaries | admin polygons | **Partial (not done)** | Provisioning still needs Geofabrik PBF; `OVERTURE_MAPS__DIVISIONS` could back boundary *display*. |
| `synthetic_ebikes/*` (`fact_trips`, telemetry, fleet, schedule) | movement / time-series | **No** | Generated *from* Overture + ORS; not reference data. |
| `dim_pois` (synthetic POIs) | POIs | **Already Overture-derived** | Data Studio builds these from Overture. |
| freight offers / partners / rates / offer_routes | business marketplace | **No** | Synthetic commercial data, no Overture analog. |

## What was done (dynamic demo tools)

`TOOL_CATCHMENT`, `TOOL_DELIVERY_OPTIMIZATION`, and `TOOL_NETWORK_OPTIMIZATION`
(`.cortex/skills/routing-agent/references/deploy-agent.sql`) were rewritten to read
live, region-scoped, domain-neutral data instead of the static SF pharma `DEMO_*`
tables:

- **Active region** from `FLEET_INTELLIGENCE.CATCHMENT.CONFIG` (default
  `SanFrancisco`); **depot** = `AVG(LONGITUDE/LATITUDE)` centroid of the region's
  POIs.
- **Stops/sites** from `FLEET_INTELLIGENCE.CATCHMENT.POIS` (Overture Places),
  constrained to the region `BOUNDARY` polygon and pre-filtered to
  road-network-routable points via `MATRIX` `snapped_distance <= 350m`.
  - `BOUNDARY` removes out-of-graph points that make `MATRIX` error all-or-nothing
    (code 6010, "out of bounds").
  - `snapped_distance` removes in-boundary unsnappable points that abort the VROOM
    solve (the documented code-3 / silent-0-rows failure).
- **Handling tier** hashed neutrally from `BASIC_CATEGORY` (`Tier 1/2/3`). No
  healthcare columns, drug names, or cold-chain labels.
- **Catchment** profiles POIs + address density within the isochrone (a neutral
  activity/coverage signal, no demographics).

No static demo seed is required; the tools work for any provisioned region with
Overture coverage. The legacy static seed
(`setup-agent-playground/references/deploy-demo-data.sql`) is deprecated/optional.

## Recommendation

Do **not** attempt a broad "Overture-ify everything" migration: most heavy seeds are
behavioral/business/demographic and have no Overture analog, and the synthetic fleet
data is already generated from Overture. The remaining optional candidates (PACE
centers via Places, boundary display via Divisions) are low marginal value.
