# NYC Taxi Fleet Intelligence Control Center
# Main entry point for multi-page Streamlit app

import streamlit as st
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.functions import *
from city_config import get_city

CITY = get_city("New York")

# Page configuration
st.set_page_config(
    page_title="NYC Taxi Control Center",
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

# Main page header
st.markdown('''
<h0black>New York Taxi |</h0black><h0blue>Control Center</h0blue><BR>
<h1grey>Fleet Intelligence Dashboard</h1grey>
''', unsafe_allow_html=True)

st.divider()

# Overview statistics
st.markdown('<h1sub>Fleet Overview</h1sub>', unsafe_allow_html=True)

col1, col2, col3, col4 = st.columns(4)

# Get summary stats
try:
    trips_count = session.table('OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.TRIPS').count()
    drivers_count = session.table('OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.TRIPS_ASSIGNED_TO_DRIVERS').select('DRIVER_ID').distinct().count()
    routes_count = session.table('OPENROUTESERVICE_NATIVE_APP.FLEET_INTELLIGENCE_TAXIS.ROUTE_NAMES').count()
    
    with col1:
        st.metric("Total Trips", f"{trips_count:,}")
    with col2:
        st.metric("Active Drivers", f"{drivers_count:,}")
    with col3:
        st.metric("Route Plans", f"{routes_count:,}")
    with col4:
        st.metric("Data Source", "NYC Taxis")
except Exception as e:
    st.warning("Connect to Snowflake and run setup_data.sql to load the fleet data.")
    st.error(f"Error: {e}")

st.divider()

# Navigation instructions
st.markdown('''
### Navigate the Control Center

Use the sidebar to access different views:

- **🚖 Driver Routes** - Track individual driver journeys with route visualization and AI insights
- **🗺️ Heat Map** - View driver density across NYC with H3 hexagon visualization

### Features

- **Real-time route tracking** with pickup/dropoff locations
- **AI-powered trip analysis** using Snowflake Cortex
- **Interactive maps** with pydeck visualization
- **Driver performance metrics** including speed and distance analytics
- **Time-based filtering** to analyze trips by hour and minute
''', unsafe_allow_html=True)

st.divider()

st.markdown('''
<h1grey>Powered by Snowflake & Open Route Service</h1grey>
''', unsafe_allow_html=True)
