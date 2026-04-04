---
name: "intro page control center"
created: "2026-03-25T14:58:06.648Z"
status: pending
---

# Plan: Add Intro Page to ORS Control Center

## Target App

`ors_control_app` -- the React + Express app deployed to SPCS.

## Architecture

```
flowchart LR
    subgraph Snowflake
        ORS["OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO"]
        H3F["H3_POLYGON_TO_CELLS_STRINGS"]
        Table["INTRO_TRIPS table"]
    end
    subgraph ControlCenterApp
        Server["Express /api/query"]
        IntroPage["Intro.tsx"]
        DeckGL["deck.gl Map"]
        H3Layer["H3HexagonLayer (grid)"]
        PathLayer["PathLayer (trips)"]
    end

    ORS -->|"pre-generate 500 routes"| Table
    H3F -->|"on-demand SQL"| Server
    Table -->|"on-demand SQL"| Server
    Server --> IntroPage
    IntroPage --> DeckGL
    DeckGL --> H3Layer
    DeckGL --> PathLayer
```

## Step 1: Create SQL to Pre-Generate 500 Trip Routes

Create a Snowflake table `OPENROUTESERVICE_SETUP.PUBLIC.INTRO_TRIPS` with 500 real ORS-routed trips across San Francisco.

**Approach:**

1. Generate 500 random origin/destination pairs within SF bounding box (lat: 37.700-37.820, lng: -122.520 to -122.350)
2. Call `OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO('driving-car', ...)` for each pair
3. Store: `TRIP_ID`, `ORIGIN_LNG`, `ORIGIN_LAT`, `DEST_LNG`, `DEST_LAT`, `DISTANCE_M`, `DURATION_S`, `ROUTE_COORDS` (JSON array of \[lng, lat] pairs from ST\_ASGEOJSON on the GEOJSON column)

```
CREATE OR REPLACE TABLE OPENROUTESERVICE_SETUP.PUBLIC.INTRO_TRIPS AS
WITH origins AS (
  SELECT 
    SEQ4() AS TRIP_ID,
    UNIFORM(-122.520::FLOAT, -122.350::FLOAT, RANDOM()) AS O_LNG,
    UNIFORM(37.700::FLOAT, 37.820::FLOAT, RANDOM()) AS O_LAT,
    UNIFORM(-122.520::FLOAT, -122.350::FLOAT, RANDOM()) AS D_LNG,
    UNIFORM(37.700::FLOAT, 37.820::FLOAT, RANDOM()) AS D_LAT
  FROM TABLE(GENERATOR(ROWCOUNT => 500))
)
SELECT 
  o.TRIP_ID, o.O_LNG, o.O_LAT, o.D_LNG, o.D_LAT,
  ors.DISTANCE AS DISTANCE_M, ors.DURATION AS DURATION_S,
  ST_ASGEOJSON(ors.GEOJSON)::VARIANT:coordinates AS ROUTE_COORDS
FROM origins o,
  TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS_GEO(
    'driving-car',
    OBJECT_CONSTRUCT('coordinates', ARRAY_CONSTRUCT(
      ARRAY_CONSTRUCT(o.O_LNG, o.O_LAT),
      ARRAY_CONSTRUCT(o.D_LNG, o.D_LAT)
    ))::VARIANT
  )) ors;
```

**Note:** This may need to be batched if ORS rate-limits. We can use a loop of 50 at a time if needed. The table creation is a one-time operation.

## Step 2: Create H3 Grid Query

The H3 grid hexagons covering SF will be fetched on-demand via SQL (not stored in a table) since it's a lightweight query:

```
SELECT VALUE::STRING AS H3_INDEX
FROM TABLE(FLATTEN(
  H3_POLYGON_TO_CELLS_STRINGS(
    TO_GEOGRAPHY('POLYGON((-122.520 37.700, -122.350 37.700, -122.350 37.820, -122.520 37.820, -122.520 37.700))'),
    8
  )
));
```

This returns \~700-1000 hexagons at resolution 8, which `H3HexagonLayer` renders as a transparent grid.

## Step 3: Create Intro.tsx Component

**File:** `src/components/Intro.tsx`

**Layout:** `page-full` with `page-overlay-panel` (same pattern as HeatMap.tsx)

**Features:**

- deck.gl map centered on San Francisco (37.76, -122.44, zoom 12)

- `H3HexagonLayer` rendering res-8 hexagons with transparent fill (e.g., `[41, 181, 232, 30]`) and thin borders

- `PathLayer` rendering trip routes with colored lines

- Overlay panel with:

  - Checkbox: "Show H3 Grid" (default: on)
  - Checkbox: "Show Trips" (default: on)
  - Slider: "Number of Trips: 1-500" (default: 100)

- `useSfQuery` hook for fetching H3 grid data

- `useSfQuery` hook for fetching trip data

- Trip slider controls how many of the 500 rows to display (client-side slicing)

- Uses `cartoBasemap()` from shared helpers

**Key code patterns (following existing conventions):**

```
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import { PathLayer } from '@deck.gl/layers';
import DeckGL from '@deck.gl/react';
import { useSfQuery } from '../hooks/useSnowflake';

// H3 grid layer
new H3HexagonLayer({
  id: 'sf-h3-grid',
  data: hexData,
  getHexagon: (d) => d.H3_INDEX,
  getFillColor: [41, 181, 232, 30],
  getLineColor: [41, 181, 232, 80],
  lineWidthMinPixels: 1,
  filled: true,
  extruded: false,
});

// Trip routes layer
new PathLayer({
  id: 'intro-trips',
  data: trips.slice(0, tripCount),
  getPath: (d) => JSON.parse(d.ROUTE_COORDS),
  getColor: [255, 107, 53, 160],
  getWidth: 2,
  widthMinPixels: 1,
});
```

## Step 4: Wire Into App.tsx

**File:** `src/App.tsx`

Changes:

1. Import the new component:

   ```
   import Intro from './components/Intro';
   ```

2. Add to `DEMO_GROUPS` array (as first item, before Dwell Analysis):

   ```
   { key: 'intro', label: 'Intro', icon: Map },
   ```

   (using `Map` icon from lucide-react)

3. Add render case in `<main>`:

   ```
   {activeTab === 'intro' && <Intro />}
   ```

## Step 5: Build and Test

1. Start dev server: `npm run dev` from the ors\_control\_app directory

2. Verify:

   - "Intro" appears in sidebar under Demos
   - Map renders centered on San Francisco
   - H3 grid overlay shows \~800 transparent hexagons
   - Trip routes render as colored lines following real roads
   - Unchecking "Show H3 Grid" hides hexagons
   - Unchecking "Show Trips" hides routes
   - Slider adjusts visible trip count from 1 to 500

3. Verify no TypeScript errors: `npx tsc --noEmit`

## Files Modified

| File                       | Action                                  |
| -------------------------- | --------------------------------------- |
| New SQL                    | Create `INTRO_TRIPS` table in Snowflake |
| `src/components/Intro.tsx` | New file -- Intro page component        |
| `src/App.tsx`              | Add import, nav entry, render case      |

## Dependencies

- ORS must be running with `driving-car` profile enabled for San Francisco
- `h3-js` package already in `package.json`
- `H3HexagonLayer` already used by HeatMap, CongestionMap, etc.
- No new npm packages required
