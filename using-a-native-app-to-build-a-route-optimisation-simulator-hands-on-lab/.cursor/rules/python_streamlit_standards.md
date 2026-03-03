## Python and Streamlit Development Standards

### Python/Streamlit Development
- Use Snowpark DataFrame API instead of raw SQL where possible
- Implement `@st.cache_data` for expensive operations (Cortex calls, data transformations)
- Follow Streamlit best practices:
  - Use `st.set_page_config(layout="wide")` for data-heavy apps
  - Implement proper error handling for API calls
  - Use columns and containers for layout organization
- Leverage `snowflake.snowpark.functions` for data transformations
- Use proper type casting with Snowpark types (`FloatType`, `StringType`, `IntegerType`)

### Geospatial & Routing Code
- Use Snowflake geospatial functions: `ST_MAKEPOINT`, `ST_DISTANCE`, `ST_WITHIN`, `ST_DWITHIN`
- Handle coordinate order correctly (LON, LAT for arrays; LAT, LON for some visualizations)
- Cache routing and optimization results to avoid redundant API calls
- Implement isochrone analysis for catchment area calculations

#### Snowpark geospatial function calls (mandatory pattern)
- In Snowpark DataFrame transformations, always call geospatial and scalar SQL functions using `call_function(...)` with `col(...)` and `lit(...)`:

```python
# Length of a GEOGRAPHY/GEOMETRY route
df = df.with_column('DISTANCE_M', call_function('ST_LENGTH', col('GEOMETRY')))

# Extract lon/lat from a point geometry
points = points.with_column('LON', call_function('ST_X', col('POINT_GEOM')))
points = points.with_column('LAT', call_function('ST_Y', col('POINT_GEOM')))

# Directions example using ORS native app; pass literals/columns explicitly
driver_locations = driver_locations.with_column(
    'DIRECTIONS',
    call_function(
        'OPEN_ROUTE_SERVICE_NEW_YORK.CORE.DIRECTIONS',
        lit('driving-car'),
        call_function('ST_ASGEOJSON', col('ORIGIN'))['coordinates'],
        call_function('ST_ASGEOJSON', col('POINT_GEOM'))['coordinates'],
    ),
)

# Compute centroid of an envelope around two points
center = selected_trip.with_column(
    'CENTER',
    call_function(
        'ST_CENTROID',
        call_function('ST_ENVELOPE', call_function('ST_COLLECT', col('ORIGIN'), col('DESTINATION'))),
    ),
)
center = center.with_column('LON', call_function('ST_X', col('CENTER')))
center = center.with_column('LAT', call_function('ST_Y', col('CENTER')))
```

- When writing raw SQL strings via `session.sql(...)`, you can use native `ST_*` directly in the SQL (e.g., `ST_X(point_geom)`, `ST_Y(point_geom)`, `ST_ASGEOJSON(...)`).

### Route Geometry Extraction from OPTIMIZATION Service
```python
# Check geometry exists and prepare for PyDeck PathLayer
if not route_details_df.to_pandas().empty:
    first_geometry = route_details_df.select(col('GEOMETRY')).collect()[0][0]
    if first_geometry is not None:
        optimized_route_geometry = route_details_df.select('VEHICLE_ID', col('GEOMETRY').alias('GEO'))
        optimized_route_geometry = optimized_route_geometry.with_column('GEO', object_construct(lit('coordinates'), col('GEO')))
        vehicle_colors_df = session.create_dataframe([
            {'VEHICLE_ID': vid, 'R': colors[0], 'G': colors[1], 'B': colors[2]} for vid, colors in vehicle_colors.items()
        ])
        optimized_route_geometry = optimized_route_geometry.join(vehicle_colors_df, 'VEHICLE_ID')
        data_for_map = optimized_route_geometry.select('GEO', 'VEHICLE_ID', 'R', 'G', 'B').to_pandas()
        data_for_map["coordinates"] = data_for_map["GEO"].apply(lambda row: json.loads(row)["coordinates"])
        route_coordinates = data_for_map[['VEHICLE_ID', 'coordinates', 'R', 'G', 'B']].copy()
        route_paths_layer = pdk.Layer(
            type="PathLayer",
            data=route_coordinates,
            pickable=True,
            get_color=["R", "G", "B"],
            width_min_pixels=4,
            width_max_pixels=7,
            get_path="coordinates",
            get_width=5
        )
```

### Performance Optimization
- Use `.cache_result()` for intermediate Snowpark DataFrames
- Sample or limit large datasets appropriately
- Cache expensive operations like Cortex completions
- Use window functions efficiently for ranking and aggregation
- Optimize geospatial queries with appropriate indexing


### Geospatial visualization with PyDeck (required patterns)

- Always use PyDeck layers for geospatial rendering; avoid ad‑hoc plotting.
- Prepare data columns explicitly for each layer type and keep coordinate order as [lon, lat].

#### LineStrings and paths (PathLayer)
- Data requirement: a column named `coordinates` with an array of `[lon, lat]` pairs.
- If geometry is stored as GeoJSON string, extract `coordinates` in pandas:

```python
routespd = routes.to_pandas()
routespd["coordinates"] = routespd["GEOMETRY"].apply(lambda row: json.loads(row)["coordinates"])

route_layer = pdk.Layer(
    type="PathLayer",
    data=routespd,
    get_path="coordinates",
    get_color=[253, 180, 107],
    get_width=5,
    width_min_pixels=4,
    width_max_pixels=7,
    pickable=False,
)
```

#### H3 choropleths (H3HexagonLayer)
- Data requirement: a column named `H3` (cell index string) and optional color column.

```python
hex_layer = pdk.Layer(
    "H3HexagonLayer",
    hex_df,
    id="hexes",
    get_hexagon="H3",
    get_fill_color="COLOR",
    get_line_color="COLOR",
    extruded=False,
    coverage=1,
    opacity=0.3,
    pickable=True,
)
```

#### Points (ScatterplotLayer)
- Data requirement: a column with `[lon, lat]` list, e.g., `POSITION`, or explicit `get_position=['LON','LAT']`.

```python
points_layer = pdk.Layer(
    "ScatterplotLayer",
    point_df,
    id="drivers",
    get_position="POSITION",
    get_fill_color=[0, 0, 0, 160],
    get_radius=30,
    pickable=True,
    auto_highlight=True,
    opacity=0.8,
)
```

#### Tooltips and view state
- Keep tooltips simple HTML with a single `{TOOLTIP}` placeholder that maps to a string column.

```python
tooltip = {
    "html": "{TOOLTIP}",
    "style": {"backgroundColor": "#24323D", "color": "white"},
}

deck = pdk.Deck(
    map_provider="carto",
    map_style="light",
    initial_view_state=pdk.ViewState(latitude=lat, longitude=lon, zoom=10),
    layers=[hex_layer, points_layer, route_layer],
    tooltip=tooltip,
)
st.pydeck_chart(deck, use_container_width=True)
```

#### Layering and styling rules
- Order layers back‑to‑front: H3 → routes (PathLayer) → points (Scatterplot).
- Use consistent widths for paths (`get_width=5`, clamped by `width_min_pixels`/`width_max_pixels`).
- For start/end/current markers, use distinct colors (e.g., red/green/current blue) and fixed radii.

#### Polygons (PolygonLayer)
- Data requirement: a column named `coordinates` containing a GeoJSON polygon coordinate array (list of linear rings).
- Transform in Snowpark, then extract coordinates in pandas to ensure visibility.

Snowpark → GeoJSON → pandas extraction:

```python
# 1) Get polygon GeoJSON from a function (e.g., ISOCHRONE)
isochrone_result = isochrone_df.select(
    call_function(f"{route_functions_option}.CORE.ISOCHRONES", (col('METHOD'), col('LON'), col('LAT'), col('RANGE_MINS'))).alias('ISOCHRONE')
)

# 2) Convert first feature geometry to GEOGRAPHY and cache
isochrone_geo = isochrone_result.select(
    to_geography(col('ISOCHRONE')['features'][0]['geometry']).alias('GEO')
).cache_result()

# 3) Move to pandas and extract the nested coordinates array for PolygonLayer
isochrone_pd = isochrone_geo.select('GEO').to_pandas()
isochrone_pd['coordinates'] = isochrone_pd['GEO'].apply(lambda row: json.loads(row)['coordinates'])

# 4) Render polygon with outline and fill
isochrone_layer = pdk.Layer(
    'PolygonLayer',
    isochrone_pd,
    opacity=0.7,
    get_polygon='coordinates',
    filled=True,
    get_line_color=[41, 181, 232],
    get_fill_color=[200, 230, 242],
    get_line_width=10,
    line_width_min_pixels=6,
    auto_highlight=True,
    pickable=False,
)
```

Notes:
- If the geometry is a MultiPolygon, select/flatten the desired part before conversion or explode in pandas.
- Ensure coordinate order is [lon, lat]; GeoJSON from Snowflake follows this convention.


