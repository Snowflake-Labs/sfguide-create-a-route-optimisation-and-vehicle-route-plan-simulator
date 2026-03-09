# SwiftBite Fleet Intelligence

An interactive fleet intelligence application for food delivery operations across 20 California cities. Built with React + DeckGL + MapLibre, powered by Snowflake Cortex AI, deployed as a Snowflake Native App on SPCS.

---

## Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Snowflake Native App (SPCS)                     │
│                                                                     │
│  ┌───────────────────────────┐    ┌──────────────────────────────┐  │
│  │    React Frontend         │    │    Express Backend (Node.js)  │  │
│  │                           │    │                              │  │
│  │  • DeckGL Map Layers      │◄──►│  • /api/agent (SSE)          │  │
│  │  • MapLibre GL Basemap    │    │  • /api/query (SQL exec)     │  │
│  │  • Recharts Inline Charts │    │  • /api/tables (metadata)    │  │
│  │  • Markdown + GFM Tables  │    │  • /health (readiness)       │  │
│  │                           │    │                              │  │
│  └───────────────────────────┘    └──────────┬───────────────────┘  │
│                                              │                      │
│                                   ┌──────────▼───────────────────┐  │
│                                   │  Snowflake SQL API           │  │
│                                   │  /api/v2/statements          │  │
│                                   │  (SPCS OAuth Token Auth)     │  │
│                                   └──────────┬───────────────────┘  │
└──────────────────────────────────────────────┼──────────────────────┘
                                               │
                    ┌──────────────────────────▼──────────────────────┐
                    │            Snowflake Platform                    │
                    │                                                  │
                    │  ┌─────────────────┐  ┌──────────────────────┐  │
                    │  │ CORTEX.COMPLETE  │  │ Fleet Intelligence   │  │
                    │  │ (llama3.1-70b)   │  │ Tables & Views       │  │
                    │  │                  │  │ (14 tables, 8 views) │  │
                    │  └─────────────────┘  └──────────────────────┘  │
                    │                                                  │
                    │  ┌─────────────────────────────────────────────┐ │
                    │  │ OpenRouteService Native App                 │ │
                    │  │ (Routing, Directions, Matrix Functions)     │ │
                    │  └─────────────────────────────────────────────┘ │
                    └──────────────────────────────────────────────────┘
```

### Frontend (React + TypeScript)

- **Map Visualization**: DeckGL layers over MapLibre GL basemap (Carto tiles via External Access Integration)
- **Map Modes**: Courier locations (ScatterplotLayer), delivery routes (PathLayer), H3 matrix heatmap (H3HexagonLayer)
- **AI Agent Chat**: Sidebar with streaming markdown responses, GFM table rendering, and inline Recharts visualizations
- **Compact Stats Bar**: Real-time delivery metrics (total deliveries, active couriers, avg time/distance) with expandable city breakdown

### Backend (Express + Node.js on SPCS)

- **SPCS Container**: Single container service on a GPU_NV_S compute pool, auto-suspend disabled
- **Authentication**: SPCS OAuth token from `/snowflake/session/token`, auto-refreshed for SQL API calls
- **SQL Execution**: All data queries and Cortex AI calls routed through the Snowflake SQL API (`/api/v2/statements`)
- **AI Integration**: `SNOWFLAKE.CORTEX.COMPLETE('llama3.1-70b', ...)` called as a SQL function — requires the `SNOWFLAKE.CORTEX_USER` database role grant
- **Agent Pipeline**: User question → SQL generation via Cortex → query execution → response generation with data context → SSE streaming to frontend

### Data Pipeline

```
Overture Maps → OpenRouteService (Routing/Directions) → Courier Simulation
     │                    │                                     │
     ▼                    ▼                                     ▼
 Road Network      Travel Time Matrices              DELIVERY_SUMMARY
 (OSM/PBF)         (H3 Hex Pairs)                    COURIER_LOCATIONS
                                                      ORDERS_ASSIGNED_TO_COURIERS
                                                      ... (14 tables, 8 views)
```

### Key Tables

| Table | Description |
|-------|-------------|
| `DELIVERY_SUMMARY` | Completed delivery records with timing, distance, ratings |
| `COURIER_LOCATIONS` | Real-time courier GPS positions and status |
| `ORDERS_ASSIGNED_TO_COURIERS` | Active order-courier assignments |
| `RESTAURANT_LOCATIONS` | Restaurant coordinates and cuisine types |
| `CITY_ZONES` | City boundary definitions for 20 California cities |
| `SF_TRAVEL_TIME_MATRIX` | H3 hex-to-hex travel time/distance pairs |

---

## Travel Time Matrix Processing

The travel time matrix is the computational backbone of fleet intelligence. It pre-computes driving times between H3 hexagon centroids across California, enabling instant ETA lookups, courier assignment optimization, and delivery zone analysis.

### How It Works

1. **H3 Hexagon Grid**: The service area is tessellated into H3 hexagons at multiple resolutions. Each hexagon centroid becomes an origin/destination point for routing.

2. **Tiered Resolution Strategy**: Three resolution tiers handle different distance scales:
   - **Resolution 9 (Last Mile)**: ~174m edge length, 2-mile cutoff — for courier-to-restaurant and restaurant-to-customer routing
   - **Resolution 8 (Delivery Zone)**: ~460m edge length, 10-mile cutoff — for zone-level dispatch and demand forecasting
   - **Resolution 7 (Long Range)**: ~1.2km edge length, 50-mile cutoff — for cross-city transfers and regional planning

3. **Sparse Matrix Optimization**: Instead of computing all NxN pairs (which grows quadratically), a distance cutoff filters out pairs beyond the useful range for each tier. This reduces the California statewide matrix from **230 billion** theoretical pairs down to **~102 million** practical pairs — a 99.96% reduction.

4. **ORS MATRIX Function**: The OpenRouteService Native App exposes a `MATRIX()` SQL function that accepts arrays of origin/destination coordinates and returns a full NxN duration/distance matrix in a single call. Origins are processed in batches, with each batch computing thousands of pairs simultaneously.

5. **Storage**: Results are stored in Snowflake tables (e.g., `SF_TRAVEL_TIME_MATRIX`) with columns for origin hex, destination hex, duration (seconds), and distance (meters). Queries use H3 index lookups for O(1) retrieval.

### California Scenario

The California deployment covers 20 cities with a statewide routing graph built from OpenStreetMap data.

#### Graph Build Phase

| Phase | Duration | Details |
|-------|----------|---------|
| OSM Data Download | 5-10 min | California.osm.pbf from Geofabrik (~1.3 GB) |
| Upload to Stage | 3-5 min | To ORS SPCS stage |
| Graph Parsing | 2-3 min | **4.1 million nodes, 5.2 million edges** |
| CH Preparation | 15-25 min | Contraction Hierarchies for fast routing |
| Core/LM Preparation | 10-15 min | Additional optimization structures |
| Service Ready | 2-3 min | Service becomes available for queries |
| **Total** | **45-75 minutes** | End-to-end graph build |

#### Matrix Computation Phase

Once the routing graph is ready, the travel time matrix is built tier by tier:

| Resolution | Hexagons | Distance Cutoff | Sparse Pairs | Estimated Time |
|------------|----------|-----------------|--------------|----------------|
| 9 (Last Mile) | 480,621 | 2 miles | ~12M | 3-4 hours |
| 8 (Delivery Zone) | 144,636 | 10 miles | ~45M | 5-6 hours |
| 7 (Long Range) | 38,239 | 50 miles | ~45M | 3-4 hours |
| **Total** | **663,496** | — | **~102M pairs** | **11-14 hours** |

#### San Francisco Proof of Concept (Measured)

The San Francisco area was used as a proof of concept to validate the matrix pipeline:

| Metric | Value |
|--------|-------|
| Hexagons | 1,065 (H3 Resolution 9) |
| Total Pairs Computed | 1,134,225 (1,065 x 1,065 — full matrix, no cutoff) |
| ORS MATRIX Computation | **36 seconds** (single SQL call) |
| INSERT into Snowflake | 2.4 seconds |
| End-to-end Pipeline | ~3 minutes |

The SF proof of concept demonstrates that the ORS MATRIX function computes **1.1 million+ travel time pairs in 36 seconds** — a rate of ~31,500 pairs/second. At this rate, the full California 102M-pair sparse matrix requires approximately 11-14 hours of compute time spread across batched calls.

#### Scaling Summary

| Scope | Hexagons (Res 9) | All-Pairs | Sparse Pairs | Time |
|-------|-------------------|-----------|--------------|------|
| San Francisco | 1,065 | 1.1M | 1.1M (no cutoff) | 3 min (measured) |
| Single CA city | ~5,000-20,000 | 25M-400M | ~500K-2M | 10-30 min |
| All CA cities (Res 9) | ~480,000 | 230B | ~12M | 3-4 hrs |
| Full CA (all resolutions) | 663,000+ | — | **~102M** | **11-14 hrs** |

---

## Post-Install Grant Requirements

When deploying without DataOps (manual installation), the following grants must be applied by an ACCOUNTADMIN after `CREATE APPLICATION`:

```sql
-- 1. Data access: grant the app access to the fleet intelligence database and schema
GRANT USAGE ON DATABASE OPENROUTESERVICE_SETUP
    TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT USAGE ON SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY
    TO APPLICATION FLEET_INTELLIGENCE_APP;

-- 2. Table/view access: grant SELECT on all data objects
GRANT SELECT ON ALL TABLES IN SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY
    TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT SELECT ON ALL VIEWS IN SCHEMA OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY
    TO APPLICATION FLEET_INTELLIGENCE_APP;

-- 3. Cortex AI access (REQUIRED for the AI agent to function)
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER
    TO APPLICATION FLEET_INTELLIGENCE_APP;

-- 4. SPCS infrastructure
GRANT CREATE COMPUTE POOL ON ACCOUNT
    TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT CREATE WAREHOUSE ON ACCOUNT
    TO APPLICATION FLEET_INTELLIGENCE_APP;
GRANT BIND SERVICE ENDPOINT ON ACCOUNT
    TO APPLICATION FLEET_INTELLIGENCE_APP;

-- 5. Application role to admin
GRANT APPLICATION ROLE FLEET_INTELLIGENCE_APP.app_user
    TO ROLE ACCOUNTADMIN;

-- 6. Deploy the service
CALL FLEET_INTELLIGENCE_APP.core.deploy();
```

### Verify Grants

After applying grants, verify with:

```sql
CALL FLEET_INTELLIGENCE_APP.core.check_grants();
```

Returns JSON with `database_access` and `cortex_role` status booleans.

---

## Deployment

### Prerequisites

- Snowflake account with SPCS enabled
- ACCOUNTADMIN role
- OpenRouteService Native App installed (for routing functions and matrix computation)
- Docker (for building the container image)

### Quick Deploy

```bash
# 1. Build and push Docker image
docker build --platform linux/amd64 -t fleet-intelligence:v1.0 .
snow spcs image-registry token --format JSON -c FREE_TRIAL 2>/dev/null | \
    docker login <registry_url> -u 0sessiontoken --password-stdin
docker tag fleet-intelligence:v1.0 <registry_url>/fleet-intelligence:v1.0
docker push <registry_url>/fleet-intelligence:v1.0

# 2. Upload native app files to stage
snow stage copy native-app/ @FLEET_INTELLIGENCE_PKG.STAGE_CONTENT.APP_CODE/ \
    --overwrite -c FREE_TRIAL

# 3. Register version and create application
snow sql -c FREE_TRIAL -q "
    ALTER APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
        REGISTER VERSION V1_2 USING '@FLEET_INTELLIGENCE_PKG.STAGE_CONTENT.APP_CODE';
    CREATE APPLICATION FLEET_INTELLIGENCE_APP
        FROM APPLICATION PACKAGE FLEET_INTELLIGENCE_PKG
        USING VERSION V1_2;
"

# 4. Apply grants (see Post-Install Grant Requirements above)

# 5. Deploy the SPCS service
snow sql -c FREE_TRIAL -q "CALL FLEET_INTELLIGENCE_APP.core.deploy();"
```

### Version Updates

SPCS caches Docker image digests at version creation time. To deploy code changes:

1. Rebuild and push the Docker image (use `--no-cache` if needed)
2. Deregister the old version (max 2 unassigned versions allowed): `ALTER APPLICATION PACKAGE ... DEREGISTER VERSION <old>;`
3. Register a new version: `ALTER APPLICATION PACKAGE ... REGISTER VERSION <new> USING '@...APP_CODE';`
4. Upgrade the application: `ALTER APPLICATION ... UPGRADE USING VERSION <new>;`

Simply pushing a new image with the same tag and restarting the service will NOT pick up changes.
