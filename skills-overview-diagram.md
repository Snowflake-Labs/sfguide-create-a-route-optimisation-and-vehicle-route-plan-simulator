# Cortex Code Skills — Route Optimization Platform

## Skill Invocation Flow

```
+============================================================================+
|                                                                            |
|                         CORTEX CODE CLI                                    |
|                                                                            |
|   ┌──────────────────────────────────────────────────────────────────┐     |
|   │  $ cortex                                                        │     |
|   │                                                                  │     |
|   │  > Deploy the fleet intelligence food delivery solution          │     |
|   │                                                                  │     |
|   │  ┌────────────────────────────────────────────────────────────┐  │     |
|   │  │  Skill invoked: deploy-fleet-intelligence-food-delivery    │  │     |
|   │  │                                                            │  │     |
|   │  │  Setting up Fleet Intelligence Native App...               │  │     |
|   │  │  ✓ Building ORS routing containers                         │  │     |
|   │  │  ✓ Deploying SPCS services (ORS, VROOM, Gateway, UI)      │  │     |
|   │  │  ✓ Loading Overture Maps data                              │  │     |
|   │  │  ✓ Generating courier simulation data                      │  │     |
|   │  │  ✓ Creating Cortex Agent with routing tools                │  │     |
|   │  │  ✓ Launching SwiftBite dashboard                           │  │     |
|   │  │                                                            │  │     |
|   │  │  Fleet Intelligence deployed successfully!                 │  │     |
|   │  └────────────────────────────────────────────────────────────┘  │     |
|   └──────────────────────────────────────────────────────────────────┘     |
|                                                                            |
+============================================================================+
```

## Available Skills

```
                    ┌─────────────────────────────────────┐
                    │        CORTEX CODE SKILLS           │
                    │    Route Optimization Platform       │
                    └──────────────┬──────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          │                        │                        │
          v                        v                        v
   ┌──────────────┐      ┌──────────────┐        ┌──────────────┐
   │  FOUNDATION  │      │  SOLUTIONS   │        │   ADVANCED   │
   └──────┬───────┘      └──────┬───────┘        └──────┬───────┘
          │                     │                        │
          v                     v                        v


  ┌───────────────┐    ╔═══════════════════╗    ┌───────────────┐
  │ prerequisites │    ║                   ║    │ deploy-       │
  │ -build-       │    ║  deploy-fleet-    ║    │ snowflake-    │
  │ routing-      │    ║  intelligence-    ║    │ intelligence- │
  │ solution      │    ║  food-delivery    ║    │ routing-agent │
  │               │    ║                   ║    │               │
  │ Check Docker, │    ║  ★ YOU ARE HERE   ║    │ Cortex Agent  │
  │ Snow CLI,     │    ║                   ║    │ with NL       │
  │ dependencies  │    ║  Full SwiftBite   ║    │ routing       │
  └───────────────┘    ║  Native App with  ║    │ queries       │
                       ║  multi-city ORS,  ║    └───────────────┘
  ┌───────────────┐    ║  React UI, SPCS,  ║
  │ build-        │    ║  Cortex Agent,    ║    ┌───────────────┐
  │ routing-      │    ║  courier sim      ║    │ travel-time-  │
  │ solution      │    ║                   ║    │ matrix        │
  │               │    ╚═══════════════════╝    │               │
  │ Build & push  │                             │ H3 precomp    │
  │ ORS Native    │    ┌───────────────────┐    │ city→country  │
  │ App images    │    │ deploy-fleet-     │    │ scale         │
  └───────────────┘    │ intelligence-     │    └───────────────┘
                       │ taxis             │
  ┌───────────────┐    │                   │    ┌───────────────┐
  │ customize-    │    │ 80+ taxi drivers  │    │ deploy-retail │
  │ main          │    │ shift patterns    │    │ -catchment-   │
  │               │    │ control center    │    │ demo          │
  │ Change city,  │    └───────────────────┘    │               │
  │ vehicle type, │                             │ Isochrone     │
  │ map region    │    ┌───────────────────┐    │ trade areas   │
  └───────────────┘    │ deploy-route-     │    │ H3 heatmaps   │
                       │ optimization-     │    │ AI scoring    │
                       │ demo              │    └───────────────┘
                       │                   │
                       │ Multi-vehicle     │
                       │ delivery sim      │
                       │ with Streamlit    │
                       └───────────────────┘
```

## Focus: Food Delivery Skill

```
  ┌─────────────────────────────────────────────────────────────────┐
  │              deploy-fleet-intelligence-food-delivery             │
  ├─────────────────────────────────────────────────────────────────┤
  │                                                                 │
  │   WHAT IT DEPLOYS:                                              │
  │                                                                 │
  │   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐  │
  │   │   ORS   │  │  VROOM  │  │ Gateway │  │  React/Express  │  │
  │   │ Routing │  │Optimizer│  │  API    │  │   SwiftBite UI  │  │
  │   │ Engine  │  │         │  │  Proxy  │  │                 │  │
  │   └────┬────┘  └────┬────┘  └────┬────┘  └───────┬─────────┘  │
  │        └─────────────┴───────────┴────────────────┘            │
  │                           SPCS                                  │
  │                                                                 │
  │   + Overture Maps POIs     + Cortex AI Agent                    │
  │   + Courier Simulation     + Semantic Views                     │
  │   + Multi-City Routing     + Streamlit Dashboard                │
  │   + Native App Package     + One-Click Install                  │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘
```
