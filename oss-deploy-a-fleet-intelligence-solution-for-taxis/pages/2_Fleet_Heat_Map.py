# Taxi Fleet Intelligence - Fleet Heat Map
# View driver density across the city

import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
from snowflake.snowpark.functions import *
from snowflake.snowpark.context import get_active_session

# Initialize session
session = get_active_session()
st.set_page_config(layout="wide")

# Load custom CSS
with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

# Set sidebar logo
st.logo('logo.svg')

# Get location from VARIABLES table
def get_location():
    try:
        result = session.sql("""
            SELECT VALUE FROM FLEET_INTELLIGENCE.PUBLIC.VARIABLES 
            WHERE ID = 'location'
        """).collect()
        if result:
            return result[0]['VALUE']
    except:
        pass
    return 'San Francisco'  # Default fallback

location = get_location()

# Main header with dynamic location
st.markdown(f'''
<h0black>{location} Taxi |</h0black><h0blue> Fleet Heat Map</h0blue><BR>
<h1grey>Driver Location Density Analysis</h1grey>
''', unsafe_allow_html=True)

st.divider()

# Time selector
st.markdown('<h1sub>Select Time of Day</h1sub>', unsafe_allow_html=True)

col1, col2 = st.columns([0.3, 0.7])

with col1:
    selected_hour = st.slider("Hour of Day", 0, 23, 12)
    
    # View type
    view_type = st.radio(
        "View Type",
        ["Heat Map", "Point Cloud", "H3 Hexagons"],
        horizontal=True
    )

# Get driver locations for selected hour
@st.cache_data
def get_locations_for_hour(hour):
    df = session.sql(f"""
        SELECT 
            DRIVER_ID,
            LON,
            LAT,
            KMH,
            POINT_TIME,
            DRIVER_STATE
        FROM FLEET_INTELLIGENCE.ANALYTICS.DRIVER_LOCATIONS
        WHERE HOUR(POINT_TIME) = {hour}
    """).to_pandas()
    # Convert to native Python types
    df['LON'] = df['LON'].astype(float)
    df['LAT'] = df['LAT'].astype(float)
    df['KMH'] = df['KMH'].astype(float)
    return df

try:
    locations_df = get_locations_for_hour(selected_hour)
    
    with col2:
        st.metric(f"Driver Positions at {selected_hour:02d}:00", f"{len(locations_df):,}")
    
    if len(locations_df) > 0:
        # Create the appropriate layer based on selection
        if view_type == "Heat Map":
            layer = pdk.Layer(
                "HeatmapLayer",
                data=locations_df,
                get_position=['LON', 'LAT'],
                get_weight='KMH',
                aggregation='MEAN',
                radius_pixels=50,
                intensity=1,
                threshold=0.1,
                color_range=[
                    [255, 255, 178],
                    [254, 217, 118],
                    [254, 178, 76],
                    [253, 141, 60],
                    [240, 59, 32],
                    [189, 0, 38]
                ]
            )
        elif view_type == "Point Cloud":
            # Color by speed
            locations_df['color'] = locations_df['KMH'].apply(
                lambda x: [41, 181, 232, 150] if x > 30 else 
                         [255, 159, 54, 150] if x > 10 else 
                         [212, 91, 144, 150]
            )
            
            layer = pdk.Layer(
                'ScatterplotLayer',
                data=locations_df,
                get_position=['LON', 'LAT'],
                get_radius=30,
                radius_min_pixels=3,
                radius_max_pixels=8,
                get_color='color',
                pickable=True
            )
        else:  # H3 Hexagons
            layer = pdk.Layer(
                "HexagonLayer",
                data=locations_df,
                get_position=['LON', 'LAT'],
                radius=100,
                elevation_scale=4,
                elevation_range=[0, 500],
                extruded=True,
                coverage=0.8,
                color_range=[
                    [255, 255, 204],
                    [199, 233, 180],
                    [127, 205, 187],
                    [65, 182, 196],
                    [44, 127, 184],
                    [37, 52, 148]
                ]
            )
        
        # View state - auto-center on data
        if len(locations_df) > 0:
            center_lat = locations_df['LAT'].mean()
            center_lon = locations_df['LON'].mean()
        else:
            center_lat = 37.76
            center_lon = -122.44
        
        view_state = pdk.ViewState(
            latitude=center_lat,
            longitude=center_lon,
            zoom=12,
            pitch=45 if view_type == "H3 Hexagons" else 0,
            bearing=0
        )
        
        tooltip = {
            "html": "<b>Driver:</b> {DRIVER_ID}<br/><b>Speed:</b> {KMH} km/h",
            "style": {"backgroundColor": "#24323D", "color": "white"}
        } if view_type == "Point Cloud" else None
        
        # Create deck object with map_style=None like NYC example
        st.pydeck_chart(pdk.Deck(
            map_style=None,
            initial_view_state=view_state,
            layers=[layer],
            tooltip=tooltip
        ))
        
        st.divider()
        
        # Statistics for selected hour
        st.markdown('<h1sub>Hour Statistics</h1sub>', unsafe_allow_html=True)
        
        col1, col2, col3, col4 = st.columns(4)
        
        with col1:
            st.metric("Active Drivers", locations_df['DRIVER_ID'].nunique())
        with col2:
            st.metric("Avg Speed", f"{locations_df['KMH'].mean():.1f} km/h")
        with col3:
            stationary = len(locations_df[locations_df['KMH'] == 0])
            st.metric("Stationary", f"{stationary} ({100*stationary/len(locations_df):.0f}%)")
        with col4:
            moving = len(locations_df[locations_df['KMH'] > 5])
            st.metric("Moving (>5km/h)", f"{moving} ({100*moving/len(locations_df):.0f}%)")
        
        # Speed distribution chart
        st.markdown('<h1sub>Speed Distribution</h1sub>', unsafe_allow_html=True)
        
        # Bin speeds with stationary as separate category
        locations_df['Speed_Bin'] = pd.cut(
            locations_df['KMH'],
            bins=[-0.1, 0.1, 5, 15, 30, 50, 100],
            labels=['Stationary', '0-5', '5-15', '15-30', '30-50', '50+']
        )
        
        speed_dist = locations_df.groupby('Speed_Bin').size().reset_index(name='Count')
        
        chart = alt.Chart(speed_dist).mark_bar().encode(
            x=alt.X('Speed_Bin:N', title='Speed Range (km/h)'),
            y=alt.Y('Count:Q', title='Number of Observations'),
            color=alt.value('#29B5E8')
        ).properties(height=200)
        
        st.altair_chart(chart, use_container_width=True)
        
except Exception as e:
    st.error(f"Error loading data: {e}")
