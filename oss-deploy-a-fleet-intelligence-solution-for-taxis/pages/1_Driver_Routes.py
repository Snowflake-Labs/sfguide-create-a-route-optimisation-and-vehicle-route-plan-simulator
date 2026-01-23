# Taxi Fleet Intelligence - Driver Routes
# Track individual driver journeys with route visualization

import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import json
from datetime import time, datetime

from snowflake.snowpark.functions import *
from snowflake.snowpark.types import *
from snowflake.snowpark.window import Window
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

# Helper function for bar charts
def bar_creation(dataframe, measure, attribute):
    df = dataframe.to_pandas()
    
    bars = alt.Chart(df).mark_bar().encode(
        y=alt.Y(attribute, sort=None, axis=None),
        x=alt.X(measure, axis=None),
        color=alt.value("#29B5E8"),
        tooltip=[
            alt.Tooltip(attribute, title=attribute.replace('_', ' ').title()),
            alt.Tooltip(measure, title=measure.replace('_', ' ').title())
        ]
    ).properties(height=300)
    
    text = bars.mark_text(
        align='right',
        baseline='middle',
        dx=-10,
        fontSize=14
    ).encode(
        color=alt.value("#FFFFFF"),
        x=alt.X(measure),
        y=alt.Y(attribute, sort=None),
        text=alt.Text(measure, format=",.0f")
    )
    
    return (bars + text).properties(height=200)

# Load data from views
vehicle_plans_poi = session.table('FLEET_INTELLIGENCE.ANALYTICS.TRIPS_ASSIGNED_TO_DRIVERS')
vehicle_plans_poi = vehicle_plans_poi.with_column('DISTANCE', call_function('ST_LENGTH', col('GEOMETRY')))
route_names = session.table('FLEET_INTELLIGENCE.ANALYTICS.ROUTE_NAMES')
routes = vehicle_plans_poi.select('GEOMETRY', 'TRIP_ID', 'DISTANCE', 'DRIVER_ID')
trip_summary = session.table('FLEET_INTELLIGENCE.ANALYTICS.TRIP_SUMMARY')

# Join for driver locations
all_driver_locations = session.table('FLEET_INTELLIGENCE.ANALYTICS.DRIVER_LOCATIONS')
all_driver_locations = all_driver_locations.with_column('POINT_TIME_STR', col('POINT_TIME').astype(StringType()))

# Join with route info
vehicle_plans_poi = vehicle_plans_poi.join(route_names, 'TRIP_ID')

# Get unique drivers
@st.cache_data
def get_drivers():
    return vehicle_plans_poi.select('DRIVER_ID').distinct().sort('DRIVER_ID').to_pandas()

# Sidebar driver selection
with st.sidebar:
    driver = st.selectbox('Choose Driver:', get_drivers())

# Get trips for selected driver
def get_trips(driver):
    return vehicle_plans_poi.filter(col('DRIVER_ID') == driver)\
        .group_by('TRIP_ID', 'TRIP_NAME').agg(min('DISTANCE').alias('DISTANCE'))\
        .sort(col('DISTANCE').desc()).to_pandas()

# Filter data for selected driver
driver_day = vehicle_plans_poi.filter(col('DRIVER_ID') == driver)
trip_summaryd = trip_summary.filter(col('DRIVER_ID') == driver)

# Main header with dynamic location
st.markdown(f'''
<h0black>{location} Taxi |</h0black><h0blue> Fleet Intelligence</h0blue><BR>
<h1grey>Viewing Routes for Driver {driver}</h1grey>
''', unsafe_allow_html=True)

# Time analysis
time_by_hour = all_driver_locations.filter(col('DRIVER_ID') == driver)\
    .join(route_names, 'TRIP_ID')\
    .join(routes, 'TRIP_ID')\
    .with_column('HOUR', hour(to_timestamp('POINT_TIME')))\
    .group_by('HOUR', 'TRIP_NAME').agg(max('DISTANCE').alias('DISTANCE'))

time_by_hour = time_by_hour.group_by('HOUR').agg(
    count('*').alias('TRIPS'),
    sum('DISTANCE').alias('DISTANCE')
)

try:
    perhour_stats = time_by_hour.agg(
        avg('TRIPS').alias('TRIPS'),
        avg('DISTANCE').alias('DISTANCE')
    ).to_pandas()
except:
    perhour_stats = pd.DataFrame({'TRIPS': [0], 'DISTANCE': [0]})

# Heatmaps
st.markdown(f'<h1grey>TIME ANALYSIS FOR {driver} TODAY</h1grey>', unsafe_allow_html=True)

try:
    df = time_by_hour.to_pandas()
    
    col1, col2 = st.columns(2)
    
    with col1:
        chart_trips = alt.Chart(df).mark_rect().encode(
            x=alt.X('HOUR:O', title='Hour', axis=alt.Axis(values=list(range(24)))),
            y=alt.Y('value:O', title='', axis=None),
            color=alt.Color('TRIPS:Q', title='Trips', 
                          scale=alt.Scale(range=['#c6e5f1', '#96d5ef', '#63c6eb', '#29B5E8']),
                          legend=None),
            tooltip=[alt.Tooltip('HOUR:O', title='Hour'), alt.Tooltip('TRIPS:Q', title='Trips')]
        ).transform_calculate(value='"Trips"').properties(title='Trips per Hour', height=80)
        st.altair_chart(chart_trips, use_container_width=True)
    
    with col2:
        chart_distance = alt.Chart(df).mark_rect().encode(
            x=alt.X('HOUR:O', title='Hour', axis=alt.Axis(values=list(range(24)))),
            y=alt.Y('value:O', title='', axis=None),
            color=alt.Color('DISTANCE:Q', title='Distance',
                          scale=alt.Scale(range=['#ffe5cc', '#ffcc99', '#ff9f36', '#e67300']),
                          legend=None),
            tooltip=[alt.Tooltip('HOUR:O', title='Hour'), alt.Tooltip('DISTANCE:Q', title='Distance (m)', format=',.0f')]
        ).transform_calculate(value='"Distance"').properties(title='Distance per Hour', height=80)
        st.altair_chart(chart_distance, use_container_width=True)
except Exception as e:
    st.warning(f"Could not load time analysis: {e}")

# Sidebar stats
with st.sidebar:
    try:
        speed_stats = trip_summaryd.agg(
            avg('AVERAGE_KMH').alias('AVG_KMH'),
            max('MAX_KMH').alias('MAX_KMH')
        ).to_pandas()
        driver_stats = driver_day.agg(
            count('*').alias('A'),
            sum('DISTANCE').alias('B')
        ).to_pandas()
        
        st.markdown(f'<h1grey style="font-size: 0.9em;">TRIPS TODAY<BR></h1grey><h0blue style="font-size: 1.5em;">{driver_stats.A.iloc[0]}</h0blue>', unsafe_allow_html=True)
        st.markdown(f'<h1grey style="font-size: 0.9em;">TOTAL DISTANCE<BR></h1grey><h0blue style="font-size: 1.5em;">{(driver_stats.B.iloc[0]/1000):.1f} km</h0blue>', unsafe_allow_html=True)
        st.markdown(f'<h1grey style="font-size: 0.9em;">AVG SPEED<BR></h1grey><h0blue style="font-size: 1.5em;">{speed_stats.AVG_KMH.iloc[0]:.1f} km/h</h0blue>', unsafe_allow_html=True)
        st.markdown(f'<h1grey style="font-size: 0.9em;">MAX SPEED<BR></h1grey><h0blue style="font-size: 1.5em;">{speed_stats.MAX_KMH.iloc[0]:.1f} km/h</h0blue>', unsafe_allow_html=True)
    except Exception as e:
        st.warning(f"Stats unavailable: {e}")

# Route distance charts
st.markdown(f'<h1grey>ROUTE DISTANCES FOR {driver}</h1grey>', unsafe_allow_html=True)

try:
    col1, col2 = st.columns(2)
    
    with col1:
        st.markdown('<h1sub>Shortest Routes</h1sub>', unsafe_allow_html=True)
        shortest = driver_day.sort(col('DISTANCE').asc()).limit(5)
        st.altair_chart(bar_creation(shortest, 'DISTANCE', 'TRIP_NAME'))
    
    with col2:
        st.markdown('<h1sub>Longest Routes</h1sub>', unsafe_allow_html=True)
        longest = driver_day.sort(col('DISTANCE').desc()).limit(5)
        st.altair_chart(bar_creation(longest, 'DISTANCE', 'TRIP_NAME'))
except Exception as e:
    st.warning(f"Could not load route charts: {e}")

st.divider()

# Individual route view
st.markdown('<h1sub>Individual Route Details</h1sub>', unsafe_allow_html=True)

trips_df = get_trips(driver)
if len(trips_df) > 0:
    selected_route = st.selectbox('Choose Trip (sorted by distance):', trips_df.TRIP_NAME)
    trip_id = trips_df.query(f'TRIP_NAME == "{selected_route}"').TRIP_ID.iloc[0]
    
    # Get selected trip details
    selected_trip = trip_summary.filter(col('TRIP_ID') == trip_id)
    selected_trip = selected_trip.with_column('LONP', call_function('ST_X', col('ORIGIN')))
    selected_trip = selected_trip.with_column('LATP', call_function('ST_Y', col('ORIGIN')))
    selected_trip = selected_trip.with_column('LOND', call_function('ST_X', col('DESTINATION')))
    selected_trip = selected_trip.with_column('LATD', call_function('ST_Y', col('DESTINATION')))
    
    trip_data = selected_trip.to_pandas()
    
    if len(trip_data) > 0:
        # Trip stats
        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("Distance", f"{trip_data['ROUTE_DISTANCE_METERS'].iloc[0]/1000:.2f} km")
        with col2:
            st.metric("Duration", f"{trip_data['ROUTE_DURATION_SECS'].iloc[0]/60:.1f} min")
        with col3:
            st.metric("Avg Speed", f"{trip_data['AVERAGE_KMH'].iloc[0]:.1f} km/h")
        with col4:
            st.metric("Pickup Time", trip_data['PICKUP_TIME'].iloc[0].strftime('%H:%M'))
        
        # Get driver positions for this trip, sorted by POINT_INDEX for correct route order
        trip_locations = all_driver_locations.filter(col('TRIP_ID') == trip_id)
        times = trip_locations.select(
            col('POINT_TIME').alias('POINT_TIME'),
            col('POINT_INDEX')
        ).sort(col('POINT_INDEX')).to_pandas()
        
        if len(times) > 0:
            times['POINT_TIME'] = pd.to_datetime(times['POINT_TIME'], errors='coerce')
            times = times.sort_values('POINT_INDEX').reset_index(drop=True)  # Ensure sorted by route position
            times['POINT_TIME_STR'] = times['POINT_TIME'].dt.strftime('%Y-%m-%d %H:%M:%S')
            
            # Create slider options with point index for reliable lookup
            slider_options = times['POINT_TIME_STR'].tolist()
            Choose_Time = st.select_slider("Track driver position:", slider_options)
            
            # Get the POINT_INDEX for the selected time
            selected_idx = times[times['POINT_TIME_STR'] == Choose_Time]['POINT_INDEX'].iloc[0]
            
            # Get current position using POINT_INDEX for precise matching
            current_pos = trip_locations.filter(
                col('POINT_INDEX') == int(selected_idx)
            ).to_pandas()
            
            if len(current_pos) > 0:
                # Build map
                # Route geometry
                route_geom = session.sql(f"""
                    SELECT ST_ASGEOJSON(GEOMETRY) AS GEOM 
                    FROM FLEET_INTELLIGENCE.ANALYTICS.TRIP_SUMMARY 
                    WHERE TRIP_ID = '{trip_id}'
                """).collect()[0]['GEOM']
                
                route_coords = json.loads(route_geom)['coordinates']
                
                # Calculate route progress (from origin to current position)
                current_lon = float(current_pos['LON'].iloc[0])
                current_lat = float(current_pos['LAT'].iloc[0])
                current_speed = float(current_pos['KMH'].iloc[0])
                
                # Get trip data as native Python types
                pickup_lon = float(trip_data['LONP'].iloc[0])
                pickup_lat = float(trip_data['LATP'].iloc[0])
                dropoff_lon = float(trip_data['LOND'].iloc[0])
                dropoff_lat = float(trip_data['LATD'].iloc[0])
                origin_addr = str(trip_data['ORIGIN_ADDRESS'].iloc[0])
                dest_addr = str(trip_data['DESTINATION_ADDRESS'].iloc[0])
                
                # Create layers
                # Full route (orange)
                route_layer = pdk.Layer(
                    type="PathLayer",
                    data=[{"coordinates": route_coords}],
                    get_path="coordinates",
                    get_color=[253, 180, 107],
                    width_min_pixels=4,
                    width_max_pixels=6
                )
                
                # Pickup point (blue)
                pickup_layer = pdk.Layer(
                    'ScatterplotLayer',
                    data=[{
                        'lon': pickup_lon,
                        'lat': pickup_lat,
                        'tooltip': f"Pickup: {origin_addr}"
                    }],
                    get_position=['lon', 'lat'],
                    get_radius=50,
                    radius_min_pixels=8,
                    radius_max_pixels=15,
                    get_color=[41, 181, 232],
                    pickable=True
                )
                
                # Dropoff point (blue)
                dropoff_layer = pdk.Layer(
                    'ScatterplotLayer',
                    data=[{
                        'lon': dropoff_lon,
                        'lat': dropoff_lat,
                        'tooltip': f"Dropoff: {dest_addr}"
                    }],
                    get_position=['lon', 'lat'],
                    get_radius=50,
                    radius_min_pixels=8,
                    radius_max_pixels=15,
                    get_color=[41, 181, 232],
                    pickable=True
                )
                
                # Current position (dark)
                current_layer = pdk.Layer(
                    'ScatterplotLayer',
                    data=[{
                        'lon': current_lon,
                        'lat': current_lat,
                        'tooltip': f"Current: {Choose_Time}\nSpeed: {current_speed:.1f} km/h"
                    }],
                    get_position=['lon', 'lat'],
                    get_radius=80,
                    radius_min_pixels=12,
                    radius_max_pixels=20,
                    get_color=[0, 53, 69],
                    pickable=True
                )
                
                # Center map
                center_lon = (pickup_lon + dropoff_lon) / 2
                center_lat = (pickup_lat + dropoff_lat) / 2
                
                view_state = pdk.ViewState(
                    latitude=center_lat,
                    longitude=center_lon,
                    zoom=13
                )
                
                tooltip = {
                    "html": "{tooltip}",
                    "style": {"backgroundColor": "#24323D", "color": "white"}
                }
                
                col1, col2 = st.columns([0.6, 0.4])
                
                with col1:
                    st.pydeck_chart(pdk.Deck(
                        map_style=None,
                        initial_view_state=view_state,
                        layers=[route_layer, pickup_layer, dropoff_layer, current_layer],
                        tooltip=tooltip
                    ))
                
                with col2:
                    st.markdown('<h1sub>Trip Details</h1sub>', unsafe_allow_html=True)
                    
                    # Extract values as native Python types
                    pickup_time = trip_data['PICKUP_TIME'].iloc[0]
                    dropoff_time = trip_data['ACTUAL_DROPOFF_TIME'].iloc[0]
                    distance_km = float(trip_data['ROUTE_DISTANCE_METERS'].iloc[0]) / 1000
                    duration_mins = float(trip_data['ROUTE_DURATION_SECS'].iloc[0]) / 60
                    avg_speed = float(trip_data['AVERAGE_KMH'].iloc[0])
                    
                    st.markdown(f"""
                    **From:** {origin_addr}
                    
                    **To:** {dest_addr}
                    
                    **Pickup Time:** {pickup_time.strftime('%H:%M:%S')}
                    
                    **Dropoff Time:** {dropoff_time.strftime('%H:%M:%S')}
                    
                    **Distance:** {distance_km:.2f} km
                    
                    **Duration:** {duration_mins:.1f} minutes
                    
                    **Current Position:** {Choose_Time}
                    
                    **Current Speed:** {current_speed:.1f} km/h
                    """)
                
                # AI Analysis section - full width below the map
                st.markdown("---")
                if st.checkbox("🤖 Show AI Trip Analysis"):
                    with st.spinner("Analyzing with Snowflake Cortex..."):
                        try:
                            ai_prompt = f"Analyze this SF taxi trip from {origin_addr} to {dest_addr}, {distance_km:.2f}km in {duration_mins:.1f}min. Brief insights on trip purpose and traffic."
                            
                            # Use Snowpark to avoid SQL injection issues
                            from snowflake.snowpark.functions import call_function, lit
                            result_df = session.create_dataframe([[ai_prompt]], schema=['prompt'])
                            result_df = result_df.select(call_function('snowflake.cortex.complete', lit('claude-3-5-sonnet'), result_df['prompt']).alias('analysis'))
                            result = result_df.collect()[0]['ANALYSIS']
                            
                            st.info(str(result))
                        except Exception as e:
                            st.error(f"Analysis failed: {e}")
else:
    st.warning("No trips found for this driver")
