# Pydeck Geospatial SQL Rules and Best Practices

## Overview
This document outlines SQL patterns and rules for preparing geospatial data in Snowflake for optimal rendering in Pydeck visualizations, based on lessons learned from the UK Flood Risk Analysis project.

## Core Principles

### 1. Coordinate System Consistency
```sql
-- ✅ GOOD: Always use WGS84 (EPSG:4326) for Pydeck
SELECT ST_ASGEOJSON(ST_TRANSFORM(GEOMETRY, 4326)) as GEOJSON
FROM your_table;

-- ❌ BAD: Using other coordinate systems without transformation
SELECT ST_ASGEOJSON(GEOMETRY) as GEOJSON  -- May be in BNG (EPSG:27700)
FROM your_table;
```

### 2. Table Aliases for Ambiguous Columns
```sql
-- ✅ GOOD: Always use table aliases to avoid ambiguity
SELECT 
    ST_ASGEOJSON(V.GEOG) as GEOJSON,
    ST_X(ST_CENTROID(V.GEOG)) as LON,
    ST_Y(ST_CENTROID(V.GEOG)) as LAT
FROM FLOOD_RISK_AREAS_VIEW V
CROSS JOIN SEARCH_POINT S
WHERE ST_DWITHIN(V.GEOG, S.GEOG, 1000);

-- ❌ BAD: Ambiguous column references
SELECT 
    ST_ASGEOJSON(GEOG) as GEOJSON,  -- Which table's GEOG?
    ST_X(ST_CENTROID(GEOG)) as LON
FROM FLOOD_RISK_AREAS_VIEW V
CROSS JOIN SEARCH_POINT S;
```

## Geometry Type Handling

### Points
```sql
-- ✅ GOOD: Extract coordinates for point data
SELECT 
    OSID,
    ST_ASGEOJSON(GEOGRAPHY) as GEOJSON,
    round(ST_X(ST_CENTROID(GEOGRAPHY)), 5) as LON,
    round(ST_Y(ST_CENTROID(GEOGRAPHY)), 5) as LAT
FROM BUILDINGS
WHERE ST_DWITHIN(GEOGRAPHY, SEARCH_POINT, 1000);
```

**Python Handling:**
```python
# Points render directly - no special handling needed
for _, row in df.iterrows():
    features.append({
        'type': 'Feature',
        'geometry': json.loads(row['GEOJSON']),
        'properties': {'tooltip': f"Building {row['OSID']}"}
    })
```

### Polygons
```sql
-- ✅ GOOD: Handle both Polygon and MultiPolygon
SELECT 
    FRA_ID,
    FLOOD_SOURCE,
    ST_ASGEOJSON(GEOG) as GEOJSON,
    -- Include geometry type for Python processing
    ST_GEOMETRYTYPE(GEOG) as GEOM_TYPE
FROM FLOOD_RISK_AREAS_VIEW
WHERE ST_INTERSECTS(GEOG, BOUNDARY_BOX);
```

**Python Handling:**
```python
# ✅ GOOD: Handle MultiPolygon by flattening
for _, row in flood_df.iterrows():
    geom = json.loads(row['GEOJSON'])
    
    if geom.get('type') == 'MultiPolygon':
        # Flatten MultiPolygon into individual Polygon features
        for polygon_coords in geom['coordinates']:
            flood_features.append({
                'type': 'Feature',
                'geometry': {
                    'type': 'Polygon',
                    'coordinates': polygon_coords
                },
                'properties': {
                    'TOOLTIP': tooltip,
                    'color': color
                }
            })
    else:
        # Handle single Polygon normally
        flood_features.append({
            'type': 'Feature',
            'geometry': geom,
            'properties': {'TOOLTIP': tooltip, 'color': color}
        })
```

### LineStrings
```sql
-- ✅ GOOD: Handle both LineString and MultiLineString
SELECT 
    IDENTIFIER,
    WATERCOURSE_NAME,
    ST_ASGEOJSON(GEOGRAPHY) as GEOJSON,
    ST_GEOMETRYTYPE(GEOGRAPHY) as GEOM_TYPE
FROM OS_UK_WATERCOURSE_LINK
WHERE ST_DWITHIN(GEOGRAPHY, SEARCH_POINT, 1000);
```

**Python Handling:**
```python
# ✅ GOOD: Handle MultiLineString by flattening
for _, row in watercourse_df.iterrows():
    geom = json.loads(row['GEOJSON'])
    
    if geom.get('type') == 'LineString' and geom.get('coordinates'):
        # Single LineString - process normally
        rounded_coords = [[round(p[0], 5), round(p[1], 5)] for p in geom['coordinates']]
        geom['coordinates'] = rounded_coords
        
        watercourse_features.append({
            'type': 'Feature',
            'geometry': geom,
            'properties': {'TOOLTIP': tooltip, 'color': color}
        })
        
    elif geom.get('type') == 'MultiLineString' and geom.get('coordinates'):
        # MultiLineString - create separate features for each line
        for line_coords in geom['coordinates']:
            rounded_coords = [[round(p[0], 5), round(p[1], 5)] for p in line_coords]
            watercourse_features.append({
                'type': 'Feature',
                'geometry': {
                    'type': 'LineString',
                    'coordinates': rounded_coords
                },
                'properties': {'TOOLTIP': tooltip, 'color': color}
            })
```

## Performance Optimization Rules

### 1. Coordinate Rounding
```sql
-- ✅ GOOD: Round coordinates in SQL when possible
SELECT 
    round(ST_X(ST_CENTROID(GEOGRAPHY)), 5) as LON,
    round(ST_Y(ST_CENTROID(GEOGRAPHY)), 5) as LAT
FROM your_table;
```

**Python Complement:**
```python
# ✅ GOOD: Round coordinates to 5 decimal places (~1m precision)
rounded_coords = [[round(p[0], 5), round(p[1], 5)] for p in coordinates]
```

### 2. Spatial Filtering
```sql
-- ✅ GOOD: Use spatial indexes and appropriate distance filters
WITH SEARCH_POINT as (
    SELECT TO_GEOGRAPHY(ST_POINT(lon, lat)) as GEOG
    FROM coordinates
)
SELECT geometry_data
FROM spatial_table S
CROSS JOIN SEARCH_POINT P
WHERE ST_DWITHIN(S.GEOGRAPHY, P.GEOG, 1000)  -- Reasonable distance
LIMIT 1000;  -- Reasonable limit

-- ❌ BAD: No spatial filtering or too large distances
SELECT * FROM spatial_table;  -- Returns everything
```

### 3. Boundary Box Optimization
```sql
-- ✅ GOOD: Create boundary boxes for complex searches
WITH BOUNDARY_BOX as (
    SELECT ST_MAKEPOLYGON(
        TO_GEOGRAPHY('LINESTRING(min_lon min_lat, max_lon min_lat, 
                     max_lon max_lat, min_lon max_lat, min_lon min_lat)')
    ) as BBOX
)
SELECT spatial_data
FROM your_table T
CROSS JOIN BOUNDARY_BOX B
WHERE ST_INTERSECTS(T.GEOGRAPHY, B.BBOX);
```

## Column Naming Conventions

### Standard Column Names
```sql
-- ✅ GOOD: Consistent naming for Pydeck consumption
SELECT 
    ID,                                    -- Unique identifier
    ST_ASGEOJSON(GEOGRAPHY) as GEOJSON,   -- Always name geometry as GEOJSON
    round(ST_X(ST_CENTROID(GEOGRAPHY)), 5) as LON,  -- Longitude
    round(ST_Y(ST_CENTROID(GEOGRAPHY)), 5) as LAT,  -- Latitude
    CATEGORY,                             -- For coloring/grouping
    NAME || ': ' || DESCRIPTION as TOOLTIP -- Pre-formatted tooltip
FROM your_spatial_table;
```

## Error Prevention Patterns

### 1. Handle Missing Geometries
```sql
-- ✅ GOOD: Filter out invalid geometries
SELECT *
FROM spatial_table
WHERE GEOGRAPHY IS NOT NULL 
  AND ST_ISVALID(GEOGRAPHY) = TRUE;
```

### 2. Coordinate Validation
```sql
-- ✅ GOOD: Validate coordinate ranges for WGS84
SELECT *
FROM (
    SELECT 
        *,
        ST_X(ST_CENTROID(GEOGRAPHY)) as LON,
        ST_Y(ST_CENTROID(GEOGRAPHY)) as LAT
    FROM spatial_table
)
WHERE LON BETWEEN -180 AND 180 
  AND LAT BETWEEN -90 AND 90;
```

### 3. Geometry Simplification (Use Carefully)
```sql
-- ⚠️ CAUTION: Only simplify when necessary for performance
SELECT 
    ST_ASGEOJSON(ST_SIMPLIFY(GEOGRAPHY, 0.001)) as GEOJSON  -- ~100m tolerance
FROM complex_polygons
WHERE ST_AREA(GEOGRAPHY) > 1000000;  -- Only for large polygons
```

## Pydeck Layer Configuration

### Points/Scatterplot Layer
```python
pdk.Layer(
    'ScatterplotLayer',
    data=point_df,
    get_position='[LON, LAT]',
    get_radius=100,
    get_fill_color='[255, 0, 0, 160]',
    pickable=True
)
```

### Polygons/GeoJson Layer
```python
pdk.Layer(
    'GeoJsonLayer',
    data={'type': 'FeatureCollection', 'features': polygon_features},
    filled=True,
    get_fill_color='properties.color',
    stroked=True,
    get_line_color=[255, 255, 255, 100],
    line_width_min_pixels=1,
    pickable=True
)
```

### LineStrings/Path Layer
```python
pdk.Layer(
    'GeoJsonLayer',  # Better than PathLayer for complex geometries
    data={'type': 'FeatureCollection', 'features': line_features},
    filled=False,
    stroked=True,
    get_line_color='properties.color',
    line_width_min_pixels=2,
    pickable=True
)
```

## Common Pitfalls and Solutions

### 1. Multi-Geometry Types
```python
# ❌ PROBLEM: Pydeck doesn't render MultiPolygon/MultiLineString well
# ✅ SOLUTION: Always flatten to individual features (see examples above)
```

### 2. Large Datasets
```sql
-- ❌ PROBLEM: Too many features cause browser crashes
-- ✅ SOLUTION: Implement proper limits and spatial filtering
SELECT * FROM spatial_table 
WHERE ST_DWITHIN(GEOGRAPHY, SEARCH_POINT, reasonable_distance)
LIMIT 1000;  -- Adjust based on geometry complexity
```

### 3. Coordinate Precision
```python
# ❌ PROBLEM: Too many decimal places increase payload size
coordinates = [[lon, lat] for lon, lat in raw_coords]

# ✅ SOLUTION: Round to appropriate precision
coordinates = [[round(lon, 5), round(lat, 5)] for lon, lat in raw_coords]
```

### 4. Tooltip Formatting
```sql
-- ✅ GOOD: Pre-format complex tooltips in SQL
SELECT 
    '<b>' || NAME || '</b><br>' ||
    'Type: ' || CATEGORY || '<br>' ||
    'Area: ' || round(ST_AREA(GEOGRAPHY)) || ' m²' as TOOLTIP
FROM spatial_table;
```

## Testing and Validation

### 1. Geometry Validation Query
```sql
-- Use this to check your data before Pydeck rendering
SELECT 
    ST_GEOMETRYTYPE(GEOGRAPHY) as GEOM_TYPE,
    COUNT(*) as COUNT,
    MIN(ST_X(ST_CENTROID(GEOGRAPHY))) as MIN_LON,
    MAX(ST_X(ST_CENTROID(GEOGRAPHY))) as MAX_LON,
    MIN(ST_Y(ST_CENTROID(GEOGRAPHY))) as MIN_LAT,
    MAX(ST_Y(ST_CENTROID(GEOGRAPHY))) as MAX_LAT
FROM your_spatial_table
GROUP BY ST_GEOMETRYTYPE(GEOGRAPHY);
```

### 2. Sample Data Check
```sql
-- Always test with a small sample first
SELECT * FROM your_spatial_query LIMIT 10;
```

## Summary Checklist

- [ ] Use WGS84 coordinate system (EPSG:4326)
- [ ] Include table aliases for all column references
- [ ] Handle MultiPolygon and MultiLineString by flattening
- [ ] Round coordinates to 5 decimal places
- [ ] Implement spatial filtering with reasonable distances
- [ ] Validate geometries and coordinate ranges
- [ ] Limit result sets to prevent browser crashes
- [ ] Pre-format tooltips in SQL when possible
- [ ] Test with small samples before full deployment

## Example Complete Query Pattern

```sql
-- Complete pattern combining all best practices
WITH SEARCH_AREA as (
    SELECT TO_GEOGRAPHY(ST_POINT(longitude, latitude)) as GEOG
    FROM user_input
    LIMIT 1
),
FILTERED_DATA as (
    SELECT 
        T.ID,
        ST_ASGEOJSON(T.GEOGRAPHY) as GEOJSON,
        round(ST_X(ST_CENTROID(T.GEOGRAPHY)), 5) as LON,
        round(ST_Y(ST_CENTROID(T.GEOGRAPHY)), 5) as LAT,
        T.CATEGORY,
        '<b>' || T.NAME || '</b><br>Category: ' || T.CATEGORY as TOOLTIP
    FROM spatial_table T
    CROSS JOIN SEARCH_AREA S
    WHERE ST_DWITHIN(T.GEOGRAPHY, S.GEOG, 1000)
      AND T.GEOGRAPHY IS NOT NULL
      AND ST_ISVALID(T.GEOGRAPHY) = TRUE
    LIMIT 1000
)
SELECT * FROM FILTERED_DATA
ORDER BY ST_DISTANCE(
    TO_GEOGRAPHY(ST_POINT(LON, LAT)), 
    (SELECT GEOG FROM SEARCH_AREA)
);
```

This query template incorporates all the best practices and can be adapted for different spatial data types and use cases.

