# Maps & Locations Reference

## Default Supported Cities (Built Into App)

These 11 cities are pre-configured. Selecting a new city in the app auto-provisions ORS routing and downloads the map on demand.

| Location | Country | State | Center LON | Center LAT | ORS Region | BBBike PBF Name |
|----------|---------|-------|------------|------------|------------|-----------------|
| **San Francisco** | US | CA | -122.44 | 37.76 | SanFrancisco | `SanFrancisco` |
| **Los Angeles** | US | CA | -118.24 | 34.05 | LosAngeles | `LosAngeles` |
| **San Jose** | US | CA | -121.89 | 37.34 | SanJose | `SanJose` |
| **Sacramento** | US | CA | -121.49 | 38.58 | Sacramento | `Sacramento` |
| **Santa Barbara** | US | CA | -119.70 | 34.42 | SantaBarbara | `SantaBarbara` |
| **Stockton** | US | CA | -121.29 | 37.97 | Stockton | `Stockton` |
| **New York** | US | NY | -73.98 | 40.71 | NewYork | `NewYork` |
| **Chicago** | US | IL | -87.73 | 41.83 | Chicago | `Chicago` |
| **London** | GB | | -0.09 | 51.51 | London | `London` |
| **Paris** | FR | | 2.35 | 48.86 | Paris | `Paris` |
| **Berlin** | DE | BE | 13.40 | 52.52 | Berlin | `Berlin` |

## City-Specific vs Generic ORS Functions

> **CRITICAL:** The ORS app creates both generic and city-specific functions. Generic functions route to the DEFAULT ORS service which only has the Karlsruhe (Germany) test graph. Always use city-specific functions for actual data.

| Function Pattern | Routes To | Use When |
|-----------------|-----------|----------|
| `ROUTING.DIRECTIONS_{CITY}()` | City-specific ORS service | **Always use this** for routing |
| `ROUTING.DIRECTIONS()` | Default ORS (Karlsruhe) | Never use for production data |
| `ROUTING.MATRIX_{CITY}()` | City-specific ORS service | **Always use this** for matrix calculations |
| `ROUTING.MATRIX_TABULAR()` | Default ORS (Karlsruhe) | Never use for production data |
| `ROUTING.MATRIX()` | Default ORS (Karlsruhe) | Never use for production data |

Where `{CITY}` is the ORS Region name in PascalCase with no spaces (e.g., `SanFrancisco`, `London`, `NewYork`).

Example:
```sql
SELECT FLEET_INTELLIGENCE_APP.ROUTING.DIRECTIONS_SANFRANCISCO(
    'driving-car',
    ARRAY_CONSTRUCT(-122.44, 37.76),
    ARRAY_CONSTRUCT(-122.42, 37.78)
);

SELECT FLEET_INTELLIGENCE_APP.ROUTING.MATRIX_SANFRANCISCO(
    'driving-car',
    ARRAY_CONSTRUCT(-122.44, 37.76),
    ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(-122.42, 37.78), ARRAY_CONSTRUCT(-122.40, 37.74))
);
```

## Adding Additional Cities (Before Docker Build)

Only needed for cities NOT in the default list above. Must be done before Step 12 Docker image build.

**1. Verify city exists on BBBike:**
```
URL: https://download.bbbike.org/osm/bbbike/
```
PBF URL pattern: `https://download.bbbike.org/osm/bbbike/{CityName}/{CityName}.osm.pbf`
City names: PascalCase, no spaces (e.g., `SanDiego`, `Toronto`, `Sydney`).

**2. If found**, add to `CITY_ORS_MAP` in `server/index.ts`:
```typescript
'{city_key}': {
  pbfUrl: 'https://download.bbbike.org/osm/bbbike/{CityName}/{CityName}.osm.pbf',
  bounds: [[{sw_lon}, {sw_lat}], [{ne_lon}, {ne_lat}]],
  center: [{center_lon}, {center_lat}],
  zoom: 12,
  country: '{COUNTRY_CODE}',
  state: '{STATE_CODE}',
}
```
Also add the city to the Overture Maps filter table below.

**3. If NOT found**, check Geofabrik at `https://download.geofabrik.de/` for region-level PBF files.

**4. Do NOT download the map.** It is downloaded automatically by the app's downloader service when `ROUTING.CREATE_CITY_ORS_SERVICE('{CityName}')` is called. 

## Overture Maps Filters by City

| City | Places Filter | Addresses Filter |
|------|--------------|------------------|
| California cities | `ADDRESSES[0]:country::STRING = 'US' AND ADDRESSES[0]:region::STRING = 'CA'` | `COUNTRY = 'US' AND ADDRESS_LEVELS[0]:value::STRING = 'CA'` |
| New York | `ADDRESSES[0]:country::STRING = 'US' AND ADDRESSES[0]:region::STRING = 'NY'` | `COUNTRY = 'US' AND ADDRESS_LEVELS[0]:value::STRING = 'NY'` |
| Chicago | `ADDRESSES[0]:country::STRING = 'US' AND ADDRESSES[0]:region::STRING = 'IL'` | `COUNTRY = 'US' AND ADDRESS_LEVELS[0]:value::STRING = 'IL'` |
| London | `ADDRESSES[0]:country::STRING = 'GB'` | `COUNTRY = 'GB'` |
| Paris | `ADDRESSES[0]:country::STRING = 'FR'` | `COUNTRY = 'FR'` |
| Berlin | `ADDRESSES[0]:country::STRING = 'DE'` | `COUNTRY = 'DE'` |

For US cities, use state code. For international, use country code only.

## Vehicle Types

| UI Label | ORS Profile | Description |
|----------|-------------|-------------|
| E-Bike | `cycling-electric` | Electric bicycle (default) |
| Car | `driving-car` | Standard car driving |
| HGV | `driving-hgv` | Heavy goods vehicle routing |
| Bicycle | `cycling-regular` | Regular cycling |
| Road Bike | `cycling-road` | Road cycling |
| Walking | `foot-walking` | Pedestrian routing |

- One vehicle type per data build — all couriers use the same type
- Matrix builds support one vehicle type per build; different type **appends** data
- Travel time matrix tables include `VEHICLE_TYPE` column when applicable
