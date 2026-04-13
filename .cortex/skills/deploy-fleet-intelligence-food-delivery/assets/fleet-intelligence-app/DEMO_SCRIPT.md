# SwiftBite Fleet Intelligence — High-Impact Demo Script

## Overview

SwiftBite Fleet Intelligence is a Snowflake Native App that simulates a real-time food delivery operations platform. It combines Overture Maps data, OpenRouteService routing, Snowflake Cortex AI, and a real-time operational dashboard — all running inside Snowflake on Snowpark Container Services.

**Duration:** 20–25 minutes
**Audience:** Data leaders, operations teams, executives, Snowflake prospects

---

## PART 1: SETUP (Pre-Demo — 5 min before)

> These steps should be done before the audience joins. The data build takes ~3 minutes.

### 1.1 Open the App

Navigate to the Fleet Intelligence app URL in your browser. You'll see the SwiftBite Fleet Intelligence dashboard with an empty map.

### 1.2 Generate the Data

1. Click **Data Builder** in the top-right header
2. Configure:
   - **City:** San Francisco
   - **Couriers:** 50
   - **Days:** 2
   - **Start Date:** *(yesterday's date)*
   - **Vehicle:** Electric Bike
3. Click **Build Data**
4. Watch the 11-step pipeline execute:
   - Steps 1–2: Real restaurants and addresses pulled live from **Overture Maps** on the Snowflake Marketplace
   - Step 3: 50 couriers created across 5 shift patterns (Breakfast, Lunch, Afternoon, Dinner, Late Night)
   - Step 4: ~1,200 delivery orders generated with realistic timing
   - Step 5: Every single delivery route calculated via **OpenRouteService** running on SPCS — real road-level routing, not straight lines
   - Step 6: Route geometries parsed with cumulative timing
   - Step 7: Courier GPS positions interpolated along actual routes
   - Step 8: **Met Office weather observations** generated — hourly readings across 8 stations. Day 1 has normal weather. Day 2 (today) has a severe weather event: thunderstorms and heavy rain from 10am–4pm
   - Step 9: **Flash flood event** created — two flood zones with geographic polygons in the Mission Creek/SoMa area
   - Step 10: **Delivery incidents** generated — traffic delays, weather delays, and flood-related delays affecting real deliveries
   - Step 11: **Customer complaint calls** generated — realistic phone call records with verbatim comments, sentiment, and resolutions

> **Talking point:** "This entire pipeline runs inside Snowflake. The restaurants are real — pulled from Overture Maps. The routes follow actual roads. The weather, flooding, and customer call data creates a realistic operational scenario that mirrors what delivery companies deal with every day."

### 1.3 Verify the Map

Close the Data Builder. The map should now show delivery routes across San Francisco. You should see:
- A **red flood alert banner** at the top showing the flash flooding incident
- An **incident summary banner** showing delivery delays broken down by type
- Route lines color-coded by courier

---

## PART 2: THE DEMO

### Act 1: "The Operations Dashboard" (3 min)

> Start here. The audience sees the full dashboard for the first time.

**SHOW:** The main dashboard view with routes across San Francisco.

> "This is SwiftBite Fleet Intelligence — a complete food delivery operations platform built entirely as a Snowflake Native App. What you're seeing is real-time delivery operations across San Francisco. Every route on this map follows actual roads — calculated by OpenRouteService, our open-source routing engine running on Snowpark Container Services."

**HOVER** over a delivery route to show the tooltip:
- Courier ID, restaurant, customer address, distance, ETA, status

**POINT OUT** the stats in the left sidebar:
- Total deliveries, active couriers, restaurants, total distance, average delivery time

> "We have 50 couriers on shift, handling over a thousand deliveries across the city. But today is not a normal day..."

**POINT TO** the red flood alert banner at the top.

> "We have a severe weather event. Flash flooding in the Mission Creek area. Let's dig into what's happening."

---

### Act 2: "The Weather Crisis" (5 min)

> This is the money moment. Switch to the AI agent.

**TYPE** into the chat panel:

```
What's the current weather situation? Show me conditions across stations.
```

> The agent queries WEATHER_OBSERVATIONS and returns a table of weather station readings — temperature, wind speed, precipitation, conditions. Stations in the affected area show Heavy Rain/Thunderstorm with high wind and low visibility.

> "The weather data comes from our Met Office feed — hourly observations across 8 stations in San Francisco. You can see the severe conditions concentrated around the central and southern stations."

**WAIT** for the auto-chart to render (it should show a line/bar chart of conditions).

**TYPE:**

```
Tell me about the active flood events
```

> The agent queries FLOOD_MONITORING and returns the flash flood details — Mission Creek Flash Flood (SEVERE), Bayview Basin Overflow (MODERATE), with affected road counts and water levels.

**POINT** to the red flood zone polygon on the map (semi-transparent red area over the Mission Creek/SoMa district).

> "You can see the flood zone right here on the map. This polygon represents the area reported as impassable. Any delivery that routes through this zone is going to be significantly delayed."

**HOVER** over a route that passes near the flood zone — the tooltip should show delay information (e.g., "Delay: flooding (flood zone) — 35 min").

> "See that? This delivery was delayed 35 minutes because the courier couldn't get through. The route was blocked by surface water flooding."

---

### Act 3: "Impact on Operations" (5 min)

> Now show the business impact.

**TYPE:**

```
How many deliveries have been delayed today? Break down by cause.
```

> The agent queries DELIVERY_INCIDENTS grouped by type, showing counts and average delays for traffic, weather, and flooding.

> "So we've got three categories of delay. Normal traffic delays — that's business as usual. Weather delays from the heavy rain slowing couriers down. And then the flood-related delays — those are the severe ones, averaging 25–35 minutes."

**TYPE:**

```
Show me customer calls about flood delays. What are people saying?
```

> The agent queries CUSTOMER_CALLS filtered to flood delays, returning call times, customer names, sentiment, and actual verbatim comments like "My order from Mission Burrito is very late. The driver says the road is flooded and they cannot get through."

> "These are actual customer interactions. Look at the sentiment — mostly frustrated and angry. These are the calls that damage your brand. The customer doesn't care about the weather — they care about their food arriving."

**TYPE:**

```
What percentage of flood-affected customers received a refund or discount?
```

> The agent breaks down resolutions: refund issued, discount offered, apology and ETA provided, etc.

> "So we're compensating about 40% of affected customers with refunds or discounts. That's real cost. With this data, the operations team can quantify the exact financial impact of a weather event — and build that into their contingency planning."

---

### Act 4: "Filtering & Exploration" (2 min)

> Show the interactive map controls.

**TYPE:**

```
Show me all deliveries from Starbucks on the map
```

> The agent uses the fleet_map_control tool. The map filters to show only Starbucks delivery routes. Routes for other restaurants fade out.

> "The agent doesn't just answer questions — it controls the dashboard. I asked it to show Starbucks deliveries and it filtered the map in real-time."

**TYPE:**

```
Now show me all bicycle couriers
```

> Map filters to bicycle vehicle type.

**TYPE:**

```
Reset the map to show everything
```

> Map returns to showing all routes.

**Switch to Heatmap mode** (click the "Heatmap" button on the map controls).

> "We can also look at delivery density. This heatmap shows where the concentration of deliveries is highest. You can see the hotspots in the downtown and Mission areas — which, unfortunately, overlaps with our flood zone today."

**Switch back to Routes mode.**

---

### Act 5: "Planning Ahead — Weather Forecasts" (2 min)

**TYPE:**

```
What does the weather forecast look like for the next 3 days?
```

> The agent queries WEATHER_FORECASTS and returns upcoming conditions — showing improving weather.

> "This is where it gets strategic. The forecast shows conditions improving tomorrow. Operations can use this to plan staffing — increase courier count today to absorb delays, then return to normal tomorrow. This is Cortex AI turning raw weather data into operational decisions."

---

### Act 6: "Pre-Computed Delivery Time Matrix" (5 min)

> This is the technical crescendo. Switch to the Matrix Builder.

**Click "Matrix Builder"** in the header.

> "Everything we've shown so far is reactive — responding to what's happening now. But what if you could pre-compute delivery times across the entire city? That's what the Travel Time Matrix does."

**Configure:**
- **Region:** San Francisco
- **Vehicle:** Electric Bike
- **Resolutions:** Check 7 and 8 (start with coarse)

> "We're going to tessellate San Francisco into H3 hexagons at two resolutions, then compute the actual driving time between every pair using OpenRouteService. Resolution 7 gives us neighborhood-level granularity. Resolution 8 gives us block-level."

**Click "Build Matrix"** and watch the progress:
- Building hexagons
- Creating work queue
- Computing travel times (shows pairs processed, progress %, ETA)

> "This is computing thousands of origin-destination pairs. Each one is a real route calculation — not a straight-line estimate. And it's all happening inside Snowflake on SPCS."

**When complete (or if pre-built), click "Matrix" mode** on the map.

> The map transforms to show H3 hexagons across San Francisco, colored by average travel time from that cell to all reachable destinations.

> "Now every hexagon on this map represents a potential origin point. The color shows average travel time to all reachable destinations."

**CLICK a hexagon** in a busy area.

> The view zooms in and shows the reachability zone — hexagons colored by travel time from that specific origin. Restaurant icons appear with delivery counts.

> "I clicked a hexagon downtown. Now I can see: from this point, where can a courier reach in 5, 10, 15, 20 minutes? The green hexagons are close. The red ones are far. And I can see exactly which restaurants are within each time band."

**POINT** to the Catchment Panel on the right side — showing restaurants sorted by drive time, active orders, delivery counts.

> "The catchment panel breaks it down: which restaurants are within our drive-time threshold, how many orders each one has, which have active deliveries. This is instant — no route calculation needed, because we've pre-computed the entire matrix."

> "For a delivery platform, this is game-changing. You can optimise courier positioning, predict delivery times before orders are placed, and identify underserved areas — all using pre-computed travel times that account for actual road networks, not just distance."

---

## PART 3: THE CLOSE (1 min)

> Summarise the technology stack.

> "So what did we just see?
>
> - **Overture Maps** providing real restaurant and address data from the Snowflake Marketplace
> - **OpenRouteService** running on SPCS for actual road-level routing
> - **Met Office-style weather data** creating a realistic operational scenario
> - **Cortex AI agent** providing natural language access to all of this data — querying, charting, and controlling the map
> - **Pre-computed travel time matrix** using H3 hexagons for instant catchment analysis
>
> Every single piece of this runs inside Snowflake. The compute, the routing engine, the AI, the app itself — all Native App, all SPCS, all Snowflake."

---

## APPENDIX: Quick Agent Prompts

Here are tested prompts that produce strong results:

| Prompt | What it shows |
|--------|---------------|
| `How many deliveries were made today?` | Basic fleet stats with auto-chart |
| `What's the busiest restaurant by order count?` | Restaurant analytics |
| `Show me the weather conditions over the last 24 hours` | Weather time-series with chart |
| `Which couriers were affected by flooding?` | Flood impact on specific couriers |
| `How many customer complaints are flood-related vs traffic-related?` | Incident comparison |
| `What's the average delay for flood-affected deliveries vs normal?` | Quantified impact |
| `Show angry customer calls from today` | Sentiment filtering |
| `Show all deliveries for courier SAN-0012 on the map` | Map filter by courier |
| `What's the forecast for tomorrow?` | Future planning |
| `Which shift has the most delays?` | Shift-based analysis |
| `Show me Italian restaurants on the map` | Cuisine filter |

## APPENDIX: Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 Snowflake Native App                     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  React UI    │  │  Express     │  │  Cortex      │  │
│  │  (deck.gl    │  │  Server      │  │  Agent       │  │
│  │   maplibre)  │  │  (Node.js)   │  │  (Claude)    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                  │           │
│         ▼                 ▼                  ▼           │
│  ┌──────────────────────────────────────────────────┐   │
│  │              Snowflake SQL Engine                 │   │
│  │  ┌────────┐ ┌─────────┐ ┌──────────┐ ┌───────┐  │   │
│  │  │Delivery│ │Weather  │ │  Flood   │ │Customer│  │   │
│  │  │Summary │ │Obs/Fcst │ │Monitoring│ │ Calls  │  │   │
│  │  └────────┘ └─────────┘ └──────────┘ └───────┘  │   │
│  │  ┌────────────────────┐ ┌──────────────────┐     │   │
│  │  │ Travel Time Matrix │ │Delivery Incidents│     │   │
│  │  │  (H3 Hexagons)     │ └──────────────────┘     │   │
│  │  └────────────────────┘                           │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │        SPCS Services                              │   │
│  │  ┌─────────────┐  ┌───────┐  ┌────────────────┐  │   │
│  │  │OpenRoute    │  │ VROOM │  │  Reverse Proxy │  │   │
│  │  │Service (ORS)│  │       │  │  (Routing GW)  │  │   │
│  │  └─────────────┘  └───────┘  └────────────────┘  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Snowflake Marketplace                            │   │
│  │  ├── Overture Maps Places (Restaurants)           │   │
│  │  ├── Overture Maps Addresses (Customers)          │   │
│  │  └── Met Office Weather Data (simulated)          │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```
