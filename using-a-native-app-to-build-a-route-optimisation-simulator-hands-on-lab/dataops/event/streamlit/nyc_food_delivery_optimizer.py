"""
NYC Food Delivery Route Optimizer
"""

import streamlit as st
import pydeck as pdk
import pandas as pd
import json
import altair as alt
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.functions import col, call_function, lit, object_construct, array_agg, array_construct
from snowflake.snowpark.types import DecimalType, FloatType, IntegerType

# Initialize Snowflake session
session = get_active_session()

# Page configuration
st.set_page_config(
    page_title="NYC Food Delivery Optimizer",
    page_icon="🍕",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Load custom CSS for Snowflake branding
with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

# Set sidebar logo
st.logo('logo.svg')

# Main application header with Snowflake branding
st.markdown('''
<h0black>NYC FOOD DELIVERY |</h0black><h0blue> ROUTE OPTIMIZER</h0blue><BR>
<h1grey>Powered by Snowflake and Open Route Service</h1grey>
''', unsafe_allow_html=True)

# Load depot data
@st.cache_data
def load_depot_data():
    """Load food delivery depot information"""
    depots_query = """
    SELECT 
        DEPOT_ID,
        DEPOT_NAME,
        DEPOT_TYPE,
        BOROUGH,
        NEIGHBORHOOD,
        LATITUDE,
        LONGITUDE,
        CUISINE_TYPE,
        RESTAURANT_NAME,
        TEMPERATURE_CONTROLLED
    FROM FLEET_INTELLIGENCE.PUBLIC.NYC_FOOD_DEPOTS
    ORDER BY DEPOT_ID
    """
    return session.sql(depots_query).to_pandas()

# Load vehicle data for a specific depot
def load_vehicles_for_depot(depot_id):
    """Load vehicles for the selected depot"""
    vehicles_query = f"""
    SELECT 
        VEHICLE_ID,
        DEPOT_ID,
        DEPOT_NAME,
        VEHICLE_TYPE,
        START_LONGITUDE,
        START_LATITUDE,
        OPTIMIZATION_SKILLS,
        OPTIMIZATION_CAPACITY,
        OPTIMIZATION_START_COORDS,
        OPTIMIZATION_END_COORDS,
        OPTIMIZATION_TIME_WINDOW,
        TEMPERATURE_CONTROLLED,
        FUEL_TYPE
    FROM FLEET_INTELLIGENCE.PUBLIC.NYC_FOOD_FLEET
    WHERE DEPOT_ID = {depot_id}
    ORDER BY VEHICLE_ID
    """
    return session.sql(vehicles_query)

# Load job data for a specific depot
def load_jobs_for_depot(depot_id):
    """Load delivery jobs for the selected depot"""
    # Convert depot_id to integer to ensure proper type
    depot_assignment = int(depot_id) - 1
    
    jobs_query = f"""
    SELECT 
        JOB_ID,
        CUSTOMER_NAME,
        DELIVERY_ADDRESS,
        DELIVERY_LONGITUDE,
        DELIVERY_LATITUDE,
        ORDER_TYPE,
        FOOD_CATEGORY,
        TEMPERATURE_REQUIREMENT,
        OPTIMIZATION_CAPACITY,
        OPTIMIZATION_SKILLS,
        OPTIMIZATION_TIME_WINDOW,
        OPTIMIZATION_LOCATION,
        OPTIMIZATION_JOB_ID,
        ORDER_VALUE,
        SPECIAL_INSTRUCTIONS
    FROM FLEET_INTELLIGENCE.PUBLIC.NYC_FOOD_DELIVERY_JOBS
    WHERE OPTIMIZATION_JOB_ID % 5 = {depot_assignment}
    AND DELIVERY_DATE = '2024-01-15'
    LIMIT 20
    """
    return session.sql(jobs_query)

# Sidebar for depot selection
st.sidebar.markdown('<h1sub>🏪 Restaurant/Depot Selection</h1sub>', unsafe_allow_html=True)

try:
    depots_pandas = load_depot_data()
    
    if not depots_pandas.empty:
        depot_options = {}
        for _, row in depots_pandas.iterrows():
            depot_display = f"{row['RESTAURANT_NAME']} ({row['DEPOT_TYPE']}, {row['BOROUGH']})"
            depot_options[depot_display] = row['DEPOT_ID']
        
        selected_depot_name = st.sidebar.selectbox(
            "Choose a restaurant/depot:",
            list(depot_options.keys())
        )
        
        selected_depot_id = depot_options[selected_depot_name]
        
        # Get selected depot details
        selected_depot = depots_pandas[depots_pandas['DEPOT_ID'] == selected_depot_id].iloc[0]
        depot_lat = selected_depot['LATITUDE']
        depot_lon = selected_depot['LONGITUDE']
        
        st.sidebar.success(f"✅ Selected: {selected_depot['RESTAURANT_NAME']}")
        st.sidebar.info(f"🍽️ Cuisine: {selected_depot['CUISINE_TYPE']}")
        st.sidebar.info(f"❄️ Temperature Control: {'Yes' if selected_depot['TEMPERATURE_CONTROLLED'] else 'No'}")
        
        # Add depot locations map to sidebar
        st.sidebar.markdown("---")
        st.sidebar.markdown('<h1sub>📍 NYC Food Delivery Network</h1sub>', unsafe_allow_html=True)
        
        # Create depot map data with colors
        depot_map_data = depots_pandas.copy()
        depot_map_data['color'] = depot_map_data['DEPOT_ID'].apply(
            lambda x: [255, 140, 0] if x == selected_depot_id else [100, 100, 100]
        )
        depot_map_data['radius'] = depot_map_data['DEPOT_ID'].apply(
            lambda x: 300 if x == selected_depot_id else 150
        )
        
        # Tooltip for depot information
        depot_tooltip = {
            "html": """<b>Restaurant:</b> {RESTAURANT_NAME}<br><b>Type:</b> {DEPOT_TYPE}<br><b>Cuisine:</b> {CUISINE_TYPE}<br><b>Borough:</b> {BOROUGH}""",
            "style": {
                "width": "60%",
                "backgroundColor": "#29B5E8",
                "color": "white",
                "text-wrap": "balance"
            }
        }
        
        # Create depot layer
        depot_layer = pdk.Layer(
            'ScatterplotLayer',
            depot_map_data,
            get_position=['LONGITUDE', 'LATITUDE'],
            filled=True,
            stroked=True,
            radius_min_pixels=8,
            radius_max_pixels=15,
            auto_highlight=True,
            get_fill_color='color',
            get_line_color=[255, 255, 255],
            get_radius='radius',
            pickable=True
        )
        
        # View state centered on NYC
        depot_view_state = pdk.ViewState(
            longitude=-73.98,
            latitude=40.75,
            zoom=10,
            pitch=0
        )
        
        # Display depot map in sidebar
        st.sidebar.pydeck_chart(
            pdk.Deck(
                layers=[depot_layer], 
                map_style=None, 
                initial_view_state=depot_view_state, 
                tooltip=depot_tooltip,
                height=400
            )
        )
        
        st.sidebar.caption(f"🎯 Selected restaurant highlighted in orange")
        
    else:
        st.error("❌ No depot data available")
        st.stop()
        
except Exception as e:
    st.error(f"❌ Error loading depot data: {e}")
    st.stop()

# Main content
col1, col2 = st.columns([1, 1])

with col1:
    st.markdown('<h1sub>🚚 Delivery Vehicles</h1sub>', unsafe_allow_html=True)
    
    try:
        vehicles_df = load_vehicles_for_depot(selected_depot_id)
        vehicles_pandas = vehicles_df.to_pandas()
        
        if not vehicles_pandas.empty:
            st.markdown(f'<h1grey>{len(vehicles_pandas)} vehicles available at this location</h1grey>', unsafe_allow_html=True)
            
            # Vehicle selection
            vehicle_options = st.multiselect(
                "Select vehicles for optimization:",
                vehicles_pandas['VEHICLE_ID'].tolist(),
                default=vehicles_pandas['VEHICLE_ID'].tolist()[:2]  # Default to first 2
            )
            
            if vehicle_options:
                selected_vehicles_df = vehicles_pandas[vehicles_pandas['VEHICLE_ID'].isin(vehicle_options)]
                
                # Style the vehicle dataframe
                st.dataframe(
                    selected_vehicles_df[['VEHICLE_ID', 'VEHICLE_TYPE', 'OPTIMIZATION_CAPACITY', 'OPTIMIZATION_SKILLS', 'FUEL_TYPE', 'TEMPERATURE_CONTROLLED']],
                    use_container_width=True,
                    hide_index=True,
                    column_config={
                        "VEHICLE_ID": st.column_config.TextColumn("🚚 Vehicle ID", width="small"),
                        "VEHICLE_TYPE": st.column_config.TextColumn("🏷️ Type", width="medium"),
                        "OPTIMIZATION_CAPACITY": st.column_config.ListColumn("📦 Capacity", width="small"),
                        "OPTIMIZATION_SKILLS": st.column_config.ListColumn("🔧 Skills", width="small"),
                        "FUEL_TYPE": st.column_config.TextColumn("⛽ Fuel", width="small"),
                        "TEMPERATURE_CONTROLLED": st.column_config.CheckboxColumn("❄️ Temp", width="small")
                    }
                )
            else:
                st.warning("⚠️ Please select at least one vehicle")
                
        else:
            st.error("❌ No vehicles found for this depot")
            
    except Exception as e:
        st.error(f"❌ Error loading vehicles: {e}")
        vehicle_options = []

with col2:
    st.markdown('<h1sub>📦 Customer Orders</h1sub>', unsafe_allow_html=True)
    
    try:
        jobs_df = load_jobs_for_depot(selected_depot_id)
        jobs_pandas = jobs_df.to_pandas()
        
        if not jobs_pandas.empty:
            st.markdown(f'<h1grey>{len(jobs_pandas)} customer orders available</h1grey>', unsafe_allow_html=True)
            
            # Job selection
            job_options = st.multiselect(
                "Select orders for delivery optimization:",
                jobs_pandas['JOB_ID'].tolist(),
                default=jobs_pandas['JOB_ID'].tolist()[:8]  # Default to first 8
            )
            
            if job_options:
                selected_jobs_df = jobs_pandas[jobs_pandas['JOB_ID'].isin(job_options)]
                
                # Style the jobs dataframe
                st.dataframe(
                    selected_jobs_df[['JOB_ID', 'CUSTOMER_NAME', 'FOOD_CATEGORY', 'TEMPERATURE_REQUIREMENT', 'ORDER_VALUE', 'OPTIMIZATION_CAPACITY', 'OPTIMIZATION_SKILLS']],
                    use_container_width=True,
                    hide_index=True,
                    column_config={
                        "JOB_ID": st.column_config.TextColumn("📋 Order ID", width="small"),
                        "CUSTOMER_NAME": st.column_config.TextColumn("👤 Customer", width="medium"),
                        "FOOD_CATEGORY": st.column_config.TextColumn("🍕 Food Type", width="small"),
                        "TEMPERATURE_REQUIREMENT": st.column_config.TextColumn("🌡️ Temp", width="small"),
                        "ORDER_VALUE": st.column_config.NumberColumn("💰 Value", width="small", format="$%.2f"),
                        "OPTIMIZATION_CAPACITY": st.column_config.ListColumn("📦 Size", width="small"),
                        "OPTIMIZATION_SKILLS": st.column_config.ListColumn("🔧 Req", width="small")
                    }
                )
            else:
                st.warning("⚠️ Please select at least one order")
                
        else:
            st.error("❌ No orders found for this depot")
            
    except Exception as e:
        st.error(f"❌ Error loading orders: {e}")
        job_options = []

# Route optimization
st.markdown('<h1sub>🎯 Delivery Route Optimization</h1sub>', unsafe_allow_html=True)

if st.button("🚀 Optimize Delivery Routes", type="primary"):
    if not vehicle_options:
        st.error("❌ Please select at least one vehicle")
    elif not job_options:
        st.error("❌ Please select at least one order")
    else:
        with st.spinner("🔄 Optimizing delivery routes..."):
            try:
                # Prepare optimization data following routing.py pattern
                selected_vehicles = vehicles_df.filter(col('VEHICLE_ID').isin(vehicle_options))
                selected_jobs = jobs_df.filter(col('JOB_ID').isin(job_options))
                
                if selected_vehicles.count() == 0:
                    st.error("❌ No vehicles selected after filtering")
                    st.stop()
                if selected_jobs.count() == 0:
                    st.error("❌ No jobs selected after filtering")
                    st.stop()
                
                # Create VEHICLE objects with INTEGER IDs (following routing.py pattern)
                try:
                    # Create proper vehicle objects with numeric IDs
                    vehicle_rows = []
                    for i, vehicle_id in enumerate(vehicle_options):
                        vehicle_row = selected_vehicles.filter(col('VEHICLE_ID') == vehicle_id)
                        vehicle_with_id = vehicle_row.with_column('VEHICLE',
                            object_construct(
                                lit('id'), lit(i + 1),  # Integer ID starting from 1
                                lit('profile'), lit('driving-car'),
                                lit('start'), array_construct(
                                    col('OPTIMIZATION_START_COORDS')[0].cast(DecimalType(10,5)),
                                    col('OPTIMIZATION_START_COORDS')[1].cast(DecimalType(10,5))
                                ),  # FIXED: Convert to decimal format, avoid scientific notation
                                lit('end'), array_construct(
                                    col('OPTIMIZATION_END_COORDS')[0].cast(DecimalType(10,5)),
                                    col('OPTIMIZATION_END_COORDS')[1].cast(DecimalType(10,5))
                                ),  # FIXED: Convert to decimal format, avoid scientific notation
                                lit('capacity'), col('OPTIMIZATION_CAPACITY'),
                                lit('skills'), col('OPTIMIZATION_SKILLS'),
                                lit('time_windows'), array_construct(
                                    (col('OPTIMIZATION_TIME_WINDOW')[0] * 60).cast('INTEGER'),  # Convert to integer seconds
                                    (col('OPTIMIZATION_TIME_WINDOW')[1] * 60).cast('INTEGER')   # Convert to integer seconds
                                )  # FIXED: Convert to integer seconds
                            )
                        )
                        vehicle_rows.append(vehicle_with_id)
                    
                    # Union all vehicles
                    vehicles_data = vehicle_rows[0]
                    for vehicle_row in vehicle_rows[1:]:
                        vehicles_data = vehicles_data.union(vehicle_row)
                        
                except Exception as vehicle_error:
                    st.error(f"❌ Error creating vehicle objects: {vehicle_error}")
                    st.stop()
                
                # Create JOB objects with INTEGER IDs (following routing.py pattern)  
                job_rows = []
                for i, job_id in enumerate(job_options):
                    job_row = selected_jobs.filter(col('JOB_ID') == job_id)
                    job_with_id = job_row.with_column('JOB',
                        object_construct(
                            lit('id'), lit(i + 1),  # Integer ID starting from 1
                            lit('capacity'), col('OPTIMIZATION_CAPACITY'),  # FIXED: use 'capacity' like routing.py
                            lit('skills'), col('OPTIMIZATION_SKILLS'),
                            lit('time_window'), array_construct(
                                (col('OPTIMIZATION_TIME_WINDOW')[0] * 60).cast('INTEGER'),  # Convert to integer seconds
                                (col('OPTIMIZATION_TIME_WINDOW')[1] * 60).cast('INTEGER')   # Convert to integer seconds
                            ),  # FIXED: Convert to integer seconds
                            lit('location'), array_construct(
                                col('OPTIMIZATION_LOCATION')[0].cast(DecimalType(10,5)),
                                col('OPTIMIZATION_LOCATION')[1].cast(DecimalType(10,5))
                            )  # FIXED: Convert to decimal format, avoid scientific notation
                        )
                    )
                    job_rows.append(job_with_id)
                
                # Union all jobs
                jobs_data = job_rows[0]
                for job_row in job_rows[1:]:
                    jobs_data = jobs_data.union(job_row)
                
                # Aggregate into VARIANT arrays (CRITICAL for optimization function)
                vehicles_agg = vehicles_data.select(array_agg('VEHICLE').alias('VEH'))
                jobs_agg = jobs_data.select(array_agg('JOB').alias('JOB'))
                
                st.markdown(f'<h1grey>📊 Optimization Input: {len(vehicle_options)} vehicles, {len(job_options)} orders</h1grey>', unsafe_allow_html=True)
                
                # Call optimization function  
                with st.spinner("🔄 Running optimization..."):
                    try:
                        # Execute the optimization function call
                        optimization_result = jobs_agg.join(vehicles_agg).select(
                            'JOB', 'VEH',
                            call_function('OPEN_ROUTE_SERVICE_NEW_YORK.CORE.OPTIMIZATION', col('JOB'), col('VEH')).alias('OPTIMIZATION')
                        )
                        
                        # Collect the results
                        collected_results = optimization_result.collect()
                        
                    except Exception as optimization_error:
                        st.error(f"❌ **Optimization failed:** {str(optimization_error)}")
                        optimization_result = None
                        collected_results = None
                
                # Process results - SHOW EXACT SERVICE RESPONSE
                if optimization_result and collected_results:
                    # Access the OPTIMIZATION column (index 2), not the first column
                    result_data = collected_results[0][2]  # [0] = first row, [2] = OPTIMIZATION column
                    
                    # Use the optimization result data
                    
                    if result_data and 'routes' in str(result_data).lower():
                        st.success("✅ **Delivery route optimization completed successfully!**")
                        
                        # Follow routing.py pattern: Extract summary for cost information
                        optimization_summary = optimization_result.select(
                            col('OPTIMIZATION')['summary']['cost'].alias('TOTAL_COST'),
                            col('OPTIMIZATION')['summary']['duration'].alias('TOTAL_DURATION'),
                            col('OPTIMIZATION')['summary']['routes'].alias('TOTAL_ROUTES')
                        )
                        
                        # Extract routes using join_table_function flatten
                        optimization_routes = optimization_result.join_table_function('flatten', col('OPTIMIZATION')['routes']).select('VALUE')
                        
                        # Extract route details with correct field paths (based on manual JSON analysis)
                        route_details = optimization_routes.select(
                            col('VALUE')['vehicle'].astype(IntegerType()).alias('VEHICLE_ID'),
                            col('VALUE')['geometry'].alias('GEOMETRY'),
                            col('VALUE')['duration'].astype(FloatType()).alias('DURATION'),
                            col('VALUE')['distance'].astype(FloatType()).alias('DISTANCE'),
                            col('VALUE')['cost'].astype(FloatType()).alias('COST')
                        )
                        
                        # Check for geometry and process following routing.py pattern
                        if route_details is not None:
                            route_pandas = route_details.to_pandas()
                        else:
                            route_pandas = pd.DataFrame()  # Empty DataFrame if extraction failed
                        
                        if not route_pandas.empty and route_pandas['GEOMETRY'].iloc[0] is not None:
                            
                            # Follow routing.py pattern: Process geometry using object_construct and lambda
                            route_geometry_df = route_details.with_column('GEO', 
                                object_construct(lit('coordinates'), col('GEOMETRY'))
                            )
                            
                            # Add Snowflake brand colors for visualization (food delivery theme)
                            food_delivery_colors = [
                                [255, 87, 34],    # Deep Orange (hot food)
                                [76, 175, 80],    # Green (fresh food)
                                [33, 150, 243],   # Blue (frozen food)
                                [156, 39, 176],   # Purple (beverages)
                                [255, 193, 7],    # Amber (desserts)
                                [121, 85, 72]     # Brown (coffee/bakery)
                            ]
                            route_data_with_colors = route_geometry_df.to_pandas()
                            
                            # Apply routing.py pattern: Use lambda with json.loads to extract coordinates
                            route_data_with_colors["coordinates"] = route_data_with_colors["GEO"].apply(
                                lambda row: json.loads(row)["coordinates"]
                            )
                            
                            # Add food delivery brand colors based on vehicle ID
                            route_data_with_colors['R'] = route_data_with_colors['VEHICLE_ID'].apply(
                                lambda x: food_delivery_colors[(x-1) % len(food_delivery_colors)][0]
                            )
                            route_data_with_colors['G'] = route_data_with_colors['VEHICLE_ID'].apply(
                                lambda x: food_delivery_colors[(x-1) % len(food_delivery_colors)][1]
                            )
                            route_data_with_colors['B'] = route_data_with_colors['VEHICLE_ID'].apply(
                                lambda x: food_delivery_colors[(x-1) % len(food_delivery_colors)][2]
                            )
                            
                            # Filter routes with valid coordinates (following routing.py pattern)
                            route_coordinates = route_data_with_colors[
                                route_data_with_colors['coordinates'].apply(lambda x: len(x) > 1)
                            ].copy()
                            
                            # Add TEXT column for route tooltips with vehicle information
                            route_coordinates['TEXT'] = route_coordinates['VEHICLE_ID'].apply(
                                lambda vid: f"<b>DELIVERY VEHICLE:</b> Vehicle {vid}<br><b>Route:</b> Optimized delivery path<br><b>Status:</b> Active delivery route"
                            )
                            
                            if not route_coordinates.empty:
                                
                                # Create enhanced tooltips following routing.py pattern
                                depot_tooltip = {
                                    "html": """<b>RESTAURANT/DEPOT</b><BR>
                                               <b>Name:</b> {RESTAURANT_NAME}<BR>
                                               <b>Type:</b> {DEPOT_TYPE}<BR>
                                               <b>Cuisine:</b> {CUISINE_TYPE}""",
                                    "style": {
                                        "width": "50%",
                                        "backgroundColor": "#29B5E8",
                                        "color": "white",
                                        "text-wrap": "balance"
                                    }
                                }
                                
                                route_tooltip = {
                                    "html": """<b>DELIVERY ROUTE</b><BR>
                                               <b>Route:</b> Optimized Delivery Path<BR>
                                               <b>Status:</b> Active Delivery Route<BR>
                                               <b>Type:</b> Food Delivery""",
                                    "style": {
                                        "width": "60%",
                                        "backgroundColor": "#29B5E8",
                                        "color": "white",
                                        "text-wrap": "balance"
                                    }
                                }
                                
                                jobs_tooltip = {
                                    "html": """<b>CUSTOMER LOCATION</b><BR>
                                               <b>Customer:</b> {CUSTOMER_NAME}<BR>
                                               <b>Food Type:</b> {FOOD_CATEGORY}<BR>
                                               <b>Order Value:</b> ${ORDER_VALUE}""",
                                    "style": {
                                        "width": "50%",
                                        "backgroundColor": "#29B5E8",
                                        "color": "white",
                                        "text-wrap": "balance"
                                    }
                                }
                                
                                # Create depot layer with TEXT column for tooltip
                                depot_layer = pdk.Layer(
                                    'ScatterplotLayer',
                                    data=[{
                                        'lat': depot_lat, 
                                        'lon': depot_lon,
                                        'RESTAURANT_NAME': selected_depot['RESTAURANT_NAME'],
                                        'DEPOT_TYPE': selected_depot['DEPOT_TYPE'],
                                        'CUISINE_TYPE': selected_depot['CUISINE_TYPE'],
                                        'TEXT': f"<b>RESTAURANT:</b> {selected_depot['RESTAURANT_NAME']}<br><b>Type:</b> {selected_depot['DEPOT_TYPE']}<br><b>Cuisine:</b> {selected_depot['CUISINE_TYPE']}"
                                    }],
                                    get_position=['lon', 'lat'],
                                    filled=True,
                                    stroked=True,
                                    radius_min_pixels=8,
                                    radius_max_pixels=15,
                                    get_radius=300,
                                    get_fill_color=[255, 87, 34],  # Deep Orange for food
                                    get_line_color=[255, 255, 255],
                                    line_width_min_pixels=2,
                                    auto_highlight=True,
                                    pickable=True
                                )
                                
                                # Create route paths layer with enhanced styling
                                route_paths_layer = pdk.Layer(
                                    'PathLayer',
                                    data=route_coordinates,
                                    get_path='coordinates',
                                    get_color=['R', 'G', 'B'],
                                    width_min_pixels=4,
                                    width_max_pixels=7,
                                    get_width=5,
                                    auto_highlight=True,
                                    pickable=True
                                )
                                
                                layers = [depot_layer, route_paths_layer]
                                
                                # Jobs layer with enhanced styling (routing.py pattern)
                                if not jobs_pandas.empty and 'DELIVERY_LATITUDE' in jobs_pandas.columns:
                                    selected_jobs_viz = jobs_pandas[jobs_pandas['JOB_ID'].isin(job_options)]
                                    
                                    # Add TEXT column for customer tooltips
                                    selected_jobs_viz = selected_jobs_viz.copy()
                                    selected_jobs_viz['TEXT'] = selected_jobs_viz.apply(
                                        lambda row: f"<b>CUSTOMER:</b> {row['CUSTOMER_NAME']}<br><b>Food Type:</b> {row['FOOD_CATEGORY']}<br><b>Order Value:</b> ${row['ORDER_VALUE']:.2f}", axis=1
                                    )
                                    
                                    jobs_layer = pdk.Layer(
                                        'ScatterplotLayer',
                                        data=selected_jobs_viz,
                                        get_position=['DELIVERY_LONGITUDE', 'DELIVERY_LATITUDE'],
                                        filled=True,
                                        stroked=False,
                                        radius_min_pixels=6,
                                        radius_max_pixels=10,
                                        get_radius=50,  # routing.py pattern
                                        get_fill_color=[76, 175, 80],  # Green for customer locations
                                        auto_highlight=True,
                                        pickable=True
                                    )
                                    layers.append(jobs_layer)
                                
                                # Display map with enhanced styling
                                view_state = pdk.ViewState(
                                    latitude=depot_lat,
                                    longitude=depot_lon,
                                    zoom=11,
                                    pitch=0
                                )
                                
                                
                                deck = pdk.Deck(
                                    map_style=None,  # Match routing.py pattern
                                    initial_view_state=view_state,
                                    layers=layers,
                                    height=700,  # Reduced height to make room for info below
                                    tooltip={
                                        "html": "{TEXT}",  # Use the TEXT column from each layer
                                        "style": {
                                            "backgroundColor": "#29B5E8",
                                            "color": "white",
                                            "text-wrap": "balance"
                                        }
                                    }
                                )
                                
                                # Create chart data for route statistics (following routing.py pattern)
                                chart_data = route_coordinates.copy()
                                chart_data['color'] = chart_data.apply(
                                    lambda row: f"#{row['R']:02x}{row['G']:02x}{row['B']:02x}", axis=1
                                )
                                
                                # Create route_details_summary using Snowpark groupby
                                from snowflake.snowpark.functions import sum as snowpark_sum
                                route_details_summary = route_details.group_by('VEHICLE_ID').agg(
                                    snowpark_sum('COST').alias('TOTAL_COST'),
                                    snowpark_sum('DURATION').alias('TOTAL_DURATION'), 
                                    snowpark_sum('DISTANCE').alias('TOTAL_DISTANCE')
                                )
                                
                                # Convert to pandas for charts and summary metrics
                                summary_pandas = route_details_summary.to_pandas()
                                
                                # Add vehicle names and colors for charts
                                summary_pandas['VEHICLE'] = 'Vehicle ' + summary_pandas['VEHICLE_ID'].astype(str)
                                
                                # Add colors for the charts (matching route colors)
                                vehicle_colors = {1: [255, 87, 34], 2: [76, 175, 80], 3: [33, 150, 243]}  # Food delivery colors
                                summary_pandas['color'] = summary_pandas['VEHICLE_ID'].apply(
                                    lambda x: f"#{vehicle_colors.get(x, [100,100,100])[0]:02x}{vehicle_colors.get(x, [100,100,100])[1]:02x}{vehicle_colors.get(x, [100,100,100])[2]:02x}"
                                )
                                
                                # Create three separate bar charts for cost, duration, and distance
                                # Total Cost Chart
                                cost_chart_bars = alt.Chart(summary_pandas).mark_bar().encode(
                                    y=alt.Y('VEHICLE', axis=alt.Axis(grid=False)),
                                    x=alt.X('TOTAL_COST', axis=alt.Axis(grid=False, labels=False, title=None)),
                                    color=alt.Color('color:N', scale=None)
                                ).properties(width=280, height=150)
                                
                                cost_chart_text = cost_chart_bars.mark_text(
                                    align='left', baseline='middle', dx=3, fontSize=10
                                ).encode(text='TOTAL_COST', x=alt.X('TOTAL_COST'))
                                
                                total_cost_chart = alt.layer(cost_chart_bars, cost_chart_text).configure_view(strokeWidth=0)
                                
                                # Total Duration Chart
                                duration_chart_bars = alt.Chart(summary_pandas).mark_bar().encode(
                                    y=alt.Y('VEHICLE', axis=alt.Axis(grid=False)),
                                    x=alt.X('TOTAL_DURATION', axis=alt.Axis(grid=False, labels=False, title=None)),
                                    color=alt.Color('color:N', scale=None)
                                ).properties(width=280, height=150)
                                
                                duration_chart_text = duration_chart_bars.mark_text(
                                    align='left', baseline='middle', dx=3, fontSize=10
                                ).encode(text='TOTAL_DURATION', x=alt.X('TOTAL_DURATION'))
                                
                                total_duration_chart = alt.layer(duration_chart_bars, duration_chart_text).configure_view(strokeWidth=0)
                                
                                # Total Distance Chart
                                distance_chart_bars = alt.Chart(summary_pandas).mark_bar().encode(
                                    y=alt.Y('VEHICLE', axis=alt.Axis(grid=False)),
                                    x=alt.X('TOTAL_DISTANCE', axis=alt.Axis(grid=False, labels=False, title=None)),
                                    color=alt.Color('color:N', scale=None)
                                ).properties(width=280, height=150)
                                
                                distance_chart_text = distance_chart_bars.mark_text(
                                    align='left', baseline='middle', dx=3, fontSize=10
                                ).encode(text='TOTAL_DISTANCE', x=alt.X('TOTAL_DISTANCE'))
                                
                                total_distance_chart = alt.layer(distance_chart_bars, distance_chart_text).configure_view(strokeWidth=0)
                                
                                # Create 4-column metrics section above everything
                                st.markdown('<h1sub>DELIVERY OPTIMIZATION SUMMARY</h1sub>', unsafe_allow_html=True)
                                
                                metric_col1, metric_col2, metric_col3, metric_col4 = st.columns(4)
                                
                                total_vehicles = len(summary_pandas)
                                total_cost = summary_pandas['TOTAL_COST'].sum()
                                total_duration = summary_pandas['TOTAL_DURATION'].sum()
                                total_distance = summary_pandas['TOTAL_DISTANCE'].sum()
                                
                                with metric_col1:
                                    st.metric("🚚 Delivery Vehicles", total_vehicles)
                                
                                with metric_col2:
                                    st.metric("💰 Total Delivery Cost", f"${total_cost:.2f}")
                                
                                with metric_col3:
                                    st.metric("⏱️ Total Duration", f"{total_duration:.0f} sec")
                                
                                with metric_col4:
                                    st.metric("📏 Total Distance", f"{total_distance:.0f} m")
                                
                                # Create two-column layout (charts and map)
                                col_charts, col_map = st.columns([1, 2])  # Chart column smaller, map column larger
                                
                                with col_charts:
                                    st.markdown('<h1sub>TOTAL COST BY VEHICLE</h1sub>', unsafe_allow_html=True)
                                    st.altair_chart(total_cost_chart, use_container_width=True)
                                    
                                    st.markdown('<h1sub>TOTAL DURATION BY VEHICLE</h1sub>', unsafe_allow_html=True)
                                    st.altair_chart(total_duration_chart, use_container_width=True)
                                    
                                    st.markdown('<h1sub>TOTAL DISTANCE BY VEHICLE</h1sub>', unsafe_allow_html=True)
                                    st.altair_chart(total_distance_chart, use_container_width=True)
                                
                                with col_map:
                                    st.markdown('<h1sub>OPTIMIZED DELIVERY ROUTES</h1sub>', unsafe_allow_html=True)
                                    st.pydeck_chart(deck)
                                    
                                    # 3-column info container below the map
                                    st.markdown('<h1sub>MAP LEGEND</h1sub>', unsafe_allow_html=True)
                                    info_col1, info_col2, info_col3 = st.columns(3)
                                    
                                    with info_col1:
                                        st.markdown("""
                                        **🟠 RESTAURANT/DEPOT**
                                        - Orange dots represent restaurants/depots
                                        - Hover to see restaurant name and cuisine
                                        - Starting point for all delivery routes
                                        """)
                                    
                                    with info_col2:
                                        st.markdown("""
                                        **🛣️ OPTIMIZED DELIVERY ROUTES**
                                        - Colored lines show delivery paths
                                        - Each color represents a different vehicle
                                        - Hover to see vehicle information
                                        """)
                                    
                                    with info_col3:
                                        st.markdown("""
                                        **🟢 CUSTOMER LOCATIONS**
                                        - Green dots show customer delivery addresses
                                        - Hover to see customer name and order details
                                        - Final delivery destinations
                                        """)
                                
                            else:
                                st.warning("⚠️ No valid route geometry found for visualization")
                        else:
                            st.info("ℹ️ Route optimization completed but no geometry available for visualization")
                    else:
                        st.warning("⚠️ Response received but does not contain expected 'routes' data")
                else:
                    st.warning("⚠️ No optimization result returned")
                    
            except Exception as opt_error:
                st.error(f"❌ Optimization error: {str(opt_error)}")

# Footer
st.markdown("---")
st.markdown('<h1grey>🍕 Optimizing food delivery across NYC with AI-powered route intelligence</h1grey>', unsafe_allow_html=True)
