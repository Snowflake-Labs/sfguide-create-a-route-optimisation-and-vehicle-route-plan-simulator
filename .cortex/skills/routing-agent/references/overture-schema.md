# Overture Maps Reference (Snowflake)

How this accelerator queries Overture Maps data, and the three agent-facing
surfaces that expose it. The querying is cost-safe by construction and tuned for
the fleet stack (region boundaries instead of bbox-only, audited synapse verbs
instead of free-form SQL).

## Marketplace shares

All Overture data comes from CARTO's Snowflake Marketplace shares (imported as
read-only databases). Acquired idempotently by `scripts/analytic_layer.sql`:

| Database | Table | Listing ID | Contents |
|---|---|---|---|
| `OVERTURE_MAPS__PLACES` | `CARTO.PLACE` | `GZT0Z4CM1E9KR` | ~66M global POIs (name, category, brand, address, geometry, confidence) |
| `OVERTURE_MAPS__ADDRESSES` | `CARTO.ADDRESS` | `GZT0Z4CM1E9NQ` | Street-level addresses (geometry, postcode, address levels) |

```sql
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9KR');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__PLACES FROM LISTING GZT0Z4CM1E9KR;
CALL SYSTEM$ACCEPT_LEGAL_TERMS('DATA_EXCHANGE_LISTING', 'GZT0Z4CM1E9NQ');
CREATE DATABASE IF NOT EXISTS OVERTURE_MAPS__ADDRESSES FROM LISTING GZT0Z4CM1E9NQ;
```

A third share, `OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT` (road network), is
used by the matrix/routability pipeline but is installed manually (no codified
`FROM LISTING`); it is out of scope for the Overture query verbs.

## PLACE column shapes

`PLACE` stores semi-structured VARIANT columns. The fields the verbs use:

| Column | Type | Access pattern | Notes |
|---|---|---|---|
| `ID` | VARCHAR | `p.ID` | Stable Overture feature id |
| `NAMES` | VARIANT | `p.NAMES:primary::STRING` | Primary display name |
| `TAXONOMY` | VARIANT | `p.TAXONOMY:primary::STRING` | Fine-grained primary category; `:hierarchy` and `:alternates` are arrays (replaces the removed `CATEGORIES` column) |
| `BASIC_CATEGORY` | VARCHAR | `p.BASIC_CATEGORY` | Flattened single category (preferred for filtering) |
| `GEOMETRY` | GEOGRAPHY | `ST_X(p.GEOMETRY)`, `ST_Y(p.GEOMETRY)` | Point; longitude = ST_X, latitude = ST_Y |
| `ADDRESSES` | VARIANT | `p.ADDRESSES[0]:locality::STRING` (city), `:region` (state), `:postcode`, `:freeform` (street) | First address element |
| `CONFIDENCE` | FLOAT | `p.CONFIDENCE` | 0..1 data-quality score; filter low values for trust |
| `BBOX` | VARIANT | `p.BBOX:xmin` etc. | Native bbox (points ~= the coordinate) |

`ADDRESS` (addresses share) columns the verbs use: `ID`, `GEOMETRY`,
`ADDRESS_LEVELS[1]:value::STRING` (city), `POSTCODE`, `COUNTRY`.

Common `BASIC_CATEGORY` values: `coffee_shop`, `restaurant`, `fast_food_restaurant`,
`grocery_store`, `supermarket`, `convenience_store`, `gas_station`, `pharmacy`,
`hospital`, `clothing_store`, `electronics_store`, `gym`, `bakery`, `bar`,
`hotel`, `bank`, `school`. Category matching uses equality on `BASIC_CATEGORY`
and `TAXONOMY:primary` plus a `LIKE '%cat%'` fallback, so partial names work.

## Cost-safe query discipline

Every Overture query MUST be bounded. The canonical pattern, used by both the
verbs and `analytic_layer.sql`:

1. **bbox prefilter** for partition pruning: `ST_X(geom) BETWEEN ? AND ? AND ST_Y(geom) BETWEEN ? AND ?`.
2. **authoritative polygon refine**: `ST_WITHIN(geom, boundary)` where `boundary`
   comes from `OPENROUTESERVICE_APP.CORE.REGION_CATALOG` (NULL-safe: degrades to
   bbox-only when no boundary). Prefer the real boundary polygon over bbox - a
   bbox over-includes ocean and neighbouring regions.
3. **hard LIMIT** (capped at 500 in the verbs) on returned rows/groups.

Resolve a region's boundary + bbox (smallest matching boundary wins):

```sql
SELECT ST_XMIN(BOUNDARY), ST_XMAX(BOUNDARY), ST_YMIN(BOUNDARY), ST_YMAX(BOUNDARY), BOUNDARY
FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
WHERE BOUNDARY IS NOT NULL
  AND (UPPER(LOOKUP_NAME) = UPPER(:region) OR UPPER(REGION_KEY) = UPPER(:region))
ORDER BY COALESCE(BOUNDARY_AREA_KM2, 1e15) ASC
LIMIT 1;
```

This stack already bakes a real boundary polygon for every provisioned region, so
we filter with the polygon and only use bbox as the cheap prefilter (or as a
fallback when no region is provisioned).

## Three agent-facing surfaces

| Surface | Object | Best for | Bounded by |
|---|---|---|---|
| **Deterministic verb** | `query_overture_places` -> `ROUTING_TOOLS.TOOL_OVERTURE_SEARCH` | region/bbox-bounded place search, counts, map-ready rows | region OR explicit bbox + hard LIMIT |
| **Deterministic verb** | `query_overture_addresses` -> `ROUTING_TOOLS.TOOL_OVERTURE_ADDRESSES` | address density/coverage | region OR explicit bbox + hard LIMIT |
| **Region SV (Analyst)** | `query_catchment` -> `FLEET_INTELLIGENCE.SEMANTIC.SV_CATCHMENT` | "how many / per-city" counts within the active fleet region (POIs + addresses) | active region (data pre-scoped by `analytic_layer.sql`) |
| **Global SV (Analyst)** | `query_overture_global` -> `FLEET_INTELLIGENCE.SEMANTIC.SV_OVERTURE_PLACES` | worldwide place filtering, counts and maps by category, brand, locality; resolve categories with `overture_category_search` | bbox_* filters + Analyst guidance |
| **Global SVs (Analyst)** | `query_overture_divisions`, `query_overture_address_catalog`, `query_overture_roads`, `query_overture_buildings` -> `SV_OVERTURE_DIVISIONS/ADDRESSES/TRANSPORTATION/BUILDINGS` | worldwide boundaries and reverse geocoding, addresses, road network composition, building footprints | addresses/roads/buildings REQUIRE a bbox (see install-fleet-apps SKILL.md, "Overture semantic layer") |

### Why we build the global SV instead of using the vendor's

The CARTO PLACES share ships a Cortex Analyst semantic view
(`OVERTUREMAPS_PLACES_SEMANTIC_VIEW`, extension `CA`) with derived dimensions
(`PRIMARY_CATEGORY`, `PRIMARY_NAME`, `BRAND_NAME`, `COUNTRY`, `REGION`, `LOCALITY`,
`POSTCODE`, `STREET`, `CONFIDENCE`) and synonyms. It no longer matches its own
table (checked live, October 23, 2026). The category dimensions error because
they read the removed `CATEGORIES` column. The address, phone, website and
socials dimensions return NULL for every row because they read a
`list[0].element` nesting the arrays no longer have. A share is read-only, so
the view cannot be fixed in place.

`prepare_overture.py` therefore builds `FLEET_INTELLIGENCE.SEMANTIC.SV_OVERTURE_PLACES`
for every Places source (imported share, existing copy, or S3 fallback) from
`install-fleet-apps/scripts/overture_semantic/places.sql`. It sits over a
normalized view `FLEET_INTELLIGENCE.OVERTURE.PLACE`, reads `TAXONOMY` for the
category, and has a `place_count` metric, so worldwide "how many" questions work.
Region-scoped counts still prefer `query_catchment` and the deterministic verbs.
The other four themes get the same treatment (`SV_OVERTURE_DIVISIONS`,
`SV_OVERTURE_ADDRESSES`, `SV_OVERTURE_TRANSPORTATION`, `SV_OVERTURE_BUILDINGS`).
The vendor YAML is now used only to recreate the vendor-named view on S3 copies.

It is still an *additive* convenience, not a contract dependency: if Places is
unavailable the view is not built, and `prune_agent_specs.py` removes the tool.
`FLEET_APP_USER` reads it through the schema-wide semantic view grants in
`role_binding.sql`; querying it needs no privilege on the share itself (verified).
The verbs run owner's-rights and do not depend on either grant.

## Rendering results on the inline chat map

In `list` mode, `TOOL_OVERTURE_SEARCH` and `TOOL_OVERTURE_ADDRESSES` also return a
`geometry` field holding a GeoJSON `FeatureCollection` of `Point` features
(`properties`: name/category/city for places, city/postcode for addresses). The SA
app's inline chat map (`RouteMapInline`) deep-scans tool output for GeoJSON, so the
places/addresses plot automatically once the verb is listed in `tools.mapTools`
(`app-config.json`). Aggregate modes (`city` / `category`) return `NULL` geometry -
correct for a counts answer (no map). Point markers expose name/category on hover.

## Where these objects are defined

- Procs `TOOL_OVERTURE_SEARCH` / `TOOL_OVERTURE_ADDRESSES`: `references/deploy-agent.sql`.
- Verbs `query_overture_places` / `query_overture_addresses`: `install-fleet-apps/fleet_tools/user/src/procs/`.
- `SV_CATCHMENT` (with the addresses entity): `install-fleet-apps/fleet_sa_app/app/semantic_views.sql`.
- `query_overture_global` tool: `install-fleet-apps/fleet_sa_app/app/agent-spec.json`; its view is built by `install-fleet-apps/scripts/prepare_overture.py`.
