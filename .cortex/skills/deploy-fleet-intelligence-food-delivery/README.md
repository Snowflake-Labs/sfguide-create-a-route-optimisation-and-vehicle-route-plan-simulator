# Fleet Intelligence Food Delivery Solution

A self-contained Snowflake Native App that deploys a full-stack food delivery fleet intelligence platform — complete with real-time route visualization, courier heatmaps, travel time matrices, and a Cortex AI agent — all running inside Snowpark Container Services (SPCS).

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          SNOWFLAKE ACCOUNT (Consumer)                          │
│                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │                    FLEET_INTELLIGENCE_APP (Native App)                    │  │
│  │                                                                           │  │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │  │
│  │  │                     CORE Schema                                     │  │  │
│  │  │                                                                     │  │  │
│  │  │  ┌──────────────────────┐  ┌──────────────────────┐                │  │  │
│  │  │  │  Streamlit status.py │  │  fleet_intelligence   │                │  │  │
│  │  │  │  (Snowsight Landing) │  │  _service (SPCS)      │                │  │  │
│  │  │  │                      │  │                        │                │  │  │
│  │  │  │  - Service status    │  │  ┌──────────────────┐ │                │  │  │
│  │  │  │  - Permissions mgmt  │  │  │ React UI + Node  │ │                │  │  │
│  │  │  │  - Deploy actions    │  │  │ Express Server   │ │                │  │  │
│  │  │  │  - Launch link       │  │  │ (fleet-intel:v1.2)│ │                │  │  │
│  │  │  └──────────────────────┘  │  └──────────────────┘ │                │  │  │
│  │  │                            │  Port 8080 (public)   │                │  │  │
│  │  │  Procedures:               └──────────────────────┘                │  │  │
│  │  │  deploy(), deploy_full(), get_status(),                             │  │  │
│  │  │  resume_services(), version_init()                                  │  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                           │  │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │  │
│  │  │                    ROUTING Schema                                   │  │  │
│  │  │                                                                     │  │  │
│  │  │  ┌────────────┐  ┌────────────┐  ┌─────────────────┐               │  │  │
│  │  │  │    ORS      │  │   VROOM    │  │ Routing Gateway │               │  │  │
│  │  │  │  Service    │  │  Service   │  │    Service      │               │  │  │
│  │  │  │(v9.0.0)    │  │ (v1.0.1)   │  │  (v0.9.2)       │               │  │  │
│  │  │  │            │  │            │  │                   │               │  │  │
│  │  │  │ Per-city   │  │ Vehicle    │  │  Flask proxy →   │               │  │  │
│  │  │  │ PBF graphs │  │ routing    │  │  ORS + VROOM     │               │  │  │
│  │  │  │ HIGHMEM_S  │  │ optimizer  │  │  /directions     │               │  │  │
│  │  │  └────────────┘  └────────────┘  │  /matrix         │               │  │  │
│  │  │                                   │  /isochrones     │               │  │  │
│  │  │  ┌────────────┐                  │  /optimization   │               │  │  │
│  │  │  │ Downloader │                  │  /ors_status     │               │  │  │
│  │  │  │  Service   │                  └─────────────────┘               │  │  │
│  │  │  │ (v0.0.3)   │                                                    │  │  │
│  │  │  │ PBF fetch  │  SQL Functions:                                     │  │  │
│  │  │  │ from BBBike│  DIRECTIONS(), MATRIX(), MATRIX_TABULAR(),          │  │  │
│  │  │  │ /Geofabrik │  ISOCHRONES(), OPTIMIZATION(), ORS_STATUS()         │  │  │
│  │  │  └────────────┘  + per-city: DIRECTIONS_{REGION}(), MATRIX_{REGION}│  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                           │  │
│  │  ┌─────────────────────────────────────────────────────────────────────┐  │  │
│  │  │                     DATA Schema                                     │  │  │
│  │  │                                                                     │  │  │
│  │  │  Tables:                          Views:                            │  │  │
│  │  │  RESTAURANTS                      DELIVERY_SUMMARY                  │  │  │
│  │  │  CUSTOMER_ADDRESSES               COURIER_LOCATIONS_V               │  │  │
│  │  │  COURIERS                         ORDERS_ASSIGNED_TO_COURIERS       │  │  │
│  │  │  DELIVERY_ORDERS                  DELIVERY_NAMES                    │  │  │
│  │  │  ORDERS_WITH_LOCATIONS            DELIVERY_ROUTE_PLAN               │  │  │
│  │  │  DELIVERY_ROUTES                                                    │  │  │
│  │  │  DELIVERY_ROUTES_PARSED           Travel Time Matrix:               │  │  │
│  │  │  DELIVERY_ROUTE_GEOMETRIES        CA_H3_RES{7,8,9}                 │  │  │
│  │  │  COURIER_LOCATIONS                CA_WORK_QUEUE_RES{7,8,9}         │  │  │
│  │  │                                   CA_MATRIX_RAW_RES{7,8,9}         │  │  │
│  │  │  Procedures:                      CA_TRAVEL_TIME_RES{7,8,9}        │  │  │
│  │  │  BUILD_HEXAGONS(), BUILD_WORK_QUEUE(),  (includes VEHICLE_TYPE col) │  │  │
│  │  │  BUILD_TRAVEL_TIME_RANGE_REGION(res, start, end, fn, vehicle),      │  │  │
│  │  │  FLATTEN_MATRIX_RAW(res, region, vehicle_type),                     │  │  │
│  │  │  BUILD_MATRIX_FOR_REGION(res, bbox, fn, region, vehicle),           │  │  │
│  │  │  MATRIX_PROGRESS()                                                  │  │  │
│  │  └─────────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
│                                                                                 │
│  ┌──────────────────────────────┐  ┌──────────────────────────────────────────┐│
│  │    COMPUTE POOLS              │  │  EXTERNAL ACCESS INTEGRATIONS            ││
│  │                                │  │                                          ││
│  │  *_compute_pool (CPU_X64_S)   │  │  fleet_intel_map_tiles_eai               ││
│  │    └─ fleet_intelligence_svc  │  │    └─ a/b/c/d.basemaps.cartocdn.com     ││
│  │                                │  │                                          ││
│  │  *_routing_pool (HIGHMEM_S)   │  │  fleet_intel_download_eai                ││
│  │    └─ ors_service (per city)  │  │    └─ download.bbbike.org               ││
│  │    └─ vroom_service           │  │    └─ download.geofabrik.de             ││
│  │    └─ routing_gateway_service │  │                                          ││
│  │    └─ downloader_service      │  │                                          ││
│  └──────────────────────────────┘  └──────────────────────────────────────────┘│
│                                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────────────┐│
│  │                    EXTERNAL DATA SOURCES                                     ││
│  │                                                                              ││
│  │  Overture Maps (Marketplace)          BBBike / Geofabrik                    ││
│  │  ├─ OVERTURE_MAPS__PLACES             ├─ Per-city .osm.pbf files            ││
│  │  │   └─ CARTO.PLACE (restaurants)     │   downloaded at deploy time          ││
│  │  └─ OVERTURE_MAPS__ADDRESSES          └─ Stored on ORS_SPCS_STAGE           ││
│  │      └─ CARTO.ADDRESS (customers)                                            ││
│  │                                        Snowflake Cortex AI                   ││
│  │                                        └─ CORTEX.COMPLETE (AI Agent)         ││
│  └──────────────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Component Breakdown

### React UI (fleet-intelligence-app)

| Component | Description |
|-----------|-------------|
| **FleetMap** | MapLibre GL map with delivery route polylines, courier markers, and H3 heatmap layers |
| **DataBuilder** | In-app wizard that provisions ORS, ingests Overture Maps data, generates couriers/orders with configurable vehicle type, and computes routes — all via SQL calls to the native app |
| **ChatPanel** | Cortex AI agent interface for natural language fleet queries |
| **MatrixBuilder** | Travel time matrix builder using H3 hexagonal grid at resolutions 7/8/9, with vehicle type selection (results append per vehicle type) |
| **CatchmentPanel** | Isochrone-based restaurant catchment analysis |
| **StatsPanel** | Real-time delivery KPIs (active couriers, avg speed, delivery times) |
| **Header** | City selector, map mode toggle, status filters |

### SPCS Services

| Service | Image | Purpose | Compute |
|---------|-------|---------|---------|
| **fleet_intelligence_service** | `fleet-intelligence:v1.2` | React UI + Express API server | CPU_X64_S |
| **ors_service** / **ORS_SERVICE_{REGION}** | `openrouteservice:v9.0.0` | OpenRouteService routing engine (one per city PBF) | HIGHMEM_X64_S |
| **vroom_service** | `vroom-docker:v1.0.1` | VROOM vehicle routing optimizer | HIGHMEM_X64_S |
| **routing_gateway_service** | `routing_reverse_proxy:v0.9.2` | Flask proxy that routes SQL function calls to ORS/VROOM | HIGHMEM_X64_S |
| **downloader_service** | `downloader:v0.0.3` | Downloads PBF map files from BBBike/Geofabrik to stage | HIGHMEM_X64_S |

### SQL Functions (exposed via Routing Gateway)

| Function | Signature | Description |
|----------|-----------|-------------|
| `DIRECTIONS` | `(method, start_array, end_array)` | Point-to-point route with geometry |
| `DIRECTIONS` | `(method, locations_variant)` | Multi-waypoint directions |
| `MATRIX` | `(method, locations_array)` | N x N travel time/distance matrix |
| `MATRIX_TABULAR` | `(method, origin, destinations)` | 1-to-N matrix (for batch processing). `method` is the ORS profile (e.g., `driving-car`, `cycling-regular`) |
| `ISOCHRONES` | `(method, lon, lat, range)` | Reachability polygons |
| `OPTIMIZATION` | `(jobs, vehicles, matrices)` | VROOM vehicle routing optimization |
| `ORS_STATUS` | `()` | Health check for ORS engine |

### Supported Cities

| City | Country | ORS Region | PBF Source |
|------|---------|------------|------------|
| San Francisco | US/CA | SanFrancisco | BBBike |
| Los Angeles | US/CA | LosAngeles | BBBike |
| San Jose | US/CA | SanJose | BBBike |
| Sacramento | US/CA | Sacramento | BBBike |
| Santa Barbara | US/CA | SantaBarbara | BBBike |
| Stockton | US/CA | Stockton | BBBike |
| New York | US/NY | NewYork | BBBike |
| Chicago | US/IL | Chicago | BBBike |
| London | GB | London | BBBike |
| Paris | FR | Paris | BBBike |
| Berlin | DE | Berlin | BBBike |

## Data Pipeline

```
Overture Maps (Marketplace)
        │
        ▼
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  RESTAURANTS     │     │ CUSTOMER_ADDRESSES│     │    COURIERS       │
│  (Places data)   │     │ (Address data)    │     │ (Shift patterns)  │
└────────┬────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                       │                         │
         ▼                       ▼                         │
    ┌────────────────────────────────────────┐              │
    │        DELIVERY_ORDERS                  │◄─────────────┘
    │  (Random order assignment per courier)  │
    └───────────────┬────────────────────────┘
                    │
                    ▼
    ┌────────────────────────────────────────┐
    │     ORDERS_WITH_LOCATIONS               │
    │  (Join restaurants + addresses)          │
    └───────────────┬────────────────────────┘
                    │
                    ▼  ORS DIRECTIONS() calls
    ┌────────────────────────────────────────┐
    │     DELIVERY_ROUTES                     │
    │  (Raw route GeoJSON response)           │
    └───────────────┬────────────────────────┘
                    │
                    ▼  Parse geometry + timing
    ┌────────────────────────────────────────┐
    │     DELIVERY_ROUTE_GEOMETRIES           │
    │  (Final routes with timestamps)         │
    └───────────────┬────────────────────────┘
                    │
                    ▼  Interpolate 15 points/delivery
    ┌────────────────────────────────────────┐
    │     COURIER_LOCATIONS                   │
    │  (Simulated GPS breadcrumbs)            │
    │  States: at_restaurant, picking_up,     │
    │  en_route, arriving, delivered           │
    └─────────────────────────────────────────┘
```

## Travel Time Matrix Pipeline

```
BUILD_HEXAGONS(resolution, bbox)
        │
        ▼
  CA_H3_RES{7,8,9}  ──►  BUILD_WORK_QUEUE()
                                │
                                ▼
                    CA_WORK_QUEUE_RES{7,8,9}
                    (origin + k-ring neighbors)
                                │
                                ▼  MATRIX_TABULAR() calls
                    CA_MATRIX_RAW_RES{7,8,9}
                    (raw VARIANT payloads)
                                │
                                ▼  FLATTEN_MATRIX_RAW()
                    CA_TRAVEL_TIME_RES{7,8,9}
                    (origin_h3, dest_h3, seconds, meters, region, vehicle_type)
```

### Vehicle Type Support

- Travel time tables include a `VEHICLE_TYPE` column (default: `driving-car`)
- Matrix builds for different vehicle types **append** to the same table (filtered by region + vehicle_type)
- Supported profiles: `driving-car`, `driving-hgv`, `cycling-regular`, `cycling-road`, `cycling-electric`, `foot-walking`
- Procedure signatures: `BUILD_MATRIX_FOR_REGION(res, minLat, maxLat, minLon, maxLon, matrixFn, region, vehicleProfile)`

## Native App Manifest (v2)

| Artifact | Description |
|----------|-------------|
| `setup_script.sql` | Creates schemas (core, routing, data), all procedures, tables, views, and the Streamlit app |
| `manifest.yml` | Declares 5 container images, 2 external access references, 6 account privileges, lifecycle callbacks |
| `services/*.yaml` | SPCS service specifications for each container |
| `streamlit/status.py` | Snowsight landing page with service status, permissions management, and deploy actions |

## Release Management

- **Application Package**: `FLEET_INTELLIGENCE_PKG`
- **Release Channels**: DEFAULT (production)
- **Versioning**: `REGISTER VERSION` for new versions, `ADD PATCH` for Streamlit/SQL-only changes
- **Upgrade Path**: `ALTER APPLICATION ... UPGRADE USING VERSION ...`

## Prerequisites

- Snowflake account with ACCOUNTADMIN
- Docker Desktop (linux/amd64 builds)
- Snow CLI authenticated
- Overture Maps datasets from Snowflake Marketplace

## Deployment

See [SKILL.md](SKILL.md) for the complete step-by-step deployment guide.
