# Fleet Intelligence & Route Optimization Platform

## Architecture Overview

```
                        +-------------------------------------------------+
                        |            SNOWFLAKE MARKETPLACE                 |
                        |                                                 |
                        |   +-------------------+  +-------------------+  |
                        |   | Overture Maps     |  | Overture Maps     |  |
                        |   | Places (POIs)     |  | Addresses         |  |
                        |   +--------+----------+  +--------+----------+  |
                        +------------|------------------------|-----------+
                                     |                        |
                                     v                        v
+=======================================================================================+
||                                                                                     ||
||                          S N O W F L A K E   P L A T F O R M                        ||
||                                                                                     ||
||  +---------------------------+     +------------------------------------------+     ||
||  |     DATA INGESTION        |     |       SNOWPARK CONTAINER SERVICES        |     ||
||  |                           |     |              (SPCS)                       |     ||
||  |  +---------------------+  |     |  +----------+  +---------+  +--------+   |     ||
||  |  | OpenStreetMap       |  |     |  |          |  |         |  |        |   |     ||
||  |  | PBF Map Files       |--------->| ORS      |  |  VROOM  |  |Gateway |   |     ||
||  |  +---------------------+  |     |  | Routing  |  | Route   |  | API    |   |     ||
||  |                           |     |  | Engine   |  |Optimizer|  | Proxy  |   |     ||
||  |  +---------------------+  |     |  |          |  |         |  |        |   |     ||
||  |  | Overture Maps       |  |     |  +----+-----+  +----+----+  +---+----+   |     ||
||  |  | POIs & Addresses    |  |     |       |             |           |         |     ||
||  |  +---------------------+  |     |  +----+-------------+-----------+----+    |     ||
||  +---------------------------+     |  |     React / Express UI Service    |    |     ||
||                                    |  |       (Fleet Intelligence)        |    |     ||
||                                    |  +----------------------------------+    |     ||
||                                    +------------------+---+-------------------+     ||
||                                                       |   |                         ||
||                              SQL Service Functions     |   |                         ||
||                    DIRECTIONS  ISOCHRONES  MATRIX  OPTIMIZATION                     ||
||                                                       |   |                         ||
||  +---------------------------------------------------+   +----------------------+  ||
||  |                                                                               |  ||
||  |                     SNOWFLAKE INTELLIGENCE LAYER                               |  ||
||  |                                                                               |  ||
||  |  +------------------+  +--------------------+  +---------------------------+  |  ||
||  |  |   Cortex AI      |  |   Cortex Agent     |  |    Semantic Views         |  |  ||
||  |  |                  |  |                     |  |                           |  |  ||
||  |  |  AI_COMPLETE     |  |  Routing Agent      |  |  Fleet Analytics Model   |  |  ||
||  |  |  - Geocoding     |  |  - Directions Tool  |  |  - Trips & Routes        |  |  ||
||  |  |  - Data Gen      |  |  - Isochrone Tool   |  |  - Driver Activity       |  |  ||
||  |  |  - Insights      |  |  - Optimize Tool    |  |  - Delivery Metrics      |  |  ||
||  |  +------------------+  +--------------------+  +---------------------------+  |  ||
||  |                                                                               |  ||
||  +-------------------------------------------------------------------------------+  ||
||                                           |                                         ||
||  +-------------------------------------------------------------------------------+  ||
||  |                                                                               |  ||
||  |                        PRESENTATION LAYER                                     |  ||
||  |                                                                               |  ||
||  |  +----------------+ +----------------+ +----------------+ +----------------+  |  ||
||  |  |   Route        | |    Fleet       | |   Retail       | |   SwiftBite    |  |  ||
||  |  |   Optimizer    | |    Control     | |   Catchment    | |   Food         |  |  ||
||  |  |   Simulator    | |    Center      | |   Analysis     | |   Delivery     |  |  ||
||  |  |                | |                | |                | |                |  |  ||
||  |  | Multi-vehicle  | | 80+ drivers    | | Isochrone      | | Multi-city     |  |  ||
||  |  | delivery       | | Real-time      | | trade areas    | | courier sim    |  |  ||
||  |  | planning       | | tracking       | | H3 heatmaps   | | Live tracking  |  |  ||
||  |  |                | |                | | AI location    | | Cortex Agent   |  |  ||
||  |  |  [Streamlit]   | |  [Streamlit]   | |  [Streamlit]   | |  [React+SPCS]  |  |  ||
||  |  +----------------+ +----------------+ +----------------+ +----------------+  |  ||
||  |                                                                               |  ||
||  |  +--------------------------------------+  +-------------------------------+  |  ||
||  |  | Snowflake Intelligence UI            |  | Travel Time Matrix Engine     |  |  ||
||  |  | Natural language routing queries     |  | H3 grid precomputation        |  |  ||
||  |  | "Find fastest route from A to B"     |  | City to country scale         |  |  ||
||  |  +--------------------------------------+  +-------------------------------+  |  ||
||  |                                                                               |  ||
||  +-------------------------------------------------------------------------------+  ||
||                                                                                     ||
||  +-------------------------------------------------------------------------------+  ||
||  |                     NATIVE APP PACKAGING                                      |  ||
||  |                                                                               |  ||
||  |   +----------------------------------+  +----------------------------------+  |  ||
||  |   | ORS Native App (Single City)     |  | Fleet Intelligence Native App    |  |  ||
||  |   | - Self-contained routing engine  |  | - Multi-city routing             |  |  ||
||  |   | - One-click marketplace install  |  | - Full UI + Cortex Agent         |  |  ||
||  |   | - Auto-deploy on grant           |  | - Overture Maps integration      |  |  ||
||  |   +----------------------------------+  +----------------------------------+  |  ||
||  +-------------------------------------------------------------------------------+  ||
||                                                                                     ||
+=======================================================================================+
```

---

## Key Capabilities

| Capability | Technology | Value |
|:-----------|:-----------|:------|
| **Real-World Routing** | OpenRouteService on SPCS | Directions, isochrones, matrix & optimization on actual road networks |
| **AI-Powered Intelligence** | Cortex AI + Cortex Agent | Natural language queries, geocoding, synthetic data generation |
| **Marketplace Data** | Overture Maps | 50M+ POIs and addresses globally, zero ETL |
| **Native App Distribution** | Snowflake Native Apps | One-click install, auto-provisioning, cross-account sharing |
| **Scalable Precomputation** | H3 Travel Time Matrix | City-to-country scale precomputed travel times |
| **Multiple Frontends** | Streamlit + React on SPCS | Interactive dashboards, real-time fleet tracking |

---

## Use Cases

```
    +------------------+     +------------------+     +------------------+
    |                  |     |                  |     |                  |
    |   LOGISTICS &    |     |   FOOD DELIVERY  |     |     RETAIL &     |
    |   FLEET MGMT     |     |   & LAST MILE    |     |   SITE PLANNING  |
    |                  |     |                  |     |                  |
    |  - Route         |     |  - Courier       |     |  - Catchment     |
    |    optimization  |     |    dispatch      |     |    analysis      |
    |  - Driver        |     |  - Delivery      |     |  - Competitor    |
    |    tracking      |     |    ETAs          |     |    mapping       |
    |  - Shift         |     |  - Multi-city    |     |  - Location      |
    |    planning      |     |    operations    |     |    scoring       |
    |  - Fleet         |     |  - Real-time     |     |  - Trade area    |
    |    analytics     |     |    monitoring    |     |    density       |
    |                  |     |                  |     |                  |
    +------------------+     +------------------+     +------------------+
```

---

## Data Flow

```
  Marketplace Data          Map Data              AI Layer
       |                      |                      |
       v                      v                      v
  +---------+          +------------+         +-----------+
  | Overture |         | OSM PBF    |         | Cortex AI |
  | Maps     |         | Files      |         | COMPLETE  |
  +---------+          +------------+         +-----------+
       |                      |                      |
       v                      v                      v
  +----------------------------------------------------------+
  |              SPCS Routing Engine                          |
  |   ORS (directions/isochrones) + VROOM (optimization)     |
  +----------------------------------------------------------+
                             |
              SQL Service Functions
                             |
        +--------------------+--------------------+
        |                    |                    |
        v                    v                    v
  +----------+       +--------------+      +------------+
  | Streamlit|       | React SPCS   |      | Cortex     |
  | Apps     |       | Dashboard    |      | Agent      |
  +----------+       +--------------+      +------------+
```

---

> **Everything runs inside Snowflake.** No external infrastructure. No data movement. Deploy via Native App with one click.
