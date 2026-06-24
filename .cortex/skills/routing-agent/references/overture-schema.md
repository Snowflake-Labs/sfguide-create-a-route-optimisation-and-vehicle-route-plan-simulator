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
| `CATEGORIES` | VARIANT | `p.CATEGORIES:primary::STRING` | Primary category; `:alternate` is a list |
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
and `CATEGORIES:primary` plus a `LIKE '%cat%'` fallback, so partial names work.

## Cost-safe query discipline

Every Overture query MUST be bounded. The canonical pattern, used by both the
verbs and `analytic_layer.sql`:

1. **bbox prefilter** for partition pruning: `ST_X(geom) BETWEEN ? AND ? AND ST_Y(geom) BETWEEN ? AND ?`.
2. **authoritative polygon refine**: `ST_WITHIN(geom, boundary)` where `boundary`
   comes from `OPENROUTESERVICE_APP.CORE.REGION_CATALOG` (NULL-safe: degrades to
   bbox-only when no boundary). Prefer the real boundary polygon over bbox — a
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
| **Deterministic verb** | `query_overture_places` -> `ROUTING_AGENT.TOOL_OVERTURE_SEARCH` | region/bbox-bounded place search, counts, map-ready rows | region OR explicit bbox + hard LIMIT |
| **Deterministic verb** | `query_overture_addresses` -> `ROUTING_AGENT.TOOL_OVERTURE_ADDRESSES` | address density/coverage | region OR explicit bbox + hard LIMIT |
| **Region SV (Analyst)** | `query_catchment` -> `FLEET_INTELLIGENCE.SEMANTIC.SV_CATCHMENT` | "how many / per-city" counts within the active fleet region (POIs + addresses) | active region (data pre-scoped by `analytic_layer.sql`) |
| **Global SV (Analyst)** | `query_overture_global` -> `OVERTURE_MAPS__PLACES.CARTO.OVERTUREMAPS_PLACES_SEMANTIC_VIEW` | worldwide place filtering/listing + attributes (brand, website) + data confidence | Analyst-generated filters only |

### Why both an SV we build and the vendor SV

The CARTO PLACES share ships a rich Cortex Analyst semantic view
(`OVERTUREMAPS_PLACES_SEMANTIC_VIEW`, extension `CA`) with clean derived
dimensions (`PRIMARY_CATEGORY`, `PRIMARY_NAME`, `BRAND_NAME`, `COUNTRY`,
`REGION`, `LOCALITY`, `POSTCODE`, `STREET`, `CONFIDENCE`) and synonyms. We reuse
it directly (attached to `FLEET_AGENT` as `query_overture_global`) rather than
rebuild it. **Caveat:** it exposes only confidence metrics (`AVG/MIN/MAX_CONFIDENCE`),
**no row-count metric** — so "how many" questions are routed to `query_catchment`
(region-scoped, has `total_pois` / `total_addresses` COUNT metrics) or the
deterministic verbs instead. The ADDRESSES share ships no semantic view, so
address questions are served by `query_overture_addresses` and `SV_CATCHMENT`'s
`total_addresses` metric.

The vendor SV is global and lives in a share we do not control, so it is an
*additive* convenience, not a contract dependency — the region-scoped SV and the
verbs remain the contract-bound path. The consumer role (`FLEET_APP_USER`) needs
`GRANT IMPORTED PRIVILEGES ON DATABASE OVERTURE_MAPS__PLACES` for the Analyst
tool to read it (granted in `role_binding.sql`); the verbs run owner's-rights and
do not depend on that grant.

## Where these objects are defined

- Procs `TOOL_OVERTURE_SEARCH` / `TOOL_OVERTURE_ADDRESSES`: `references/deploy-agent.sql`.
- Verbs `query_overture_places` / `query_overture_addresses`: `install-fleet-apps/fleet_tools/user/src/procs/`.
- `SV_CATCHMENT` (with the addresses entity): `install-fleet-apps/fleet_sa_app/app/semantic_views.sql`.
- `query_overture_global` tool + share grants: `install-fleet-apps/fleet_sa_app/app/agent-spec.json` + `role_binding.sql`.
