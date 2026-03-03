# Local development version of NYC Beauty Supply Chain Route Optimizer
import altair as alt
import streamlit as st
import pandas as pd
import pydeck as pdk
import json
import os
from pathlib import Path

# Import Snowflake libraries
try:
    from snowflake.snowpark import Session
    from snowflake.snowpark.functions import *
    from snowflake.snowpark.types import FloatType, StringType, IntegerType
    from snowflake.snowpark.window import Window
except ImportError as e:
    st.error(f"Failed to import Snowflake libraries: {e}")
    st.stop()

# Initialize Streamlit page config
st.set_page_config(layout="wide", page_title="NYC Beauty Supply Chain Optimizer")

@st.cache_resource
def get_snowflake_session():
    """Create Snowflake session for local development"""
    try:
        # Try to import local config
        try:
            from snowflake_config import SNOWFLAKE_CONFIG
        except ImportError:
            st.error("""
            ❌ **Missing Snowflake Configuration**
            
            Please create a `snowflake_config.py` file based on `snowflake_config.template.py`
            with your Snowflake connection details.
            """)
            st.stop()
            
        # Create session
        session = Session.builder.configs(SNOWFLAKE_CONFIG).create()
        return session
        
    except Exception as e:
        st.error(f"❌ **Failed to connect to Snowflake**: {str(e)}")
        st.info("""
        **Troubleshooting Tips:**
        1. Verify your connection details in `snowflake_config.py`
        2. Ensure your Snowflake account is accessible
        3. Check that your user has the required permissions
        4. Verify the database and schema exist
        """)
        st.stop()

# Initialize Snowflake session
session = get_snowflake_session()

# Load custom CSS (fallback if not available)
css_content = """
<style>
h0black { color: #1e3a8a; font-size: 2.5rem; font-weight: bold; }
h0blue { color: #3b82f6; font-size: 2.5rem; font-weight: bold; }
h1grey { color: #6b7280; font-size: 1.2rem; margin-top: -10px; }
h1sub { color: #374151; font-size: 1.5rem; font-weight: 600; }
veh1 { color: #7c3aed; font-weight: bold; }
veh2 { color: #d946ef; font-weight: bold; }
veh3 { color: #f59e0b; font-weight: bold; }
</style>
"""

try:
    # Try to load custom CSS from parent directory
    css_path = Path(__file__).parent.parent / "dataops/event/homepage/docs/stylesheets/extra.css"
    if css_path.exists():
        with open(css_path) as f:
            css_content = f"<style>{f.read()}</style>"
except:
    pass

st.markdown(css_content, unsafe_allow_html=True)

# Set sidebar logo (fallback if not available)
try:
    logo_path = Path(__file__).parent.parent / "dataops/event/streamlit/logo.svg"
    if logo_path.exists():
        st.logo(str(logo_path))
except:
    pass

# Main application header
st.markdown('''
<h0black>NYC BEAUTY SUPPLY CHAIN |</h0black><h0blue> ROUTE OPTIMIZATION</h0blue><BR>
<h1grey>Powered by the Open Route Service Native App - Local Development</h1grey>
''', unsafe_allow_html=True)

with st.sidebar:
    route_functions_option = st.radio('Where are the routing functions', ['OPEN_ROUTE_SERVICE_NEW_YORK','OPENROUTESERVICE_NATIVE_APP', 'VEHICLE_ROUTING_SIMULATOR'])

# Define routing methods
methods = ['driving-car', 'driving-hgv', 'cycling-road']

# Connection status indicator
with st.sidebar:
    st.markdown("### 🔗 Connection Status")
    try:
        test_query = session.sql("SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_DATABASE()").collect()
        st.success("✅ Connected to Snowflake")
        st.caption(f"User: {test_query[0][0]}")
        st.caption(f"Role: {test_query[0][1]}")
        st.caption(f"Database: {test_query[0][2]}")
    except Exception as e:
        st.error(f"❌ Connection issue: {str(e)}")

# Data loading with error handling
@st.cache_data
def load_data_safely(table_name, display_name):
    """Safely load data from Snowflake with error handling"""
    try:
        return session.table(table_name)
    except Exception as e:
        st.error(f"❌ Failed to load {display_name}: {str(e)}")
        st.info(f"""
        **Expected table**: `{table_name}`
        
        Please ensure:
        1. The table exists in your Snowflake environment
        2. You have SELECT permissions on the table
        3. Your database and schema are correct
        """)
        return None

# Load NYC Beauty Supply Chain data
st.markdown("### 📊 Loading Data...")
with st.spinner("Loading beauty supply chain data..."):
    beauty_depots = load_data_safely('FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_DEPOTS', 'Beauty Depots')
    beauty_fleet = load_data_safely('FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_FLEET', 'Beauty Fleet')
    beauty_jobs = load_data_safely('FLEET_INTELLIGENCE.PUBLIC.NYC_BEAUTY_DELIVERY_JOBS', 'Beauty Jobs')

# Check if all data loaded successfully
if not all([beauty_depots, beauty_fleet, beauty_jobs]):
    st.warning("""
    ⚠️ **Some data tables could not be loaded.**
    
    This might be because:
    - The marketplace listing is not available in your environment
    - Tables need to be created first
    - Different database/schema configuration
    
    Please check the main lab setup instructions.
    """)
    st.stop()

with st.sidebar:
    st.markdown('##### Depot Selection')
    
    # Get depot options with error handling
    try:
        depot_options = beauty_depots.select('DEPOT_NAME', 'DEPOT_ID').to_pandas()
        depot_names = depot_options['DEPOT_NAME'].tolist()
        
        if not depot_names:
            st.error("No depots found in the data")
            st.stop()
            
        selected_depot = st.selectbox('Choose Depot:', depot_names)
        selected_depot_id = depot_options[depot_options['DEPOT_NAME'] == selected_depot]['DEPOT_ID'].iloc[0]
        
        # Filter depot data
        selected_depot_data = beauty_depots.filter(col('DEPOT_ID') == selected_depot_id)
        depot_pandas = selected_depot_data.to_pandas()
        
        if depot_pandas.empty:
            st.error("Selected depot not found")
            st.stop()
        
        st.markdown(f'**Depot:** {depot_pandas.DEPOT_NAME.iloc[0]}')
        st.markdown(f'**Borough:** {depot_pandas.BOROUGH.iloc[0]}')
        st.markdown(f'**Address:** {depot_pandas.ADDRESS.iloc[0]}')
        st.markdown(f'**Daily Capacity:** {depot_pandas.DAILY_SHIPMENT_CAPACITY.iloc[0]} shipments')
        st.markdown(f'**Assigned Vehicles:** {depot_pandas.ASSIGNED_VEHICLES.iloc[0]}')

        depot_lat = depot_pandas.LATITUDE.iloc[0]
        depot_lon = depot_pandas.LONGITUDE.iloc[0]
        
    except Exception as e:
        st.error(f"Error loading depot data: {str(e)}")
        st.stop()

# Display depot on map
depot_layer = pdk.Layer(
    'ScatterplotLayer',
    depot_pandas,
    get_position=['LONGITUDE', 'LATITUDE'],
    filled=True,
    stroked=False,
    radius_min_pixels=8,
    radius_max_pixels=25,
    auto_highlight=True,
    get_fill_color=[41, 181, 232],
    pickable=True
)

view_state = pdk.ViewState(depot_lon, depot_lat, zoom=10)

with st.sidebar:
    st.caption(f'Selected Depot: {selected_depot}')
    depot_tooltip = {
        "html": """<b>Depot:</b> {DEPOT_NAME} <br><b>Borough:</b> {BOROUGH} <br><b>Capacity:</b> {DAILY_SHIPMENT_CAPACITY} shipments""",
        "style": {
            "backgroundColor": "steelblue",
            "color": "white",
            "text-wrap": "balance"
        }
    }
    st.pydeck_chart(pdk.Deck(layers=[depot_layer], map_style=None, initial_view_state=view_state, tooltip=depot_tooltip))

st.divider()

# Vehicle Fleet Configuration
st.markdown('<h1sub>Available Fleet for Depot</h1sub>', unsafe_allow_html=True)

# Get vehicles for selected depot - FIXED TYPE-SAFE FILTERING
depot_fleet = beauty_fleet.filter(
    (col('DEPOT_ID') == selected_depot_id) |  # Try exact match first
    (col('DEPOT_ID') == str(selected_depot_id)) |  # Try string version
    (col('DEPOT_ID') == int(selected_depot_id))     # Try integer version
)
fleet_pandas = depot_fleet.to_pandas()

if fleet_pandas.empty:
    st.warning(f'No vehicles found for {selected_depot}')
    st.info("Please check if vehicles are assigned to this depot.")
    st.stop()
else:
    # Display fleet information
    col1, col2, col3 = st.columns(3)
    
    with col1:
        st.markdown('<veh1>Available Vehicles</veh1>', unsafe_allow_html=True)
        st.dataframe(fleet_pandas[['VEHICLE_ID', 'VEHICLE_TYPE', 'CAPACITY_UNITS', 'SKILLS_LEVEL']].rename(columns={
            'VEHICLE_ID': 'Vehicle ID',
            'VEHICLE_TYPE': 'Type', 
            'CAPACITY_UNITS': 'Capacity',
            'SKILLS_LEVEL': 'Skills'
        }))
    
    with col2:
        st.markdown('<veh2>Vehicle Selection</veh2>', unsafe_allow_html=True)
        selected_vehicles = st.multiselect(
            'Select vehicles for optimization:',
            options=fleet_pandas['VEHICLE_ID'].tolist(),
            default=fleet_pandas['VEHICLE_ID'].tolist()[:3]  # Default to first 3 vehicles
        )
    
    with col3:
        st.markdown('<veh3>Route Configuration</veh3>', unsafe_allow_html=True)
        start_time = st.number_input('Fleet Start Time (Hours):', 0, 24, 8)
        end_time = st.number_input('Fleet End Time (Hours):', start_time, 24, 17)
        routing_method = st.selectbox('Routing Method:', methods)

# Development info
st.info("""
🔧 **Local Development Mode**

This is a local development version of the NYC Beauty Supply Chain Optimizer. 

**Features available:**
- ✅ Snowflake data connectivity
- ✅ Depot selection and visualization
- ✅ Fleet management interface
- ✅ Basic mapping capabilities

**Limitations in local mode:**
- ⚠️ Route optimization requires the native app to be installed
- ⚠️ Some advanced features may need additional configuration
- ⚠️ Full functionality available when deployed to Snowflake environment

**To test full functionality:**
Deploy to Snowflake using the provided deployment scripts.
""")

# Additional information section
st.divider()
st.markdown('<h1sub>Beauty Supply Chain Information</h1sub>', unsafe_allow_html=True)

info_col1, info_col2 = st.columns(2)

with info_col1:
    st.markdown("""
    **Product Categories:**
    - Hair Products (Skill Level 1)
    - Electronic Goods (Skill Level 2)  
    - Make-up (Skill Level 3)
    
    **Vehicle Skills:**
    - Level 1: Basic delivery capability
    - Level 2: Electronics handling
    - Level 3: Premium product delivery
    """)

with info_col2:
    st.markdown("""
    **Depot Network:**
    - Manhattan Beauty Central
    - Brooklyn Hair Hub
    - Queens Cosmetics Center
    - Bronx Beauty Warehouse
    
    **Optimization Features:**
    - Capacity-based assignment
    - Skill-based matching
    - Time window constraints
    - Geographic optimization
    """)
