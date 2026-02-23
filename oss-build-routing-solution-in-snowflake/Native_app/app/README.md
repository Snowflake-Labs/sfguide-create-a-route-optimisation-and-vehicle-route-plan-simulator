# OpenRouteService Native App

**Enterprise-grade routing and optimization powered by OpenRouteService, running natively in Snowflake.**

---

## What This App Does

This application provides powerful geospatial routing capabilities directly within your Snowflake environment:

| Function | Description |
|----------|-------------|
| **DIRECTIONS** | Calculate optimal routes between locations with turn-by-turn instructions |
| **ISOCHRONES** | Generate travel-time catchment areas (e.g., "all areas within 15 min drive") |
| **MATRIX** | Compute distance/duration matrices between multiple origins and destinations |
| **OPTIMIZATION** | Solve vehicle routing problems (VRP) with capacity and time constraints |

## Getting Started

### Step 1: Grant Permissions
Click the **Permissions** tab above and grant the required privileges for compute pools and network access.

### Step 2: Launch the App
Click the **Launch app** button in the upper right corner. The app will:
- Start the routing services (takes 2-3 minutes on first launch)
- Build routing graphs for your configured region
- Display a management UI to monitor service status

### Step 3: Use the Functions
Once services are running, call the routing functions from any SQL worksheet:

```sql
-- Calculate a route between two points
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
    'driving-car',
    -122.4194, 37.7749,  -- San Francisco (start)
    -122.2711, 37.8044   -- Oakland (end)
);

-- Generate a 15-minute walking isochrone
SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(
    'foot-walking',
    -122.4194, 37.7749,  -- Center point
    15                    -- Minutes
);
```

## Architecture

This app runs 4 containerized services in Snowpark Container Services:

| Service | Purpose |
|---------|---------|
| **OpenRouteService** | Core routing engine with OSM data |
| **VROOM** | Vehicle routing optimization solver |
| **Gateway** | API proxy and request routing |
| **Downloader** | Map data management |

## Support

- **Documentation**: [OpenRouteService API Docs](https://openrouteservice.org/dev/#/api-docs)
- **Map Coverage**: Currently configured for San Francisco Bay Area
- **Customization**: Contact your Snowflake representative for custom regions

---

*Powered by OpenRouteService and Snowpark Container Services*
