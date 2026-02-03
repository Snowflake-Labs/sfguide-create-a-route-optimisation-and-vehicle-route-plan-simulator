import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import json
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.functions import col, call_function, lit

# Initialize Snowflake session
session = get_active_session()

# Page configuration
st.set_page_config(
    page_title="UK Flood Risk Areas",
    page_icon="🌊",
    layout="wide"
)

# Load Snowflake branding CSS and logo
try:
    with open('extra.css') as f:
        st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)
except Exception:
    pass

try:
    st.logo('logo.svg')
except Exception:
    pass

st.markdown('<h0black>UK |</h0black><h0blue> FLOOD RISK AREAS</h0blue><BR><h1grey>Building flood risk analysis for Exeter</h1grey>', unsafe_allow_html=True)

# Demo postcodes for Exeter - all 3 risk levels
DEMO_POSTCODES = [
    ('EX4 4GX', 'All 3 levels: 46K High + 26K Moderate + 158K None'),
    ('EX4 6TJ', 'All 3 levels: 9K High + 82K Moderate + 12K None'), 
    ('EX2 4LU', 'All 3 levels: 144 High + 57K Moderate + 290 None'),
    ('EX2 4SJ', 'All 3 levels: 9K High + 13K Moderate + 27K None'),
    ('EX2 5LF', 'Rivers and Sea only (High + None)')
]

with st.sidebar:
    st.markdown('<h1sub>🎛️ Controls</h1sub>', unsafe_allow_html=True)
    
    st.markdown('**Demo postcodes (Exeter)**')
    selected_demo = st.selectbox('Choose demo:', [f"{pc} ({desc})" for pc, desc in DEMO_POSTCODES])
    demo_pc = selected_demo.split(' (')[0] if selected_demo else ''
    
    st.markdown('**Or enter postcode:**')
    manual_pc = st.text_input('Postcode', placeholder='EX2 5LF')
    
    distance_m = st.slider('Search distance (meters)', 50, 1000, 100, 25)
    building_opacity = st.slider('Building opacity', 50, 255, 150)
    
    st.markdown('**Map Layers**')
    show_flood_areas = st.checkbox('Show Flood Risk Areas', value=True)
    show_watercourses = st.checkbox('Show Watercourses', value=False)

# Auto-determine search postcode
search_pc = manual_pc.strip() if manual_pc.strip() else demo_pc

# Cached data functions
@st.cache_data(show_spinner="Loading flood areas...")
def get_flood_areas(postcode, distance_meters):
    """Get flood risk areas near the search location"""
    if not postcode:
        return pd.DataFrame()
    
    session = get_active_session()
    sql = f"""
        with SEARCH_POINT as (
            select TO_GEOGRAPHY(ST_POINT(LONGITUDE, LATITUDE)) as GEOG
            from UK_STORMS_DB.PUBLIC.OS_UK_ADDRESSES 
            where POSTCODE = '{postcode.upper().replace("'", "''")}'
            limit 1
        )
    select 
        FRA_ID,
        FLOOD_SOURCE,
         ST_ASGEOJSON(V.GEOG) as GEOJSON,
         round(ST_X(ST_CENTROID(V.GEOG)), 6) as CENTROID_LON,
         round(ST_Y(ST_CENTROID(V.GEOG)), 6) as CENTROID_LAT
    from UK_STORMS_DB.PUBLIC.FLOOD_RISK_AREAS_VIEW V
    cross join SEARCH_POINT S
    where ST_DWITHIN(V.GEOG, S.GEOG, {distance_meters})
    limit 100
    """
    
    try:
        return session.sql(sql).to_pandas()
    except Exception:
        return pd.DataFrame()

@st.cache_data(show_spinner="Loading watercourses...")
def get_watercourses(postcode, distance_meters):
    """Get watercourses near the search location"""
    if not postcode:
        return pd.DataFrame()
    
    session = get_active_session()
    sql = f"""
    with SEARCH_AREA as (
        select 
            min(LONGITUDE) - 0.02 as MIN_LON,
            max(LONGITUDE) + 0.02 as MAX_LON,
            min(LATITUDE) - 0.02 as MIN_LAT,
            max(LATITUDE) + 0.02 as MAX_LAT
        from UK_STORMS_DB.PUBLIC.OS_UK_ADDRESSES 
        where POSTCODE = '{postcode.upper().replace("'", "''")}'
    )
    select 
        ID as IDENTIFIER,
        WATERCOURSE_NAME,
        ST_ASGEOJSON(W.GEOGRAPHY) as GEOJSON,
        round(ST_X(ST_CENTROID(W.GEOGRAPHY)), 6) as CENTROID_LON,
        round(ST_Y(ST_CENTROID(W.GEOGRAPHY)), 6) as CENTROID_LAT
    from UK_STORMS_DB.PUBLIC.OS_UK_WATERCOURSE_LINK W
    cross join SEARCH_AREA S
    where ST_X(ST_CENTROID(W.GEOGRAPHY)) between S.MIN_LON and S.MAX_LON
      and ST_Y(ST_CENTROID(W.GEOGRAPHY)) between S.MIN_LAT and S.MAX_LAT
    limit 200
    """
    
    try:
        return session.sql(sql).to_pandas()
    except Exception:
        return pd.DataFrame()

@st.cache_data(show_spinner="Searching buildings...")
def search_buildings(postcode: str, distance: int):
    if not postcode:
        return pd.DataFrame()
        
    norm_pc = postcode.upper().replace(' ', '')
    
    sql = f"""
    with A as (
        select GEOGRAPHY as GEOM, POSTCODE, FULLADDRESS
            from UK_STORMS_DB.PUBLIC.OS_UK_ADDRESSES
            where POSTCODE = '{postcode.replace("'", "''")}'
    ), B as (
        select distinct
            B.OSID,
            ST_ASGEOJSON(B.GEOGRAPHY) as GEOJSON,
            B.BUILDINGUSE,
            B.NUMBEROFFLOORS,
            B.GEOMETRY_AREA_M2,
             'Unknown' as CONSTRUCTIONMATERIAL,
            B.BUILDINGAGE_PERIOD,
            ANY_VALUE(A.FULLADDRESS || ' ' || A.POSTCODE) as ADDRESS_TEXT
        from UK_STORMS_DB.PUBLIC.OS_BUILDINGS B, A
        where ST_DWITHIN(B.GEOGRAPHY, A.GEOM, {distance})
        group by B.OSID, ST_ASGEOJSON(B.GEOGRAPHY), B.BUILDINGUSE, B.NUMBEROFFLOORS, B.GEOMETRY_AREA_M2, B.BUILDINGAGE_PERIOD
        limit 10000
    ), F as (
        select 
            B.OSID,
            max(case when V.FLOOD_SOURCE = 'Rivers and Sea' then 1 else 0 end) as HAS_RIVER_SEA,
            max(case when V.FLOOD_SOURCE = 'Surface Water' then 1 else 0 end) as HAS_SURFACE
        from B
        left join UK_STORMS_DB.PUBLIC.FLOOD_RISK_AREAS_VIEW V on ST_INTERSECTS(TO_GEOGRAPHY(B.GEOJSON), V.GEOG)
        group by B.OSID
    ), H3_WATER as (
        select 
            H3_POINT_TO_CELL_STRING(ST_CENTROID(W.GEOGRAPHY), 9) as H3_CELL,
            1 as HAS_WATERCOURSE
        from UK_STORMS_DB.PUBLIC.OS_UK_WATERCOURSE_LINK W
        group by H3_CELL
    ), W as (
        select 
            B.OSID,
            max(H3_WATER.HAS_WATERCOURSE) as NEAR_WATERCOURSE
        from B
        left join H3_WATER on H3_POINT_TO_CELL_STRING(ST_CENTROID(TO_GEOGRAPHY(B.GEOJSON)), 9) = H3_WATER.H3_CELL
        group by B.OSID
    ), DISTANCES as (
        select 
            B.OSID,
            -- Distance to nearest watercourse (0-1000m, inverted scoring)
            coalesce(min(ST_DISTANCE(TO_GEOGRAPHY(B.GEOJSON), W.GEOGRAPHY)), 1000) as NEAREST_WATERCOURSE_M,
            -- Distance to nearest surface water flood area
            coalesce(min(case when V.FLOOD_SOURCE = 'Surface Water' then ST_DISTANCE(TO_GEOGRAPHY(B.GEOJSON), V.GEOG) end), 1000) as NEAREST_SURFACE_WATER_M,
            -- Distance to nearest river/sea flood area  
            coalesce(min(case when V.FLOOD_SOURCE in ('River', 'Sea') then ST_DISTANCE(TO_GEOGRAPHY(B.GEOJSON), V.GEOG) end), 1000) as NEAREST_RIVER_SEA_M
        from B
        left join UK_STORMS_DB.PUBLIC.OS_UK_WATERCOURSE_LINK W on ST_DWITHIN(TO_GEOGRAPHY(B.GEOJSON), W.GEOGRAPHY, 1000)
        left join UK_STORMS_DB.PUBLIC.FLOOD_RISK_AREAS_VIEW V on ST_DWITHIN(TO_GEOGRAPHY(B.GEOJSON), V.GEOG, 1000)
        group by B.OSID
    ), SCORES as (
        select 
            D.OSID,
            D.NEAREST_WATERCOURSE_M,
            D.NEAREST_SURFACE_WATER_M,
            D.NEAREST_RIVER_SEA_M,
            -- Scoring system (higher score = higher risk)
            -- Watercourse proximity: 0-50 points (closer = more points)
            greatest(0, 50 - round(D.NEAREST_WATERCOURSE_M / 20)) as WATERCOURSE_SCORE,
            -- Surface water proximity: 0-100 points (closer = more points)  
            greatest(0, 100 - round(D.NEAREST_SURFACE_WATER_M / 10)) as SURFACE_WATER_SCORE,
            -- River/Sea proximity: 0-150 points (closer = more points, highest weight)
            greatest(0, 150 - round(D.NEAREST_RIVER_SEA_M / 6.67)) as RIVER_SEA_SCORE
        from DISTANCES D
    ), R as (
        select 
            S.OSID,
            S.NEAREST_WATERCOURSE_M,
            S.NEAREST_SURFACE_WATER_M, 
            S.NEAREST_RIVER_SEA_M,
            S.WATERCOURSE_SCORE,
            S.SURFACE_WATER_SCORE,
            S.RIVER_SEA_SCORE,
            -- Total risk score (0-300 points possible)
            (S.WATERCOURSE_SCORE + S.SURFACE_WATER_SCORE + S.RIVER_SEA_SCORE) as TOTAL_SCORE,
            -- Risk level based on score ranges
            case 
                when (S.WATERCOURSE_SCORE + S.SURFACE_WATER_SCORE + S.RIVER_SEA_SCORE) >= 200 then 'High'
                when (S.WATERCOURSE_SCORE + S.SURFACE_WATER_SCORE + S.RIVER_SEA_SCORE) >= 100 then 'Moderate'
                when (S.WATERCOURSE_SCORE + S.SURFACE_WATER_SCORE + S.RIVER_SEA_SCORE) >= 25 then 'Low'
                else 'None'
            end as RISK
        from SCORES S
    )
    select B.*, R.RISK, R.TOTAL_SCORE, R.WATERCOURSE_SCORE, R.SURFACE_WATER_SCORE, R.RIVER_SEA_SCORE,
           R.NEAREST_WATERCOURSE_M, R.NEAREST_SURFACE_WATER_M, R.NEAREST_RIVER_SEA_M
    from B join R on B.OSID = R.OSID
    """
    
    try:
        return session.sql(sql).to_pandas()
    except Exception:
        return pd.DataFrame()

# Auto-search when postcode is available
if search_pc:
    bld_df = search_buildings(search_pc, distance_m)
    
    # Load additional layers based on toggles
    flood_df = get_flood_areas(search_pc, distance_m) if show_flood_areas else pd.DataFrame()
    watercourse_df = get_watercourses(search_pc, distance_m) if show_watercourses else pd.DataFrame()
    
    if not bld_df.empty:
        layer_info = [f'{len(bld_df)} buildings']
        if show_flood_areas and not flood_df.empty:
            layer_info.append(f'{len(flood_df)} flood areas')
        if show_watercourses and not watercourse_df.empty:
            layer_info.append(f'{len(watercourse_df)} watercourses')
        st.success(f'Found {" + ".join(layer_info)} near {search_pc}')
        
        # Map with buildings
        col_map, col_info = st.columns([3, 1])
        
        with col_map:
            # Build map layers
            layers = []
            
            # Buildings layer
            bld_features = []
            for _, row in bld_df.iterrows():
                if row['RISK'] == 'High':
                    color = [230, 57, 70, building_opacity]
                elif row['RISK'] == 'Moderate':
                    color = [255, 159, 54, building_opacity]
                elif row['RISK'] == 'Low':
                    color = [29, 181, 232, building_opacity//1.5]  # Light blue for watercourse proximity
                else:
                    color = [160, 160, 160, building_opacity//2]
                
                # Create properly formatted HTML tooltip
                tooltip_parts = [
                    f"<b>Risk: {row['RISK']}</b> (Score: {int(row['TOTAL_SCORE'])})",
                    f"<b>OSID:</b> {row['OSID']}"
                ]
                
                if row.get('ADDRESS_TEXT'):
                    tooltip_parts.append(f"<b>Address:</b> {row['ADDRESS_TEXT'][:60]}")
                
                # Add distance information
                tooltip_parts.extend([
                    "<hr>",
                    f"<b>Distances:</b>",
                    f"• Watercourse: {int(row['NEAREST_WATERCOURSE_M'])}m",
                    f"• Surface Water: {int(row['NEAREST_SURFACE_WATER_M'])}m", 
                    f"• River/Sea: {int(row['NEAREST_RIVER_SEA_M'])}m"
                ])
                
                tooltip = "<br>".join(tooltip_parts)
                
                # Round coordinates to reduce payload size
                geom = json.loads(row['GEOJSON'])
                if geom.get('type') == 'Polygon' and geom.get('coordinates'):
                    rounded_coords = []
                    for ring in geom['coordinates']:
                        rounded_ring = [[round(p[0], 5), round(p[1], 5)] for p in ring]
                        rounded_coords.append(rounded_ring)
                    geom['coordinates'] = rounded_coords
                
                bld_features.append({
                    'type': 'Feature',
                    'geometry': geom,
                    'properties': {
                        'OSID': row['OSID'],
                        'TOOLTIP': tooltip,
                        'color': color
                    }
                })
            
            if bld_features:
                bld_layer = pdk.Layer(
                    'GeoJsonLayer',
                    {'type': 'FeatureCollection', 'features': bld_features},
                    pickable=True,
                    filled=True,
                    get_fill_color='properties.color',
                    stroked=False,
                    id='buildings'
                )
                layers.append(bld_layer)
            
            # Flood areas layer
            if show_flood_areas and not flood_df.empty:
                flood_features = []
                for _, row in flood_df.iterrows():
                    # Color by flood source
                    if row['FLOOD_SOURCE'] == 'Surface Water':
                        color = [255, 159, 54, 100]  # Orange for surface water
                    elif row['FLOOD_SOURCE'] in ['River', 'Sea']:
                        color = [230, 57, 70, 100]   # Red for river/sea
                    else:
                        color = [100, 100, 255, 100] # Blue for other
                    
                    tooltip = f"<b>Flood Area:</b> {row['FRA_ID']}<br><b>Source:</b> {row['FLOOD_SOURCE']}"
                    
                    # Round coordinates to reduce payload size
                    geom = json.loads(row['GEOJSON'])
                    if geom.get('type') in ['Polygon', 'MultiPolygon'] and geom.get('coordinates'):
                        if geom['type'] == 'Polygon':
                            rounded_coords = []
                            for ring in geom['coordinates']:
                                rounded_ring = [[round(p[0], 5), round(p[1], 5)] for p in ring]
                                rounded_coords.append(rounded_ring)
                            geom['coordinates'] = rounded_coords
                        elif geom['type'] == 'MultiPolygon':
                            rounded_coords = []
                            for polygon in geom['coordinates']:
                                rounded_polygon = []
                                for ring in polygon:
                                    rounded_ring = [[round(p[0], 5), round(p[1], 5)] for p in ring]
                                    rounded_polygon.append(rounded_ring)
                                rounded_coords.append(rounded_polygon)
                            geom['coordinates'] = rounded_coords
                    
                    flood_features.append({
                        'type': 'Feature',
                        'geometry': geom,
                        'properties': {
                            'FRA_ID': row['FRA_ID'],
                            'FLOOD_SOURCE': row['FLOOD_SOURCE'],
                            'TOOLTIP': tooltip,
                            'color': color
                        }
                    })
                
                if flood_features:
                    flood_layer = pdk.Layer(
                        'GeoJsonLayer',
                        {'type': 'FeatureCollection', 'features': flood_features},
            pickable=True,
                        filled=True,
                        get_fill_color='properties.color',
                        stroked=True,
                        get_line_color=[255, 255, 255, 200],
            line_width_min_pixels=1,
                        id='flood_areas'
                    )
                    layers.append(flood_layer)
            
            # Watercourses layer
            if show_watercourses and not watercourse_df.empty:
                watercourse_features = []
                
                for _, row in watercourse_df.iterrows():
                    color = [0, 150, 255, 180]  # Blue for watercourses
                    tooltip = f"<b>Watercourse:</b> {row.get('WATERCOURSE_NAME', 'Unnamed')}<br><b>ID:</b> {row['IDENTIFIER']}"
                    
                    # Round coordinates to reduce payload size
                    geom = json.loads(row['GEOJSON'])
                    
                    # Handle both LineString and MultiLineString geometries
                    if geom.get('type') == 'LineString' and geom.get('coordinates'):
                        rounded_coords = [[round(p[0], 5), round(p[1], 5)] for p in geom['coordinates']]
                        geom['coordinates'] = rounded_coords
                        
                        watercourse_features.append({
                            'type': 'Feature',
                            'geometry': geom,
                            'properties': {
                                'IDENTIFIER': row['IDENTIFIER'],
                                'WATERCOURSE_NAME': row.get('WATERCOURSE_NAME', 'Unnamed'),
                                'TOOLTIP': tooltip,
                                'color': color
                            }
                        })
                    elif geom.get('type') == 'MultiLineString' and geom.get('coordinates'):
                        # Handle MultiLineString by creating separate features for each LineString
                        for line_coords in geom['coordinates']:
                            rounded_coords = [[round(p[0], 5), round(p[1], 5)] for p in line_coords]
                            watercourse_features.append({
                                'type': 'Feature',
                                'geometry': {
                                    'type': 'LineString',
                                    'coordinates': rounded_coords
                                },
                                'properties': {
                                    'IDENTIFIER': row['IDENTIFIER'],
                                    'WATERCOURSE_NAME': row.get('WATERCOURSE_NAME', 'Unnamed'),
                                    'TOOLTIP': tooltip,
                                    'color': color
                                }
                            })
                
                if watercourse_features:
                    watercourse_layer = pdk.Layer(
                        'GeoJsonLayer',
                        {'type': 'FeatureCollection', 'features': watercourse_features},
                        pickable=True,
                        filled=False,
                        stroked=True,
                        get_line_color='properties.color',
                        line_width_min_pixels=2,
                        id='watercourses'
                    )
                    layers.append(watercourse_layer)
            
            # Calculate view center
            try:
                first_geom = json.loads(bld_df['GEOJSON'].iloc[0])
                coords = first_geom['coordinates'][0]
                center_lat = sum(p[1] for p in coords) / len(coords)
                center_lon = sum(p[0] for p in coords) / len(coords)
            except:
                center_lat, center_lon = 50.7, -3.5
            
            view_state = pdk.ViewState(latitude=center_lat, longitude=center_lon, zoom=15)
            
            deck = pdk.Deck(
        map_style=None,
        initial_view_state=view_state,
        layers=layers,
                height=1000,
                tooltip={
                    'html': '{TOOLTIP}', 
                    'style': {
                        'maxWidth': '500px',
                        'backgroundColor': 'rgba(0,0,0,0.9)', 
                        'color': 'white',
                        'fontSize': '12px',
                        'padding': '10px',
                        'borderRadius': '5px'
                    }
                }
            )
            
            event = st.pydeck_chart(deck, on_select="rerun", selection_mode="single-object", key="building_map")
            
            # Handle map clicks to select buildings
            if isinstance(event, dict):
                obj = event.get("object")
                sel = event.get("selection", {}).get("objects", {}).get("buildings", [])
                clicked_osid = None
                
                if obj:
                    # Try different ways to get OSID
                    if "OSID" in obj:
                        clicked_osid = obj["OSID"]
                    elif "properties" in obj and obj["properties"] and "OSID" in obj["properties"]:
                        clicked_osid = obj["properties"]["OSID"]
                elif sel:
                    sel_obj = sel[0] if sel else None
                    if sel_obj and "OSID" in sel_obj:
                        clicked_osid = sel_obj["OSID"]
                    elif sel_obj and "properties" in sel_obj and sel_obj["properties"] and "OSID" in sel_obj["properties"]:
                        clicked_osid = sel_obj["properties"]["OSID"]
                
                if clicked_osid and clicked_osid != st.session_state.get('last_clicked_osid'):
                    # Find which building index corresponds to this OSID
                    for i, (_, row) in enumerate(bld_df.iterrows()):
                        if row['OSID'] == clicked_osid:
                            st.session_state.selected_building_index = i
                            st.session_state.last_clicked_osid = clicked_osid
                            st.rerun()  # immediate rerun to update selection
                            break
            
            # Show selected building status
            st.markdown('**Building Selection:**')
            if 'selected_building_index' in st.session_state:
                selected_idx = st.session_state.selected_building_index
                if selected_idx < len(bld_df):
                    selected_building = bld_df.iloc[selected_idx]
                    risk_icon = "🔴" if selected_building['RISK'] == 'High' else "🟠" if selected_building['RISK'] == 'Moderate' else "⚪"
                    addr_text = selected_building.get('ADDRESS_TEXT', f"Building {selected_building['OSID']}")[:80]
                    
                    st.success(f"**Selected:** {risk_icon} {selected_building['RISK']} Risk Building")
                    st.info(f"**Address:** {addr_text}")
                    st.caption(f"**OSID:** {selected_building['OSID']}")
                    
                    if st.button('🤖 Analyze This Building', type='primary'):
                        st.session_state.analysis_building = selected_building.to_dict()
                        st.rerun()
                else:
                    st.warning('Invalid building selection')
            else:
                st.info('👆 Click on any building polygon above to select it for analysis')
                st.caption('Buildings are color-coded: 🔴 High Risk • 🟠 Moderate Risk • ⚪ No Risk')
        
        with col_info:
            # Risk chart
            if not bld_df.empty and 'RISK' in bld_df.columns:
                risk_counts = bld_df['RISK'].value_counts()
                chart_data = pd.DataFrame({'Risk': risk_counts.index, 'Count': risk_counts.values})
                
                bars = alt.Chart(chart_data).mark_bar().encode(
                    x=alt.X('Risk:N', sort=['High', 'Moderate', 'Low', 'None']),
                    y=alt.Y('Count:Q', axis=None),
                    color=alt.Color('Risk:N', scale=alt.Scale(domain=['High', 'Moderate', 'Low', 'None'], range=['#E63946', '#FF9F36', '#1DB5E8', '#A0A0A0']))
                ).properties(height=300)
                
                text = alt.Chart(chart_data).mark_text(align='center', baseline='bottom', dy=-5).encode(
                    x=alt.X('Risk:N', sort=['High', 'Moderate', 'Low', 'None']), 
                    y=alt.Y('Count:Q'), 
                    text='Count:Q'
                )
                
                st.altair_chart((bars + text), use_container_width=True)
                
                # Risk level info with scoring
                st.markdown('**Risk Scoring System:**')
                st.caption('🔴 High: 200+ points')
                st.caption('🟠 Moderate: 100-199 points')
                st.caption('🔵 Low: 25-99 points')
                st.caption('⚪ None: 0-24 points')
                
                st.markdown('**Score Components:**')
                st.caption('• Watercourse: 0-50 pts (closer = more)')
                st.caption('• Surface Water: 0-100 pts (closer = more)')
                st.caption('• River/Sea: 0-150 pts (closer = more)')
                
                # Show score statistics if available
                if 'TOTAL_SCORE' in bld_df.columns:
                    avg_score = bld_df['TOTAL_SCORE'].mean()
                    max_score = bld_df['TOTAL_SCORE'].max()
                    st.markdown(f'**Score Stats:** Avg: {avg_score:.0f}, Max: {max_score:.0f}')
                
                # Layer legend
                st.markdown('**Map Layers:**')
                st.caption('🏢 Buildings (color-coded by risk)')
                if show_flood_areas:
                    st.caption('🟠 Surface Water Areas')
                    st.caption('🔴 River/Sea Areas')
                if show_watercourses:
                    st.caption('🔵 Watercourses')
        
        # AI Analysis section
        if 'analysis_building' in st.session_state:
            analysis_building = st.session_state.analysis_building
            st.markdown('---')
            st.markdown('**🤖 AI Building Analysis**')
            
            col_bld_map, col_bld_analysis = st.columns([1, 1])
            
            with col_bld_map:
                # Focused building map
                try:
                    selected_geom = json.loads(analysis_building['GEOJSON'])
                    if selected_geom['type'] == 'Polygon':
                        coords = selected_geom['coordinates'][0]
                        center_lat = sum(p[1] for p in coords) / len(coords)
                        center_lon = sum(p[0] for p in coords) / len(coords)
                        
                        focused_view = pdk.ViewState(latitude=center_lat, longitude=center_lon, zoom=18)
                        
                        # Building highlight - match main map colors
                        if analysis_building['RISK'] == 'High':
                            risk_color = [230, 57, 70, 200]  # Red
                        elif analysis_building['RISK'] == 'Moderate':
                            risk_color = [255, 159, 54, 200]  # Orange
                        elif analysis_building['RISK'] == 'Low':
                            risk_color = [29, 181, 232, 200]  # Blue
                        else:
                            risk_color = [160, 160, 160, 150]  # Grey for None
                        
                        focus_layer = pdk.Layer(
                            'GeoJsonLayer',
                            {'type': 'FeatureCollection', 'features': [{
                                'type': 'Feature',
                                'geometry': selected_geom,
                                'properties': {'color': risk_color}
                            }]},
                            filled=True,
                            get_fill_color='properties.color',
                            stroked=True,
                            get_line_color=[255,255,255],
                            line_width_min_pixels=3
                        )
                        
                        st.pydeck_chart(pdk.Deck(
                            map_style=None,
                            initial_view_state=focused_view,
                            layers=[focus_layer],
                            height=400
                        ))
                        
                        # Building details
                        st.markdown('**Building Details**')
                        st.write(f"**OSID:** {analysis_building.get('OSID')}")
                        st.write(f"**Risk:** {analysis_building.get('RISK')}")
                        st.write(f"**Use:** {analysis_building.get('BUILDINGUSE', 'Unknown')}")
                        st.write(f"**Floors:** {analysis_building.get('NUMBEROFFLOORS', 'Unknown')}")
                        if analysis_building.get('AREA_M2'):
                            st.write(f"**Area:** {analysis_building['AREA_M2']:,.0f} m²")
                        st.write(f"**Material:** {analysis_building.get('CONSTRUCTIONMATERIAL', 'Unknown')}")
                        
                        if st.button('🗑️ Clear Analysis'):
                            del st.session_state.analysis_building
                            st.rerun()
                        
                except Exception as e:
                    st.error(f"Could not render building: {e}")
            
            with col_bld_analysis:
                # AI Analysis
                building_info = {
                    'osid': analysis_building.get('OSID', 'Unknown'),
                    'flood_risk': analysis_building.get('RISK', 'Unknown'),
                    'building_use': analysis_building.get('BUILDINGUSE', 'Unknown'),
                    'floors': analysis_building.get('NUMBEROFFLOORS', 'Unknown'),
                    'area_m2': analysis_building.get('AREA_M2', 'Unknown'),
                    'construction_material': analysis_building.get('CONSTRUCTIONMATERIAL', 'Unknown'),
                    'age_period': analysis_building.get('BUILDINGAGE_PERIOD', 'Unknown'),
                    'address': analysis_building.get('ADDRESS_TEXT', 'Not available')
                }
                
                # Include detailed scoring information in analysis
                total_score = analysis_building.get('TOTAL_SCORE', 0)
                watercourse_score = analysis_building.get('WATERCOURSE_SCORE', 0)
                surface_water_score = analysis_building.get('SURFACE_WATER_SCORE', 0)
                river_sea_score = analysis_building.get('RIVER_SEA_SCORE', 0)
                nearest_watercourse_m = analysis_building.get('NEAREST_WATERCOURSE_M', 1000)
                nearest_surface_water_m = analysis_building.get('NEAREST_SURFACE_WATER_M', 1000)
                nearest_river_sea_m = analysis_building.get('NEAREST_RIVER_SEA_M', 1000)
                
                ai_prompt = f"""
                Write a comprehensive flood risk analysis for this building using HTML styling which includes the extra.css file included
                in this streamlit :

                <h1sub>🏠 Building Profile</h1sub>
                Analyze characteristics and flood vulnerability based on detailed risk scoring.

                <h1sub>🌊 Risk Assessment</h1sub>
                Risk Level: <span style="color: #E63946; font-weight: bold;">High</span> (200+ points), 
                <span style="color: #FF9F36; font-weight: bold;">Moderate</span> (100-199 points), 
                <span style="color: #1DB5E8; font-weight: bold;">Low</span> (25-99 points), or 
                <span style="color: #A0A0A0; font-weight: bold;">None</span> (0-24 points)

                <h1sub>📊 Risk Score Breakdown</h1sub>
                Total Risk Score: <h1grey>{int(total_score)}/300 points</h1grey>
                • Watercourse Proximity: {int(watercourse_score)}/50 points ({int(nearest_watercourse_m)}m away)
                • Surface Water Risk: {int(surface_water_score)}/100 points ({int(nearest_surface_water_m)}m away)
                • River/Sea Risk: {int(river_sea_score)}/150 points ({int(nearest_river_sea_m)}m away)

                <h1sub>💧 Distance Analysis</h1sub>
                Analyze how proximity to different water sources affects flood risk:
                - Watercourses: {int(nearest_watercourse_m)}m (contributes {int(watercourse_score)} points)
                - Surface Water Areas: {int(nearest_surface_water_m)}m (contributes {int(surface_water_score)} points)
                - River/Sea Areas: {int(nearest_river_sea_m)}m (contributes {int(river_sea_score)} points)

                <h1sub>🛡️ Recommendations</h1sub>
                Provide specific mitigation strategies based on the risk score and proximity factors.

                Building Data: OSID {building_info['osid']}, Risk {building_info['flood_risk']}, 
                Use {building_info['building_use']}, {building_info['floors']} floors,
                Area {building_info['area_m2']} m², Material {building_info['construction_material']}, 
                Address {building_info['address']}
                Risk Score: {int(total_score)} points (Watercourse: {int(watercourse_score)}, Surface: {int(surface_water_score)}, River/Sea: {int(river_sea_score)}
                ensure all text is markdown.  do not embed any code blocks.  or markdown blocks.  use html with extra.css)
                """
                
                try:
                    escaped_prompt = ai_prompt.replace("'", "''")
                    ai_result = session.sql(f"SELECT AI_COMPLETE('claude-3-5-sonnet', '{escaped_prompt}')::text").collect()
                    ai_analysis = str(ai_result[0][0]) if ai_result else "Analysis not available"
                    
                    st.markdown(ai_analysis, unsafe_allow_html=True)
                except Exception as e:
                    st.markdown("**Building Analysis**")
                    st.write(f"**Risk Level:** {building_info['flood_risk']}")
                    st.write(f"**Building Use:** {building_info['building_use']}")
                    st.write(f"**Floors:** {building_info['floors']}")
                    if building_info['area_m2'] != 'Unknown':
                        st.write(f"**Area:** {building_info['area_m2']:,} m²")
                    st.write(f"**Material:** {building_info['construction_material']}")
    else:
        st.warning(f'No buildings found near {search_pc}')
else:
    st.info('👈 Select a demo postcode or enter one manually to see buildings and flood risk analysis')