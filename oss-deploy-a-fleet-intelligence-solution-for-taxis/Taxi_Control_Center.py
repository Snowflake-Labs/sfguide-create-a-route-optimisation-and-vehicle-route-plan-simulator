# Taxi Fleet Intelligence Control Center
# Main entry point for multi-page Streamlit app

import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import json
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.functions import *

# Page configuration
st.set_page_config(
    page_title="Taxi Control Center",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Load custom CSS
with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

# Set sidebar logo
st.logo('logo.svg')

# Initialize session
session = get_active_session()

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

# Main page header with dynamic location
st.markdown(f'''
<h0black>{location} Taxi |</h0black><h0blue> Fleet Intelligence</h0blue><BR>
<h1grey>Real-time Fleet Control Center</h1grey>
''', unsafe_allow_html=True)

st.divider()

# Overview statistics
st.markdown('<h1sub>Fleet Overview</h1sub>', unsafe_allow_html=True)

col1, col2, col3, col4 = st.columns(4)

# Get summary stats
try:
    trips_count = session.table('FLEET_INTELLIGENCE.ANALYTICS.TRIPS_ASSIGNED_TO_DRIVERS').count()
    drivers_count = session.table('FLEET_INTELLIGENCE.ANALYTICS.TRIPS_ASSIGNED_TO_DRIVERS').select('DRIVER_ID').distinct().count()
    locations_count = session.table('FLEET_INTELLIGENCE.PUBLIC.TAXI_LOCATIONS').count()
    
    # Get total distance
    total_distance = session.table('FLEET_INTELLIGENCE.ANALYTICS.TRIP_SUMMARY').agg(
        sum('ROUTE_DISTANCE_METERS').alias('TOTAL_DISTANCE')
    ).collect()[0]['TOTAL_DISTANCE']
    
    with col1:
        st.metric("Total Trips", f"{trips_count:,}")
    with col2:
        st.metric("Active Drivers", f"{drivers_count:,}")
    with col3:
        st.metric("Total Distance", f"{total_distance/1000:,.0f} km")
    with col4:
        st.metric("Location Points", f"{locations_count:,}")
except Exception as e:
    st.warning("Connect to Snowflake and ensure the Fleet Intelligence data is loaded.")
    st.error(f"Error: {e}")

st.divider()

# Fleet Map - Show all routes
st.markdown('<h1sub>Fleet Route Overview</h1sub>', unsafe_allow_html=True)

try:
    # Get all routes with driver info
    routes_df = session.sql("""
        SELECT 
            DRIVER_ID,
            TRIP_ID,
            ORIGIN_ADDRESS,
            DESTINATION_ADDRESS,
            ST_ASGEOJSON(GEOMETRY) AS GEOMETRY_JSON,
            ROUTE_DISTANCE_METERS/1000 AS DISTANCE_KM,
            ROUTE_DURATION_SECS/60 AS DURATION_MINS
        FROM FLEET_INTELLIGENCE.ANALYTICS.TRIP_SUMMARY
        LIMIT 100
    """).to_pandas()
    
    # Parse coordinates for pydeck
    routes_df["coordinates"] = routes_df["GEOMETRY_JSON"].apply(
        lambda row: json.loads(row)["coordinates"] if row else []
    )
    
    # Assign colors by driver
    driver_colors = {
        'D-0000': [125, 68, 207],   # Purple
        'D-0001': [212, 91, 144],   # Pink
        'D-0002': [255, 159, 54],   # Orange
        'D-0003': [113, 221, 220],  # Teal
        'D-0004': [41, 181, 232],   # Blue
        'D-0005': [0, 53, 69],      # Dark teal
        'D-0006': [60, 0, 69],      # Dark purple
        'D-0007': [138, 153, 158],  # Gray
        'D-0008': [17, 86, 127],    # Mid blue
        'D-0009': [36, 50, 61],     # Dark gray
    }
    
    routes_df['color'] = routes_df['DRIVER_ID'].apply(
        lambda x: driver_colors.get(x, [41, 181, 232])
    )
    
    # Create path layer
    path_layer = pdk.Layer(
        type="PathLayer",
        data=routes_df,
        pickable=True,
        get_color='color',
        width_scale=20,
        width_min_pixels=2,
        width_max_pixels=5,
        get_path="coordinates",
        get_width=3
    )
    
    # Get map center from data (auto-centers on any city)
    try:
        center_coords = session.sql("""
            SELECT 
                AVG(ST_X(ORIGIN)) AS CENTER_LON,
                AVG(ST_Y(ORIGIN)) AS CENTER_LAT
            FROM FLEET_INTELLIGENCE.ANALYTICS.TRIP_SUMMARY
            LIMIT 1
        """).collect()[0]
        center_lat = float(center_coords['CENTER_LAT'])
        center_lon = float(center_coords['CENTER_LON'])
    except:
        # Fallback to San Francisco if query fails
        center_lat = 37.76
        center_lon = -122.44
    
    view_state = pdk.ViewState(
        latitude=center_lat,
        longitude=center_lon,
        zoom=11.5,
        pitch=0
    )
    
    tooltip = {
        "html": "<b>Driver:</b> {DRIVER_ID}<br/><b>From:</b> {ORIGIN_ADDRESS}<br/><b>To:</b> {DESTINATION_ADDRESS}<br/><b>Distance:</b> {DISTANCE_KM:.1f} km",
        "style": {
            "backgroundColor": "#24323D",
            "color": "white"
        }
    }
    
    deck = pdk.Deck(
        map_provider="carto",
        map_style="light",
        initial_view_state=view_state,
        layers=[path_layer],
        tooltip=tooltip,
        height=500
    )
    
    st.pydeck_chart(deck, use_container_width=True, height=500)
    
except Exception as e:
    st.error(f"Error loading map: {e}")

st.divider()

# Driver Statistics
st.markdown('<h1sub>Driver Performance Summary</h1sub>', unsafe_allow_html=True)

try:
    driver_stats = session.sql("""
        SELECT 
            DRIVER_ID,
            COUNT(*) AS TRIPS,
            ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 1) AS TOTAL_KM,
            ROUND(AVG(AVERAGE_KMH), 1) AS AVG_SPEED,
            ROUND(SUM(ROUTE_DURATION_SECS)/3600, 1) AS TOTAL_HOURS
        FROM FLEET_INTELLIGENCE.ANALYTICS.TRIP_SUMMARY
        GROUP BY DRIVER_ID
        ORDER BY TOTAL_KM DESC
    """).to_pandas()
    
    col1, col2 = st.columns(2)
    
    with col1:
        # Bar chart for distance
        chart_distance = alt.Chart(driver_stats).mark_bar().encode(
            x=alt.X('TOTAL_KM:Q', title='Total Distance (km)'),
            y=alt.Y('DRIVER_ID:N', sort='-x', title='Driver'),
            color=alt.value('#29B5E8'),
            tooltip=['DRIVER_ID', 'TOTAL_KM', 'TRIPS', 'AVG_SPEED']
        ).properties(
            title='Distance Driven by Driver',
            height=400
        )
        st.altair_chart(chart_distance, use_container_width=True)
    
    with col2:
        # Bar chart for trips
        chart_trips = alt.Chart(driver_stats).mark_bar().encode(
            x=alt.X('TRIPS:Q', title='Number of Trips'),
            y=alt.Y('DRIVER_ID:N', sort='-x', title='Driver'),
            color=alt.value('#FF9F36'),
            tooltip=['DRIVER_ID', 'TRIPS', 'TOTAL_KM', 'AVG_SPEED']
        ).properties(
            title='Trips Completed by Driver',
            height=400
        )
        st.altair_chart(chart_trips, use_container_width=True)

except Exception as e:
    st.error(f"Error loading driver stats: {e}")

st.divider()

# Hourly Activity Heatmap
st.markdown('<h1sub>Fleet Activity by Hour</h1sub>', unsafe_allow_html=True)

try:
    hourly_stats = session.sql("""
        SELECT 
            HOUR(PICKUP_TIME) AS HOUR,
            COUNT(*) AS TRIPS,
            ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 0) AS TOTAL_KM
        FROM FLEET_INTELLIGENCE.ANALYTICS.TRIP_SUMMARY
        GROUP BY HOUR(PICKUP_TIME)
        ORDER BY HOUR
    """).to_pandas()
    
    # Create heatmap-style chart
    col1, col2 = st.columns(2)
    
    with col1:
        chart_hourly = alt.Chart(hourly_stats).mark_bar().encode(
            x=alt.X('HOUR:O', title='Hour of Day', axis=alt.Axis(values=list(range(24)))),
            y=alt.Y('TRIPS:Q', title='Number of Trips'),
            color=alt.Color('TRIPS:Q', scale=alt.Scale(scheme='blues'), legend=None),
            tooltip=['HOUR', 'TRIPS', 'TOTAL_KM']
        ).properties(
            title='Trips per Hour',
            height=250
        )
        st.altair_chart(chart_hourly, use_container_width=True)
    
    with col2:
        chart_km = alt.Chart(hourly_stats).mark_bar().encode(
            x=alt.X('HOUR:O', title='Hour of Day', axis=alt.Axis(values=list(range(24)))),
            y=alt.Y('TOTAL_KM:Q', title='Total Distance (km)'),
            color=alt.Color('TOTAL_KM:Q', scale=alt.Scale(scheme='oranges'), legend=None),
            tooltip=['HOUR', 'TRIPS', 'TOTAL_KM']
        ).properties(
            title='Distance per Hour',
            height=250
        )
        st.altair_chart(chart_km, use_container_width=True)

except Exception as e:
    st.error(f"Error loading hourly stats: {e}")

st.divider()

# Navigation instructions
st.markdown(f'''
### Navigate the Control Center

Use the sidebar to access different views:

- **Driver Routes** - Track individual driver journeys with route visualization and AI insights
- **Fleet Heat Map** - View driver density across {location}

### Data Sources

- **Overture Maps Places** - Points of interest for realistic pickup/dropoff locations
- **Overture Maps Addresses** - Street addresses for accurate location simulation
- **OpenRouteService** - Real road routing for actual driving paths

### Features

- **Real-time route tracking** with pickup/dropoff locations on actual roads
- **AI-powered trip analysis** using Snowflake Cortex
- **Interactive maps** with pydeck visualization
- **Driver performance metrics** including speed and distance analytics
''', unsafe_allow_html=True)

st.divider()

st.markdown('''
<h1grey>Powered by Snowflake, OpenRouteService & Overture Maps</h1grey>
''', unsafe_allow_html=True)
