"""
🧪 ORS Function Tester
Test all Open Route Service functions: DIRECTIONS, OPTIMIZATION, ISOCHRONES
"""

import streamlit as st
import pandas as pd
import pydeck as pdk
import json
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.functions import col, call_function, lit, object_construct, array_agg, array_construct, to_geography
from snowflake.snowpark.types import FloatType, StringType, IntegerType
import altair as alt
from datetime import datetime

# Initialize Snowflake session
session = get_active_session()

# Ensure we have an active warehouse
session.sql('''USE WAREHOUSE DEFAULT_WH''').collect()

# Page configuration
st.set_page_config(
    page_title="ORS Function Tester",
    page_icon="🧪",
    layout="wide"
)

# Load custom CSS for Snowflake branding
with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

# Main header
st.markdown('''
<h0black>ORS FUNCTION |</h0black><h0blue> TESTER</h0blue><BR>
<h1grey>Test Open Route Service Native App Functions</h1grey>
''', unsafe_allow_html=True)

# Available routing profiles
ROUTING_PROFILES = [
    'driving-car',
    'driving-hgv', 
    'cycling-road',
    'cycling-electric',
    'foot-walking'
]

# Display labels for skills (values sent to service remain numeric)
SKILL_DISPLAY_MAP = {
    1: 'With a fridge',
    2: 'Freezer unit',
    3: 'Handling of hazardous goods',
    4: 'Humidity control'
}

# Load real NYC addresses from the dataset with geographic separation
@st.cache_data
def load_nyc_addresses():
    """Load NYC addresses with one address from each major borough for maximum separation"""
    try:
        addresses_df = session.table('FLEET_INTELLIGENCE.PUBLIC.NEW_YORK_ADDRESSES')
        
        # Filter to routable area
        filtered_addresses = addresses_df.filter(
            col('GEOMETRY').is_not_null()
        ).filter(
            call_function('ST_X', col('GEOMETRY')).between(-74.3, -73.7)
        ).filter(
            call_function('ST_Y', col('GEOMETRY')).between(40.5, 40.9)
        )
        
        # Get multiple addresses from each major borough for start locations
        start_boroughs = ['New York', 'Hempstead', 'Brookhaven', 'Islip', 'Rochester']
        start_addresses_list = []
        
        for borough in start_boroughs:
            borough_sample = filtered_addresses.filter(
                col('BOROUGH_NAME') == borough
            ).sample(0.3).limit(5).select(
                'NUMBER', 'STREET', 'POSTAL_CITY', 'POSTCODE', 'BOROUGH_NAME', 'ADDRESS', 'GEOMETRY',
                call_function('ST_Y', col('GEOMETRY')).alias('LAT'),
                call_function('ST_X', col('GEOMETRY')).alias('LON')
            ).to_pandas()
            
            if not borough_sample.empty:
                start_addresses_list.append(borough_sample)
        
        # Get multiple addresses from each different borough for end locations
        end_boroughs = ['Brooklyn', 'Essex, Newark', 'WILMINGTON', 'BOSTON', 'WORCESTER']
        end_addresses_list = []
        
        for borough in end_boroughs:
            borough_sample = filtered_addresses.filter(
                col('BOROUGH_NAME') == borough
            ).sample(0.3).limit(5).select(
                'NUMBER', 'STREET', 'POSTAL_CITY', 'POSTCODE', 'BOROUGH_NAME', 'ADDRESS', 'GEOMETRY',
                call_function('ST_Y', col('GEOMETRY')).alias('LAT'),
                call_function('ST_X', col('GEOMETRY')).alias('LON')
            ).to_pandas()
            
            if not borough_sample.empty:
                end_addresses_list.append(borough_sample)
        
        # Combine all start and end addresses
        start_df = pd.concat(start_addresses_list, ignore_index=True) if start_addresses_list else pd.DataFrame()
        end_df = pd.concat(end_addresses_list, ignore_index=True) if end_addresses_list else pd.DataFrame()
        
        # Create dictionaries
        start_dict = {}
        end_dict = {}
        
        # Process start addresses
        for _, row in start_df.iterrows():
            street_address = f"{row['NUMBER']} {row['STREET']}" if pd.notna(row['NUMBER']) and pd.notna(row['STREET']) else row['ADDRESS']
            address_name = f"{street_address}, {row['BOROUGH_NAME']}"
            if len(address_name) > 50:
                address_name = address_name[:47] + "..."
                
            start_dict[address_name] = {
                'lat': float(row['LAT']),
                'lon': float(row['LON']),
                'name': address_name,
                'full_address': f"{street_address}, {row['POSTAL_CITY']}, {row['BOROUGH_NAME']} {row['POSTCODE']}"
            }
        
        # Process end addresses
        for _, row in end_df.iterrows():
            street_address = f"{row['NUMBER']} {row['STREET']}" if pd.notna(row['NUMBER']) and pd.notna(row['STREET']) else row['ADDRESS']
            address_name = f"{street_address}, {row['BOROUGH_NAME']}"
            if len(address_name) > 50:
                address_name = address_name[:47] + "..."
                
            end_dict[address_name] = {
                'lat': float(row['LAT']),
                'lon': float(row['LON']),
                'name': address_name,
                'full_address': f"{street_address}, {row['POSTAL_CITY']}, {row['BOROUGH_NAME']} {row['POSTCODE']}"
            }
        
        return {'start': start_dict, 'end': end_dict}
        
    except Exception as e:
        st.error(f"Error loading NYC addresses: {str(e)}")
        # Fallback with separated locations
        return {
            'start': {
                'Manhattan North': {'lat': 40.7831, 'lon': -73.9712, 'name': 'Manhattan North', 'full_address': 'Upper Manhattan'},
                'Bronx': {'lat': 40.8448, 'lon': -73.8648, 'name': 'Bronx', 'full_address': 'Bronx, NY'}
            },
            'end': {
                'Brooklyn': {'lat': 40.6782, 'lon': -73.9442, 'name': 'Brooklyn', 'full_address': 'Brooklyn, NY'},
                'Queens': {'lat': 40.7282, 'lon': -73.7949, 'name': 'Queens', 'full_address': 'Queens, NY'}
            }
        }

# Load NYC addresses with geographic separation
NYC_ADDRESSES = load_nyc_addresses()

# Sidebar controls
with st.sidebar:
    st.markdown('<h1sub>🎛️ Function Testing Controls</h1sub>', unsafe_allow_html=True)
    
    # Function selection
    test_function = st.selectbox(
        "🧪 Choose Function to Test:",
        ["🗺️ DIRECTIONS", "🚚 OPTIMIZATION", "⏰ ISOCHRONES"],
        index=0
    )
    
    # Routing profile selection
    routing_profile = st.selectbox(
        "🚗 Routing Profile:",
        ROUTING_PROFILES,
        index=0
    )
    
    st.markdown("---")
    
    # Quick address selection
    st.markdown("**🏠 Real NYC Addresses:**")
    start_address_names = list(NYC_ADDRESSES['start'].keys())
    end_address_names = list(NYC_ADDRESSES['end'].keys())
    all_address_names = start_address_names + end_address_names

# Main content based on selected function
if test_function == "🗺️ DIRECTIONS":
    st.markdown('<h1sub>🗺️ DIRECTIONS FUNCTION TESTING</h1sub>', unsafe_allow_html=True)
    
    # Function instructions
    with st.expander("📚 **What is the DIRECTIONS function?**", expanded=False):
        st.markdown("""
        **🎯 Purpose:** Calculate optimal routes between two or more locations with turn-by-turn directions.
        
        **📊 What it does:**
        - **Point-to-point routing** between start and end locations
        - **Multi-point routing** through multiple waypoints  
        - **Turn-by-turn instructions** with street names and distances
        - **Route geometry** for map visualization
        - **Performance metrics** (distance, duration)
        
        **🚗 Routing Profiles:**
        - **driving-car**: Standard passenger vehicle routing
        - **driving-hgv**: Heavy goods vehicle with truck restrictions
        - **cycling-road**: Bicycle routing on roads and bike paths
        - **cycling-electric**: Electric bike routing with extended range
        - **foot-walking**: Pedestrian routing on walkways and streets
        
        **💡 Use Cases:**
        - **Navigation systems** for turn-by-turn directions
        - **Delivery planning** to understand route complexity
        - **Travel time estimation** for logistics planning
        - **Route visualization** for fleet intelligence dashboards
        """)
    
    # Collapsible test configuration
    with st.expander("🧪 **DIRECTIONS Test Configuration**", expanded=True):
        # Multi-waypoint configuration
        col1, col2, col3 = st.columns(3)
        with col1:
            st.markdown("**📍 Start Location**")
            start_address = st.selectbox("Choose start address:", start_address_names, key="start_address")
            start_coords = NYC_ADDRESSES['start'][start_address]
            st.caption(f"**Address:** {start_coords['full_address']}")
            
        with col2:
            st.markdown("**🎯 End Location**")
            end_address = st.selectbox("Choose end address:", end_address_names, key="end_address")
            end_coords = NYC_ADDRESSES['end'][end_address]
            st.caption(f"**Address:** {end_coords['full_address']}")
            
        with col3:
            st.markdown("**🛣️ Route Options**")
            num_waypoints = st.number_input("Number of Waypoints:", min_value=0, max_value=5, value=1, key="num_waypoints")
            st.caption(f"Total stops: {2 + num_waypoints}")
        
        # Show waypoints if any selected
        waypoint_coords = []
        if num_waypoints > 0:
            st.markdown("**📍 Intermediate Waypoints:**")
            # Avoid min() function conflict
            waypoint_cols_count = 3 if num_waypoints > 3 else num_waypoints
            waypoint_cols = st.columns(waypoint_cols_count)
            
            # Smart waypoint selection for realistic delivery patterns
            # This algorithm creates geographically distributed waypoints that simulate
            # real delivery routes instead of random clustering
            import math
            from random import shuffle
            
            # Get waypoint addresses from the full NYC addresses table for much better distribution
            @st.cache_data
            def load_waypoint_addresses():
                """Load a larger sample of NYC addresses specifically for waypoints"""
                try:
                    # Query the full address table for waypoint options
                    waypoint_df = session.table('FLEET_INTELLIGENCE.PUBLIC.NEW_YORK_ADDRESSES').filter(
                        col('GEOMETRY').is_not_null()
                    ).filter(
                        # Filter to routable area around NYC
                        call_function('ST_X', col('GEOMETRY')).between(-74.3, -73.7)
                    ).filter(
                        call_function('ST_Y', col('GEOMETRY')).between(40.5, 40.9)
                    ).sample(0.5).limit(2000).select(  # Get a large sample of 2000 addresses
                        'NUMBER', 'STREET', 'POSTAL_CITY', 'POSTCODE', 'BOROUGH_NAME', 'ADDRESS', 'GEOMETRY',
                        call_function('ST_Y', col('GEOMETRY')).alias('LAT'),
                        call_function('ST_X', col('GEOMETRY')).alias('LON')
                    ).to_pandas()
                    
                    waypoint_addresses = []
                    for _, row in waypoint_df.iterrows():
                        street_address = f"{row['NUMBER']} {row['STREET']}" if pd.notna(row['NUMBER']) and pd.notna(row['STREET']) else row['ADDRESS']
                        address_name = f"{street_address}, {row['BOROUGH_NAME']}"
                        if len(address_name) > 50:
                            address_name = address_name[:47] + "..."
                            
                        waypoint_addresses.append({
                            'name': address_name,
                            'lat': float(row['LAT']),
                            'lon': float(row['LON']),
                            'full_address': f"{street_address}, {row['POSTAL_CITY']}, {row['BOROUGH_NAME']} {row['POSTCODE']}"
                        })
                    
                    return waypoint_addresses
                    
                except Exception as e:
                    st.warning(f"Could not load waypoint addresses from database: {str(e)}")
                    # Fallback to using available start/end addresses
                    fallback_addresses = []
                    for addr_name in all_address_names:
                        if addr_name != start_address and addr_name != end_address:
                            if addr_name in NYC_ADDRESSES['start']:
                                coords = NYC_ADDRESSES['start'][addr_name]
                            else:
                                coords = NYC_ADDRESSES['end'][addr_name]
                            fallback_addresses.append({
                                'name': addr_name,
                                'lat': coords['lat'],
                                'lon': coords['lon'],
                                'full_address': coords['full_address']
                            })
                    return fallback_addresses
            
            # Load the expanded set of waypoint addresses
            available_addresses = load_waypoint_addresses()
            
            # Filter out start and end locations from waypoint options
            start_lat, start_lon = start_coords['lat'], start_coords['lon']
            end_lat, end_lon = end_coords['lat'], end_coords['lon']
            
            def calculate_distance(lat1, lon1, lat2, lon2):
                R = 6371  # Earth's radius in kilometers
                dlat = math.radians(lat2 - lat1)
                dlon = math.radians(lon2 - lon1)
                a = (math.sin(dlat / 2) * math.sin(dlat / 2) + 
                     math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * 
                     math.sin(dlon / 2) * math.sin(dlon / 2))
                c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                return R * c
            
            # Remove addresses too close to start/end points (within 500m)
            filtered_addresses = []
            for addr in available_addresses:
                dist_to_start = calculate_distance(start_lat, start_lon, addr['lat'], addr['lon'])
                dist_to_end = calculate_distance(end_lat, end_lon, addr['lat'], addr['lon'])
                if dist_to_start > 0.5 and dist_to_end > 0.5:  # At least 500m from start/end
                    filtered_addresses.append(addr)
            
            available_addresses = filtered_addresses
            
            # Calculate geographic center between start and end
            center_lat = (start_coords['lat'] + end_coords['lat']) / 2
            center_lon = (start_coords['lon'] + end_coords['lon']) / 2
            
            # Simplified waypoint selection: With 200 addresses, find best matches for each position
            selected_waypoints = []
            
            if num_waypoints > 0 and available_addresses:
                st.info(f"🎯 Selecting from {len(available_addresses)} available addresses for optimal distribution")
                
                # Pre-calculate all target positions for even distribution
                target_positions = []
                for i in range(num_waypoints):
                    position_ratio = (i + 1) / (num_waypoints + 1)
                    target_lat = start_coords['lat'] + (end_coords['lat'] - start_coords['lat']) * position_ratio
                    target_lon = start_coords['lon'] + (end_coords['lon'] - start_coords['lon']) * position_ratio
                    target_positions.append((target_lat, target_lon, position_ratio))
                
                # For each target position, find the best available address with anti-clustering
                used_addresses = set()
                for i, (target_lat, target_lon, position_ratio) in enumerate(target_positions):
                    best_address = None
                    best_score = float('inf')
                    
                    for addr in available_addresses:
                        # Skip if already used
                        if addr['name'] in used_addresses:
                            continue
                            
                        # Calculate distance to target position (primary factor)
                        distance_to_target = calculate_distance(target_lat, target_lon, addr['lat'], addr['lon'])
                        
                        # Check distance to already selected waypoints (anti-clustering)
                        min_distance_to_selected = float('inf')
                        for selected in selected_waypoints:
                            dist_to_selected = calculate_distance(selected['lat'], selected['lon'], addr['lat'], addr['lon'])
                            min_distance_to_selected = min(min_distance_to_selected, dist_to_selected)
                        
                        # Penalty for being too close to already selected waypoints
                        cluster_penalty = 0
                        if min_distance_to_selected < 2.0:  # Less than 2km from another waypoint
                            cluster_penalty = 10.0 / (min_distance_to_selected + 0.1)
                        
                        # Combined score (lower is better)
                        total_score = distance_to_target + cluster_penalty
                        
                        # Prefer addresses with better combined score
                        if total_score < best_score:
                            best_score = total_score
                            best_address = addr
                    
                    if best_address:
                        selected_waypoints.append(best_address)
                        used_addresses.add(best_address['name'])
                        
                st.success(f"✅ Selected {len(selected_waypoints)} well-distributed waypoints")
            
            for i in range(num_waypoints):
                col_idx = i % 3
                with waypoint_cols[col_idx]:
                    if i < len(selected_waypoints):
                        waypoint_data = selected_waypoints[i]
                        waypoint_address = waypoint_data['name']
                        waypoint_lat = waypoint_data['lat']
                        waypoint_lon = waypoint_data['lon']
                        
                        # Create waypoint coordinate structure for compatibility
                        waypoint_coord = {
                            'lat': waypoint_lat,
                            'lon': waypoint_lon,
                            'name': waypoint_address,
                            'full_address': waypoint_data.get('full_address', waypoint_address)
                        }
                        waypoint_coords.append(waypoint_coord)
                        
                        st.markdown(f"**Waypoint {i+1}:**")
                        st.caption(waypoint_address)
                        st.caption(f"📍 {waypoint_lat:.4f}, {waypoint_lon:.4f}")
                        
                        # Add distance info for delivery context
                        if i == 0:
                            start_distance = calculate_distance(start_coords['lat'], start_coords['lon'], 
                                                              waypoint_lat, waypoint_lon)
                            st.caption(f"🚚 {start_distance:.1f}km from start")
                        else:
                            prev_waypoint = selected_waypoints[i-1]
                            leg_distance = calculate_distance(prev_waypoint['lat'], prev_waypoint['lon'],
                                                            waypoint_lat, waypoint_lon)
                            st.caption(f"🚚 {leg_distance:.1f}km from previous")
        
        # Coordinate inputs section
        with st.expander("🔧 **Manual Coordinate Adjustment**", expanded=False):
            col1, col2 = st.columns(2)
            with col1:
                start_lat = st.number_input("Start Latitude:", value=start_coords['lat'], format="%.6f", key="start_lat")
                start_lon = st.number_input("Start Longitude:", value=start_coords['lon'], format="%.6f", key="start_lon")
            with col2:
                end_lat = st.number_input("End Latitude:", value=end_coords['lat'], format="%.6f", key="end_lat")
                end_lon = st.number_input("End Longitude:", value=end_coords['lon'], format="%.6f", key="end_lon")
    
    # Test DIRECTIONS function
    if st.button("🧪 Test DIRECTIONS Function", type="primary"):
        with st.spinner("Calling ORS DIRECTIONS function..."):
            try:
                # Call the native app DIRECTIONS function with multi-waypoint support
                # Build coordinate array: start -> waypoints -> end
                all_coordinates = [[start_lon, start_lat]]
                
                # Add waypoints in order
                for waypoint in waypoint_coords:
                    all_coordinates.append([waypoint['lon'], waypoint['lat']])
                
                # Add end point
                all_coordinates.append([end_lon, end_lat])
                
                # For multi-waypoint (>2 points), use the VARIANT version of DIRECTIONS
                if len(all_coordinates) > 2:
                    # Multi-waypoint: Use DIRECTIONS(VARCHAR, VARIANT) 
                    coord_df = session.create_dataframe([{
                        'PROFILE': routing_profile,
                        'COORDINATES': all_coordinates
                    }])
                    
                    directions_result = coord_df.select(
                        call_function(
                            'OPEN_ROUTE_SERVICE_NEW_YORK.CORE.DIRECTIONS',
                            col('PROFILE'),
                            object_construct(lit('coordinates'), col('COORDINATES'))
                        ).alias('DIRECTIONS_RESULT')
                    )
                else:
                    # Two-point: Use DIRECTIONS(VARCHAR, ARRAY, ARRAY)
                    coord_df = session.create_dataframe([{
                        'PROFILE': routing_profile,
                        'START_LON': start_lon,
                        'START_LAT': start_lat,
                        'END_LON': end_lon,
                        'END_LAT': end_lat
                    }])
                    
                    directions_result = coord_df.select(
                        call_function(
                            'OPEN_ROUTE_SERVICE_NEW_YORK.CORE.DIRECTIONS',
                            col('PROFILE'),
                            array_construct(col('START_LON'), col('START_LAT')),
                            array_construct(col('END_LON'), col('END_LAT'))
                        ).alias('DIRECTIONS_RESULT')
                    )
                
                result = directions_result.collect()
                
                if result and result[0][0]:
                    directions_raw = result[0][0]
                    st.success("✅ DIRECTIONS function executed successfully!")
                    
                    # Parse JSON if it's a string
                    if isinstance(directions_raw, str):
                        try:
                            directions_data = json.loads(directions_raw)
                        except json.JSONDecodeError:
                            directions_data = directions_raw
                    else:
                        directions_data = directions_raw
                    
                    # Show clean response summary
                    
                    # Display results
                    col1, col2 = st.columns(2)
                    
                    with col1:
                        st.markdown('<h1sub>📊 Route Analysis</h1sub>', unsafe_allow_html=True)
                        
                        try:
                            if isinstance(directions_data, dict) and 'features' in directions_data and directions_data['features']:
                                route_info = directions_data['features'][0]['properties']['summary']
                                segments = directions_data['features'][0]['properties'].get('segments', [])
                                
                                # Enhanced metrics with better styling
                                col1a, col1b = st.columns(2)
                                with col1a:
                                    distance_m = route_info.get('distance', 0)
                                    distance_km = distance_m / 1000
                                    if distance_km >= 1:
                                        st.metric("🛣️ Distance", f"{distance_km:.2f} km", f"({distance_m:.0f} m)")
                                    else:
                                        st.metric("🛣️ Distance", f"{distance_m:.0f} meters")
                                        
                                with col1b:
                                    duration_sec = route_info.get('duration', 0)
                                    duration_min = duration_sec / 60
                                    if duration_min >= 60:
                                        hours = int(duration_min // 60)
                                        minutes = int(duration_min % 60)
                                        st.metric("⏱️ Duration", f"{hours}h {minutes}m", f"({duration_sec:.0f} sec)")
                                    else:
                                        st.metric("⏱️ Duration", f"{duration_min:.1f} minutes", f"({duration_sec:.0f} sec)")
                                
                                # AI-powered route summary
                                st.markdown("**🤖 AI Route Summary:**")
                                if segments:
                                    try:
                                        # Extract step instructions for AI summarization
                                        instructions = []
                                        for segment in segments:
                                            for step in segment.get('steps', []):
                                                if step.get('instruction'):
                                                    instructions.append(step['instruction'])
                                        
                                        # Create AI prompt for route summarization
                                        instructions_text = ". ".join(instructions[:8])  # Limit to first 8 instructions
                                        
                                        waypoint_text = f" via {len(waypoint_coords)} waypoint(s)" if waypoint_coords else ""
                                        ai_prompt = f"""Summarize this driving route in 2-3 sentences, focusing on the main roads and key directions:

Route from {start_address} to {end_address}{waypoint_text}
Distance: {distance_km:.2f} km, Duration: {duration_min:.1f} minutes
Total Stops: {2 + len(waypoint_coords)} locations

Turn-by-turn directions: {instructions_text}

Provide a concise, helpful summary of the main route and waypoints."""
                                        
                                        # Call AI_COMPLETE with Claude (correct function name)
                                        ai_summary_df = session.create_dataframe([{'PROMPT': ai_prompt}])
                                        ai_result = ai_summary_df.select(
                                            call_function('AI_COMPLETE', 
                                                         lit('claude-3-5-sonnet'), 
                                                         col('PROMPT')).alias('AI_SUMMARY')
                                        ).collect()
                                        
                                        if ai_result and ai_result[0][0]:
                                            ai_summary = ai_result[0][0].strip()
                                            st.info(f"🗺️ {ai_summary}")
                                        else:
                                            st.caption("AI summary not available")
                                            
                                    except Exception as ai_error:
                                        st.caption(f"AI summary unavailable: {str(ai_error)[:50]}...")
                                        
                                # Turn-by-turn instructions
                                st.markdown("**📍 Turn-by-Turn Instructions:**")
                                if segments:
                                    with st.expander("View detailed directions", expanded=False):
                                        for segment in segments:
                                            for i, step in enumerate(segment.get('steps', [])):
                                                if step.get('instruction') and step.get('instruction') != "Arrive at Clinton Street, on the right":
                                                    distance = step.get('distance', 0)
                                                    duration = step.get('duration', 0)
                                                    instruction = step.get('instruction', '')
                                                    
                                                    st.write(f"**{i+1}.** {instruction}")
                                                    if distance > 0:
                                                        st.caption(f"   📏 {distance:.0f}m • ⏱️ {duration:.0f}s")
                                
                                # Route details
                                st.markdown("**📋 Route Details:**")
                                col1a, col1b = st.columns(2)
                                with col1a:
                                    st.caption(f"**From:** {start_coords['full_address']}")
                                with col1b:
                                    st.caption(f"**To:** {end_coords['full_address']}")
                                
                            else:
                                st.warning("⚠️ Unexpected response format")
                        except Exception as parse_error:
                            st.error(f"❌ Error parsing response: {str(parse_error)}")
                        
                        # Clean summary section
                    
                    with col2:
                        st.markdown("**🗺️ Route Visualization:**")
                        try:
                            if isinstance(directions_data, dict) and 'features' in directions_data and directions_data['features']:
                                # Extract route geometry safely
                                route_geometry = directions_data['features'][0]['geometry']['coordinates']
                                
                                # Create start/waypoint/end points with detailed tooltips
                                points_data = [
                                    {
                                        'lat': start_lat, 
                                        'lon': start_lon, 
                                        'type': 'Start', 
                                        'color': [255, 0, 0],
                                        'tooltip': f"🚀 START LOCATION\n{start_coords['full_address']}\n📍 {start_lat:.4f}, {start_lon:.4f}"
                                    }
                                ]
                                
                                # Add waypoints with blue color and address details
                                for i, waypoint in enumerate(waypoint_coords):
                                    points_data.append({
                                        'lat': waypoint['lat'], 
                                        'lon': waypoint['lon'], 
                                        'type': f'Waypoint {i+1}', 
                                        'color': [29, 181, 232],  # Snowflake blue
                                        'tooltip': f"📍 WAYPOINT {i+1}\n{waypoint['full_address']}\n📍 {waypoint['lat']:.4f}, {waypoint['lon']:.4f}"
                                    })
                                
                                # Add end point with address details
                                points_data.append({
                                    'lat': end_lat, 
                                    'lon': end_lon, 
                                    'type': 'End', 
                                    'color': [0, 255, 0],
                                    'tooltip': f"🎯 END LOCATION\n{end_coords['full_address']}\n📍 {end_lat:.4f}, {end_lon:.4f}"
                                })
                                
                                points_df = pd.DataFrame(points_data)
                                
                                # Add route path with route details
                                route_df = pd.DataFrame([{
                                    'coordinates': route_geometry, 
                                    'color': [29, 181, 232],
                                    'tooltip': f"🗺️ ROUTE PATH\nDistance: {distance_km:.2f} km\nDuration: {duration_min:.1f} min\nStops: {2 + len(waypoint_coords)}\nProfile: {routing_profile.replace('-', ' ').title()}"
                                }])
                                
                                # Create PyDeck map
                                view_state = pdk.ViewState(
                                    latitude=(start_lat + end_lat) / 2,
                                    longitude=(start_lon + end_lon) / 2,
                                    zoom=11,
                                    pitch=0
                                )
                                
                                layers = [
                                    pdk.Layer(
                                        'PathLayer',
                                        route_df,
                                        pickable=True,
                                        get_color='color',
                                        width_min_pixels=3,
                                        get_path='coordinates',
                                        get_width=5
                                    ),
                                    pdk.Layer(
                                        'ScatterplotLayer',
                                        points_df,
                                        pickable=True,
                                        get_position=['lon', 'lat'],
                                        get_color='color',
                                        get_radius=50,
                                        radius_scale=1,
                                        radius_min_pixels=8,
                                        radius_max_pixels=30
                                    )
                                ]
                                
                                st.pydeck_chart(pdk.Deck(
                                    map_style=None,
                                    initial_view_state=view_state,
                                    layers=layers,
                                    height=400,
                                    tooltip={'text': '{tooltip}'}
                                ))
                            else:
                                st.warning("⚠️ No route geometry found in response")
                                
                        except Exception as viz_error:
                            st.error(f"⚠️ Visualization error: {str(viz_error)}")
                            st.markdown("**Raw directions data available above for inspection**")
                
                else:
                    st.error("❌ No results returned from DIRECTIONS function")
                    
            except Exception as e:
                st.error(f"❌ Error calling DIRECTIONS function: {str(e)}")

elif test_function == "🚚 OPTIMIZATION":
    st.markdown('<h1sub>🚚 OPTIMIZATION FUNCTION TESTING</h1sub>', unsafe_allow_html=True)
    
    # Function instructions
    with st.expander("📚 **What is the OPTIMIZATION function?**", expanded=False):
        st.markdown("""
        **🎯 Purpose:** Solve the Vehicle Routing Problem (VRP) to find optimal routes for multiple vehicles and delivery jobs.
        
        **📊 What it does:**
        - **Multi-vehicle routing** with capacity and skill constraints
        - **Job assignment** based on vehicle capabilities and location
        - **Route optimization** to minimize cost, time, and distance
        - **Constraint handling** for vehicle capacity, skills, and time windows
        - **Cost calculation** including travel time and service time
        
        **🚛 Vehicle Parameters:**
        - **Capacity**: Maximum load the vehicle can carry
        - **Skills**: Special capabilities (1=basic, 2=intermediate, 3=advanced)
        - **Start/End**: Vehicle depot or base location
        - **Profile**: Transportation mode (car, truck, bike, walking)
        
        **📦 Job Parameters:**
        - **Location**: Delivery or pickup coordinates
        - **Delivery**: Capacity required from vehicle
        - **Skills**: Special skills needed for the job
        - **Time Windows**: Preferred delivery time slots (optional)
        
        **💡 Use Cases:**
        - **Last-mile delivery** optimization for e-commerce
        - **Field service** routing for technicians and maintenance
        - **Supply chain** logistics for distribution centers
        - **Fleet management** for transportation companies
        """)
    
    # Collapsible test configuration
    with st.expander("🧪 **OPTIMIZATION Test Configuration**", expanded=True):
        st.markdown("**🏭 Sample Scenario: NYC Multi-Vehicle Fleet**")
        
        # Vehicle fleet configuration
        st.markdown("**🚛 Vehicle Fleet Configuration:**")
        num_vehicles = st.number_input("Number of Vehicles:", min_value=1, max_value=5, value=2, key="num_vehicles")
        
        # Create vehicle configurations
        vehicle_configs = []
        # Avoid min() function conflict with Snowpark
        num_cols = 3 if num_vehicles > 3 else num_vehicles
        cols = st.columns(num_cols)  # Max 3 columns for layout
        
        for i in range(num_vehicles):
            col_idx = i % 3
            with cols[col_idx]:
                st.markdown(f"**Vehicle {i+1}:**")
                
                # Vehicle capacity
                capacity = st.number_input(
                    f"Capacity:", 
                    min_value=1, max_value=20, value=5+i*3, 
                    key=f"veh_{i}_cap"
                )
                
                # Vehicle skills
                skills = st.multiselect(
                    f"Capabilities:", 
                    [1, 2, 3, 4], 
                    default=[1] if i == 0 else [2] if i == 1 else [3] if i == 2 else [4], 
                    format_func=lambda x: SKILL_DISPLAY_MAP.get(x, x),
                    key=f"veh_{i}_skills"
                )
                
                # Vehicle start location
                start_address = st.selectbox(
                    f"Start Location:", 
                    all_address_names, 
                    index=i % len(all_address_names), 
                    key=f"veh_{i}_start"
                )
                
                # Get coordinates
                if start_address in NYC_ADDRESSES['start']:
                    coords = NYC_ADDRESSES['start'][start_address]
                else:
                    coords = NYC_ADDRESSES['end'][start_address]
                
                vehicle_configs.append({
                    'id': i + 1,
                    'capacity': capacity,
                    'skills': skills if skills else [1],  # Default to skill 1 if none selected
                    'coords': coords,
                    'address': start_address
                })
                
                st.caption(f"Cap: {capacity}, Skills: {[SKILL_DISPLAY_MAP.get(s, s) for s in skills]}")
        
        # Job configuration
        st.markdown("**📦 Job Configuration:**")
        col1, col2 = st.columns(2)
        
        with col1:
            num_jobs = st.number_input("Number of Jobs:", min_value=1, max_value=15, value=8, key="num_jobs")
            job_capacity_range = st.slider("Job Capacity Range:", min_value=1, max_value=8, value=(1, 4), key="job_cap_range")
            
        with col2:
            job_skill_variety = st.checkbox("Vary Job Skills", value=True, key="job_skill_variety")
            if job_skill_variety:
                st.caption("Jobs will require different skill levels (1, 2, 3, or 4)")
            else:
                fixed_skill = st.selectbox("Fixed Skill Level:", [1, 2, 3, 4], index=0, format_func=lambda x: SKILL_DISPLAY_MAP.get(x, x), key="fixed_skill")
    
    # Generate random jobs around NYC
    if st.button("🧪 Test OPTIMIZATION Function", type="primary"):
        with st.spinner("Calling ORS OPTIMIZATION function..."):
            try:
                # Import random at the top to avoid conflicts
                from random import sample as random_sample, randint, choice
                
                # Create multiple vehicles with different configurations
                vehicle_rows = []
                for vehicle in vehicle_configs:
                    vehicle_row = session.create_dataframe([{'ID': vehicle['id']}]).select(
                        object_construct(
                            lit('id'), lit(vehicle['id']),
                            lit('profile'), lit(routing_profile),
                            lit('start'), array_construct(lit(vehicle['coords']['lon']), lit(vehicle['coords']['lat'])),
                            lit('end'), array_construct(lit(vehicle['coords']['lon']), lit(vehicle['coords']['lat'])),
                            lit('capacity'), array_construct(lit(vehicle['capacity'])),
                            lit('skills'), array_construct(*[lit(skill) for skill in vehicle['skills']])
                        ).alias('VEHICLE')
                    )
                    vehicle_rows.append(vehicle_row)
                
                # Union all vehicles
                vehicle_data = vehicle_rows[0]
                for vehicle_row in vehicle_rows[1:]:
                    vehicle_data = vehicle_data.union(vehicle_row)
                
                # Create jobs data using the same large address pool as waypoints for realistic delivery patterns
                import math
                from random import shuffle
                
                # Load the same expanded set of job addresses as used for waypoints
                @st.cache_data
                def load_job_addresses():
                    """Load a larger sample of NYC addresses specifically for jobs"""
                    try:
                        # Query the full address table for job options (same as waypoints)
                        job_df = session.table('FLEET_INTELLIGENCE.PUBLIC.NEW_YORK_ADDRESSES').filter(
                            col('GEOMETRY').is_not_null()
                        ).filter(
                            # Filter to routable area around NYC
                            call_function('ST_X', col('GEOMETRY')).between(-74.3, -73.7)
                        ).filter(
                            call_function('ST_Y', col('GEOMETRY')).between(40.5, 40.9)
                        ).sample(0.5).limit(2000).select(  # Same large sample as waypoints
                            'NUMBER', 'STREET', 'POSTAL_CITY', 'POSTCODE', 'BOROUGH_NAME', 'ADDRESS', 'GEOMETRY',
                            call_function('ST_Y', col('GEOMETRY')).alias('LAT'),
                            call_function('ST_X', col('GEOMETRY')).alias('LON')
                        ).to_pandas()
                        
                        job_addresses = []
                        for _, row in job_df.iterrows():
                            street_address = f"{row['NUMBER']} {row['STREET']}" if pd.notna(row['NUMBER']) and pd.notna(row['STREET']) else row['ADDRESS']
                            address_name = f"{street_address}, {row['BOROUGH_NAME']}"
                            if len(address_name) > 50:
                                address_name = address_name[:47] + "..."
                                
                            job_addresses.append({
                                'name': address_name,
                                'lat': float(row['LAT']),
                                'lon': float(row['LON']),
                                'full_address': f"{street_address}, {row['POSTAL_CITY']}, {row['BOROUGH_NAME']} {row['POSTCODE']}"
                            })
                        
                        return job_addresses
                        
                    except Exception as e:
                        st.warning(f"Could not load job addresses from database: {str(e)}")
                        # Fallback to using available start/end addresses
                        fallback_addresses = []
                        for addr_name in all_address_names:
                            if addr_name in NYC_ADDRESSES['start']:
                                coords = NYC_ADDRESSES['start'][addr_name]
                            else:
                                coords = NYC_ADDRESSES['end'][addr_name]
                            fallback_addresses.append({
                                'name': addr_name,
                                'lat': coords['lat'],
                                'lon': coords['lon'],
                                'full_address': coords['full_address']
                            })
                        return fallback_addresses
                
                # Load the expanded set of job addresses
                job_addresses = load_job_addresses()
                st.info(f"🎯 Generating jobs from {len(job_addresses)} available NYC addresses")
                
                # Calculate geographic center of all vehicle depots for job distribution
                if vehicle_configs:
                    center_lat = sum(v['coords']['lat'] for v in vehicle_configs) / len(vehicle_configs)
                    center_lon = sum(v['coords']['lon'] for v in vehicle_configs) / len(vehicle_configs)
                else:
                    center_lat = 40.7589  # NYC center
                    center_lon = -73.9851
                
                # Function to calculate distance between two points (reuse from waypoints)
                def calculate_job_distance(lat1, lon1, lat2, lon2):
                    R = 6371  # Earth's radius in kilometers
                    dlat = math.radians(lat2 - lat1)
                    dlon = math.radians(lon2 - lon1)
                    a = (math.sin(dlat / 2) * math.sin(dlat / 2) + 
                         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * 
                         math.sin(dlon / 2) * math.sin(dlon / 2))
                    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                    return R * c
                
                # Simple random job selection with anti-clustering from real addresses
                selected_job_addresses = []
                remaining_job_addresses = job_addresses.copy()
                max_jobs = min(num_jobs, len(job_addresses))  # Don't exceed available addresses
                
                st.info(f"🎯 Selecting {max_jobs} jobs from {len(job_addresses)} real NYC addresses")
                
                # Shuffle addresses for random distribution
                shuffle(remaining_job_addresses)
                
                for i in range(max_jobs):
                    if not remaining_job_addresses:
                        break
                    
                    # Find the best address with anti-clustering
                    best_address = None
                    best_score = float('inf')
                    
                    for addr in remaining_job_addresses:
                        # Calculate minimum distance to already selected jobs
                        min_distance_from_selected = float('inf')
                        for selected in selected_job_addresses:
                            dist_from_selected = calculate_job_distance(selected['lat'], selected['lon'], addr['lat'], addr['lon'])
                            min_distance_from_selected = min(min_distance_from_selected, dist_from_selected)
                        
                        # Use distance from other jobs as the primary score (maximize spacing)
                        # For the first job, just pick the first one from shuffled list
                        if len(selected_job_addresses) == 0:
                            score = 0  # First job, no clustering concern
                        else:
                            # Prefer addresses that are farther from already selected jobs
                            score = -min_distance_from_selected  # Negative because we want to maximize distance
                        
                        # Add slight penalty for being too close to prevent tight clustering
                        if min_distance_from_selected < 2.0:  # Less than 2km apart
                            score += 10.0  # Add penalty for clustering
                        
                        if score < best_score:
                            best_score = score
                            best_address = addr
                    
                    if best_address:
                        selected_job_addresses.append(best_address)
                        remaining_job_addresses.remove(best_address)
                
                st.success(f"✅ Selected {len(selected_job_addresses)} well-distributed job locations from real addresses")
                
                # Use the selected job addresses directly (no need to extract names and look up)
                job_rows = []
                job_details = []  # Store job details for tooltips
                
                for i, job_addr in enumerate(selected_job_addresses):
                    # Vary job requirements for realistic optimization
                    if job_skill_variety:
                        job_skill = choice([1, 2, 3, 4])  # Random skill requirement
                    else:
                        job_skill = fixed_skill
                    
                    job_cap = randint(job_capacity_range[0], job_capacity_range[1])  # Random capacity within range
                    
                    # Create address structure for compatibility
                    address = {
                        'lat': job_addr['lat'],
                        'lon': job_addr['lon'],
                        'name': job_addr['name'],
                        'full_address': job_addr.get('full_address', job_addr['name'])
                    }
                    
                    # Store job details for tooltips
                    job_details.append({
                        'address': address,
                        'address_name': job_addr['name'],
                        'capacity': job_cap,
                        'skill': job_skill
                    })
                    
                    job_row = session.create_dataframe([{'ID': i+1}]).select(
                        object_construct(
                            lit('id'), lit(i+1),
                            lit('location'), array_construct(lit(job_addr['lon']), lit(job_addr['lat'])),
                            lit('delivery'), array_construct(lit(job_cap)),
                            lit('skills'), array_construct(lit(job_skill))
                        ).alias('JOB')
                    )
                    job_rows.append(job_row)
                
                # Union all jobs
                jobs_data = job_rows[0]
                for job_row in job_rows[1:]:
                    jobs_data = jobs_data.union(job_row)
                
                # Aggregate into arrays for optimization function
                vehicles_agg = vehicle_data.select(array_agg('VEHICLE').alias('VEH'))
                jobs_agg = jobs_data.select(array_agg('JOB').alias('JOB'))
                
                # Call optimization using call_function
                optimization_result = jobs_agg.join(vehicles_agg).select(
                    'JOB', 'VEH',
                    call_function('OPEN_ROUTE_SERVICE_NEW_YORK.CORE.OPTIMIZATION', col('JOB'), col('VEH')).alias('OPTIMIZATION')
                )
                
                result = optimization_result.collect()
                
                if result and result[0][2]:  # OPTIMIZATION is the 3rd column (index 2)
                    optimization_raw = result[0][2]
                    st.success("✅ OPTIMIZATION function executed successfully!")
                    
                    # Parse JSON if it's a string
                    if isinstance(optimization_raw, str):
                        try:
                            optimization_data = json.loads(optimization_raw)
                        except json.JSONDecodeError:
                            optimization_data = optimization_raw
                    else:
                        optimization_data = optimization_raw
                    
                    # Display results
                    col1, col2 = st.columns([1, 2])
                    
                    with col1:
                        st.markdown('<h1sub>📊 Optimization Analysis</h1sub>', unsafe_allow_html=True)
                        
                        if 'summary' in optimization_data:
                            summary = optimization_data['summary']
                            
                            # Enhanced metrics with better styling
                            col1a, col1b = st.columns(2)
                            with col1a:
                                cost = summary.get('cost', 0)
                                st.metric("💰 Total Cost", f"{cost:.0f}")
                                
                                distance_m = summary.get('distance', 0)
                                distance_km = distance_m / 1000
                                if distance_km >= 1:
                                    st.metric("🛣️ Distance", f"{distance_km:.2f} km", f"({distance_m:.0f} m)")
                                else:
                                    st.metric("🛣️ Distance", f"{distance_m:.0f} meters")
                                        
                            with col1b:
                                duration_sec = summary.get('duration', 0)
                                duration_min = duration_sec / 60
                                if duration_min >= 60:
                                    hours = int(duration_min // 60)
                                    minutes = int(duration_min % 60)
                                    st.metric("⏱️ Duration", f"{hours}h {minutes}m", f"({duration_sec:.0f} sec)")
                                else:
                                    st.metric("⏱️ Duration", f"{duration_min:.1f} minutes", f"({duration_sec:.0f} sec)")
                                    
                                st.metric("🚛 Routes", len(optimization_data.get('routes', [])))
                            
                            # AI-powered optimization summary
                            st.markdown("**🤖 AI Optimization Summary:**")
                            try:
                                vehicle_summary = f"{num_vehicles} vehicles with capacities {[v['capacity'] for v in vehicle_configs]} and skills {[v['skills'] for v in vehicle_configs]}"
                                ai_prompt = f"""Summarize this vehicle routing optimization result in 2-3 sentences:

Optimization for {num_jobs} delivery jobs using {num_vehicles} vehicle(s)
Total Cost: {cost:.0f}, Distance: {distance_km:.2f} km, Duration: {duration_min:.1f} minutes
Routes: {len(optimization_data.get('routes', []))}
Fleet: {vehicle_summary}
Job Requirements: Capacity {job_capacity_range[0]}-{job_capacity_range[1]}, Skills varied: {job_skill_variety}

Provide a concise summary of the optimization efficiency and routing strategy."""
                                
                                ai_summary_df = session.create_dataframe([{'PROMPT': ai_prompt}])
                                ai_result = ai_summary_df.select(
                                    call_function('AI_COMPLETE', 
                                                 lit('claude-3-5-sonnet'), 
                                                 col('PROMPT')).alias('AI_SUMMARY')
                                ).collect()
                                
                                if ai_result and ai_result[0][0]:
                                    ai_summary = ai_result[0][0].strip()
                                    st.info(f"🚚 {ai_summary}")
                                else:
                                    st.caption("AI summary not available")
                                    
                            except Exception as ai_error:
                                st.caption(f"AI summary unavailable: {str(ai_error)[:50]}...")
                            
                            # Optimization details
                            st.markdown("**📋 Fleet & Job Summary:**")
                            col1a, col1b = st.columns(2)
                            with col1a:
                                st.caption(f"**Fleet Size:** {num_vehicles} vehicles")
                                st.caption(f"**Total Jobs:** {num_jobs} deliveries")
                            with col1b:
                                st.caption(f"**Capacity Range:** {job_capacity_range[0]}-{job_capacity_range[1]} units")
                                st.caption(f"**Skill Variety:** {'Yes' if job_skill_variety else 'No'}")
                        
                        # Clean optimization section
                    
                    with col2:
                        st.markdown("**🗺️ Optimized Routes:**")
                        if 'routes' in optimization_data and optimization_data['routes']:
                            # Snowflake brand color palette for routes
                            snowflake_colors = [
                                [29, 181, 232],   # Primary Blue
                                [255, 158, 27],   # Orange
                                [106, 237, 199],  # Mint Green
                                [255, 90, 95],    # Coral Red
                                [149, 117, 238],  # Purple
                                [255, 206, 84],   # Yellow
                                [56, 189, 248],   # Light Blue
                                [34, 197, 94]     # Green
                            ]
                            
                            # Extract route geometries with distinct colors
                            route_data = []
                            route_legend = []
                            point_data = []
                            
                            # Add vehicle start points with detailed tooltips
                            for vehicle in vehicle_configs:
                                point_data.append({
                                    'lat': vehicle['coords']['lat'],
                                    'lon': vehicle['coords']['lon'],
                                    'type': f'Vehicle {vehicle["id"]} Start',
                                    'color': [255, 165, 0],  # Orange for depot
                                    'tooltip': f"🚛 VEHICLE {vehicle['id']} DEPOT\n{vehicle['coords']['full_address']}\nCapacity: {vehicle['capacity']} units\nSkills: {vehicle['skills']}\n📍 {vehicle['coords']['lat']:.4f}, {vehicle['coords']['lon']:.4f}"
                                })
                            
                            # Extract and add only ASSIGNED job locations from optimization routes
                            # Use coordinates directly from route geometry for perfect alignment
                            assigned_jobs = set()  # Track which jobs are assigned
                            for route_idx, route in enumerate(optimization_data['routes']):
                                if 'steps' in route and 'geometry' in route:
                                    route_color = snowflake_colors[route_idx % len(snowflake_colors)]
                                    vehicle_id = route.get('vehicle', route_idx + 1)
                                    route_geometry = route['geometry']  # This is the actual linestring coordinates
                                    
                                    # Map step index to geometry coordinates
                                    # The geometry contains all points along the route path
                                    for step_idx, step in enumerate(route['steps']):
                                        if 'job' in step:  # This is a job step (not depot)
                                            job_id = step['job']
                                            assigned_jobs.add(job_id)
                                            
                                            # Find the exact coordinate from route geometry that corresponds to this job
                                            # The optimization service should provide exact coordinates that match the linestring
                                            
                                            # Method 1: Use step location if available (most accurate)
                                            if 'location' in step and len(step['location']) >= 2:
                                                step_lon, step_lat = step['location'][0], step['location'][1]
                                                
                                                # Find the closest point in the route geometry to this step location
                                                min_distance = float('inf')
                                                best_point = None
                                                
                                                for geom_point in route_geometry:
                                                    if len(geom_point) >= 2:
                                                        geom_lon, geom_lat = geom_point[0], geom_point[1]
                                                        # Calculate distance between step location and geometry point
                                                        distance = ((step_lat - geom_lat) ** 2 + (step_lon - geom_lon) ** 2) ** 0.5
                                                        if distance < min_distance:
                                                            min_distance = distance
                                                            best_point = (geom_lon, geom_lat)
                                                
                                                if best_point:
                                                    opt_lon, opt_lat = best_point[0], best_point[1]
                                                    coord_source = f"closest geometry point (dist: {min_distance*100000:.1f}m)"
                                                else:
                                                    opt_lon, opt_lat = step_lon, step_lat
                                                    coord_source = "step location"
                                            else:
                                                # Method 2: Fallback to original job coordinates
                                                if job_id <= len(job_details):
                                                    job_detail = job_details[job_id - 1]  # job_id is 1-based
                                                    address = job_detail['address']
                                                    opt_lat, opt_lon = address['lat'], address['lon']
                                                    coord_source = "original job data"
                                                else:
                                                    continue  # Skip if no coordinates available
                                            
                                            # Get job details for tooltip
                                            job_detail = job_details[job_id - 1] if job_id <= len(job_details) else None
                                            if job_detail:
                                                address = job_detail['address']
                                                
                                                point_data.append({
                                                    'lat': opt_lat,
                                                    'lon': opt_lon,
                                                    'type': f'Job {job_id} (Vehicle {vehicle_id})',
                                                    'color': route_color,  # Same color as the vehicle route
                                                    'tooltip': f"📦 JOB {job_id} - VEHICLE {vehicle_id}\n{address['full_address']}\nCapacity Required: {job_detail['capacity']} units\nSkill Required: {job_detail['skill']}\nStep {step_idx} in route\nCoords from: {coord_source}\n📍 {opt_lat:.6f}, {opt_lon:.6f}"
                                                })
                            
                            # Show summary of job assignments with detailed debugging
                            st.info(f"🎯 Showing {len(assigned_jobs)} assigned jobs out of {len(job_details)} total jobs")
                            
                            # Debug: Show detailed route and job information
                            with st.expander("🔍 DEBUG: Route and Job Assignment Details", expanded=False):
                                st.markdown("**Route Analysis:**")
                                for route_idx, route in enumerate(optimization_data['routes']):
                                    vehicle_id = route.get('vehicle', route_idx + 1)
                                    route_jobs = []
                                    
                                    if 'steps' in route:
                                        for step_idx, step in enumerate(route['steps']):
                                            if 'job' in step:
                                                route_jobs.append(step['job'])
                                    
                                    st.markdown(f"**Vehicle {vehicle_id}:**")
                                    st.markdown(f"- Steps in route: {len(route.get('steps', []))}")
                                    st.markdown(f"- Jobs assigned: {route_jobs}")
                                    st.markdown(f"- Has geometry: {'geometry' in route}")
                                    st.markdown(f"- Geometry points: {len(route.get('geometry', []))}")
                                    st.markdown("---")
                                
                                st.markdown(f"**Total assigned jobs:** {list(assigned_jobs)}")
                                st.markdown(f"**Points being displayed:** {len([p for p in point_data if 'Job' in p['type']])}")
                                
                                # Add constraint analysis
                                st.markdown("**🔍 Constraint Analysis:**")
                                st.markdown("**Vehicle Capabilities:**")
                                for vehicle in vehicle_configs:
                                    st.markdown(f"- Vehicle {vehicle['id']}: Capacity={vehicle['capacity']}, Skills={vehicle['skills']}")
                                
                                st.markdown("**Job Requirements:**")
                                unassigned_jobs = []
                                for i, job_detail in enumerate(job_details):
                                    job_id = i + 1
                                    is_assigned = job_id in assigned_jobs
                                    status = "✅ ASSIGNED" if is_assigned else "❌ UNASSIGNED"
                                    st.markdown(f"- Job {job_id}: Capacity={job_detail['capacity']}, Skill={job_detail['skill']} - {status}")
                                    if not is_assigned:
                                        unassigned_jobs.append(job_id)
                                
                                if unassigned_jobs:
                                    st.markdown(f"**❌ Unassigned Jobs ({len(unassigned_jobs)}):** {unassigned_jobs}")
                                    st.markdown("**Possible reasons for unassignment:**")
                                    st.markdown("- Vehicle capacity too low for job requirements")
                                    st.markdown("- Vehicle lacks required skills for the job")
                                    st.markdown("- Geographic distance too far from vehicle depot")
                                    st.markdown("- Total vehicle capacity already exhausted")
                                    
                                # Calculate total capacity
                                total_vehicle_capacity = sum(v['capacity'] for v in vehicle_configs)
                                total_job_demand = sum(j['capacity'] for j in job_details)
                                st.markdown(f"**📊 Capacity Analysis:**")
                                st.markdown(f"- Total vehicle capacity: {total_vehicle_capacity}")
                                st.markdown(f"- Total job demand: {total_job_demand}")
                                st.markdown(f"- Capacity utilization: {(total_job_demand/total_vehicle_capacity)*100:.1f}%" if total_vehicle_capacity > 0 else "- Capacity utilization: N/A")
                            
                            # Add route paths with distinct colors
                            for i, route in enumerate(optimization_data['routes']):
                                if 'geometry' in route:
                                    color = snowflake_colors[i % len(snowflake_colors)]
                                    vehicle_id = route.get('vehicle', i+1)
                                    
                                    # Get vehicle details for tooltip
                                    vehicle_detail = next((v for v in vehicle_configs if v['id'] == vehicle_id), None)
                                    
                                    # Count ACTUAL job steps (not just total steps minus 1)
                                    actual_job_count = 0
                                    if 'steps' in route:
                                        for step in route['steps']:
                                            if 'job' in step:
                                                actual_job_count += 1
                                    
                                    route_distance = route.get('distance', 0)
                                    route_duration = route.get('duration', 0)
                                    
                                    route_data.append({
                                        'coordinates': route['geometry'],
                                        'color': color,
                                        'vehicle_id': vehicle_id,
                                        'tooltip': f"🚛 VEHICLE {vehicle_id} ROUTE\nCapacity: {vehicle_detail['capacity'] if vehicle_detail else 'Unknown'} units\nSkills: {vehicle_detail['skills'] if vehicle_detail else 'Unknown'}\nJobs: {actual_job_count}\nDistance: {route_distance:.0f}m\nDuration: {route_duration/60:.1f} min"
                                    })
                                    
                                    # Add to legend with correct job count
                                    route_legend.append({
                                        'vehicle': f'Vehicle {vehicle_id}',
                                        'color': f'rgb({color[0]}, {color[1]}, {color[2]})',
                                        'jobs': actual_job_count  # Use actual job count, not steps minus 1
                                    })
                            
                            # Create PyDeck map
                            if route_data or point_data:
                                view_state = pdk.ViewState(
                                    latitude=40.7589,
                                    longitude=-73.9851,
                                    zoom=10,
                                    pitch=0
                                )
                                
                                layers = []
                                
                                # Add route paths first (background)
                                if route_data:
                                    layers.append(pdk.Layer(
                                        'PathLayer',
                                        pd.DataFrame(route_data),
                                        pickable=True,
                                        get_color='color',
                                        width_min_pixels=4,
                                        get_path='coordinates',
                                        get_width=6  # Slightly thicker for better visibility
                                    ))
                                
                                # Add job points on top (foreground)
                                if point_data:
                                    layers.append(pdk.Layer(
                                        'ScatterplotLayer',
                                        pd.DataFrame(point_data),
                                        pickable=True,
                                        get_position=['lon', 'lat'],
                                        get_color='color',
                                        get_radius=60,  # Reasonable size for visibility
                                        radius_scale=1,
                                        radius_min_pixels=8,  # Smaller minimum
                                        radius_max_pixels=25,  # Smaller maximum
                                        filled=True,
                                        stroked=True,
                                        get_line_color=[255, 255, 255],  # White border for contrast
                                        get_line_width=2
                                    ))
                                
                                st.pydeck_chart(pdk.Deck(
                                    map_style=None,
                                    initial_view_state=view_state,
                                    layers=layers,
                                    height=400,
                                    tooltip={'text': '{tooltip}'}
                                ))
                                
                                # Add color legend under the map
                                if route_legend:
                                    st.markdown("**🎨 Route Color Key:**")
                                    for legend_item in route_legend:
                                        color_style = f"background-color: {legend_item['color']}; color: white; padding: 2px 8px; border-radius: 3px; margin: 2px;"
                                        st.markdown(
                                            f'<span style="{color_style}">{legend_item["vehicle"]}</span> - {legend_item["jobs"]} job(s)',
                                            unsafe_allow_html=True
                                        )
                
                else:
                    st.error("❌ No results returned from OPTIMIZATION function")
                    
            except Exception as e:
                st.error(f"❌ Error calling OPTIMIZATION function: {str(e)}")

elif test_function == "⏰ ISOCHRONES":
    st.markdown('<h1sub>⏰ ISOCHRONES FUNCTION TESTING</h1sub>', unsafe_allow_html=True)
    # Collapsible test configuration
    with st.expander("🧪 **ISOCHRONES Test Configuration**", expanded=True):
        st.markdown("**⏰ Sample Scenario: NYC Catchment Area Analysis**")
        
        col1, col2 = st.columns(2)
        
        with col1:
            st.markdown("**📍 Center Location**")
            center_address = st.selectbox("Choose center address:", all_address_names, index=0, key="center_address")
            # Get coordinates from the appropriate dictionary
            if center_address in NYC_ADDRESSES['start']:
                center_coords = NYC_ADDRESSES['start'][center_address]
            else:
                center_coords = NYC_ADDRESSES['end'][center_address]
            
            st.caption(f"**Address:** {center_coords['full_address']}")
            
            # Use default coordinates from selected address
            center_lat = center_coords['lat']
            center_lon = center_coords['lon']
            
            # Allow manual coordinate input
            with st.expander("🔧 **Manual Coordinate Adjustment**", expanded=False):
                center_lat = st.number_input("Center Latitude:", value=center_coords['lat'], format="%.6f", key="center_lat")
                center_lon = st.number_input("Center Longitude:", value=center_coords['lon'], format="%.6f", key="center_lon")
            
        with col2:
            st.markdown("**⏰ Isochrone Configuration**")
            time_range = st.slider("Time Range (minutes):", min_value=5, max_value=60, value=15, step=5, key="time_range")
            
            st.markdown(f"**Selected Location:** {center_address}")
            st.markdown(f"**Coordinates:** {center_coords['lat']:.4f}, {center_coords['lon']:.4f}")
            st.markdown(f"**Profile:** {routing_profile}")
            st.markdown(f"**Time Range:** {time_range} minutes")
    
    # Test ISOCHRONES function
    if st.button("🧪 Test ISOCHRONES Function", type="primary"):
        with st.spinner("Calling ORS ISOCHRONES function..."):
            try:
                # Create dataframe for isochrone calculation
                isochrone_df = session.create_dataframe([{
                    'LON': center_lon, 
                    'LAT': center_lat, 
                    'METHOD': routing_profile, 
                    'RANGE_MINS': time_range
                }])

                # Call ISOCHRONES using call_function
                isochrone_result = isochrone_df.select(
                    call_function('OPEN_ROUTE_SERVICE_NEW_YORK.CORE.ISOCHRONES',
                                  col('METHOD'), col('LON'), col('LAT'), col('RANGE_MINS')).alias('ISOCHRONE')
                )
                
                result = isochrone_result.collect()
                
                if result and result[0][0]:
                    isochrones_raw = result[0][0]
                    st.success("✅ ISOCHRONES function executed successfully!")
                    
                    # Parse JSON if it's a string
                    if isinstance(isochrones_raw, str):
                        try:
                            isochrones_data = json.loads(isochrones_raw)
                        except json.JSONDecodeError:
                            isochrones_data = isochrones_raw
                    else:
                        isochrones_data = isochrones_raw
                    
                    # Display results
                    col1, col2 = st.columns([1, 2])
                    
                    with col1:
                        st.markdown('<h1sub>📊 Isochrone Analysis</h1sub>', unsafe_allow_html=True)
                        
                        # Enhanced metrics with better styling
                        col1a, col1b = st.columns(2)
                        with col1a:
                            st.metric("⏰ Time Range", f"{time_range} minutes")
                            st.metric("🚗 Profile", routing_profile.replace('-', ' ').title())
                        with col1b:
                            st.metric("📍 Center Point", center_address.split(',')[0])
                            if 'features' in isochrones_data and isochrones_data['features']:
                                feature = isochrones_data['features'][0]
                                properties = feature.get('properties', {})
                                if 'value' in properties:
                                    st.metric("🎯 Reach Time", f"{properties['value']/60:.1f} min")
                        
                        # AI-powered isochrone summary
                        st.markdown("**🤖 AI Catchment Analysis:**")
                        try:
                            ai_prompt = f"""Summarize this isochrone catchment area analysis in 2-3 sentences:

Center Location: {center_address}
Time Range: {time_range} minutes
Transportation Mode: {routing_profile}
Analysis: Shows all locations reachable within {time_range} minutes

Explain what this catchment area represents and its practical applications."""
                            
                            ai_summary_df = session.create_dataframe([{'PROMPT': ai_prompt}])
                            ai_result = ai_summary_df.select(
                                call_function('AI_COMPLETE', 
                                             lit('claude-3-5-sonnet'), 
                                             col('PROMPT')).alias('AI_SUMMARY')
                            ).collect()
                            
                            if ai_result and ai_result[0][0]:
                                ai_summary = ai_result[0][0].strip()
                                st.info(f"⏰ {ai_summary}")
                            else:
                                st.caption("AI summary not available")
                                
                        except Exception as ai_error:
                            st.caption(f"AI summary unavailable: {str(ai_error)[:50]}...")
                        
                        # Isochrone details
                        st.markdown("**📋 Analysis Details:**")
                        col1a, col1b = st.columns(2)
                        with col1a:
                            st.caption(f"**Center:** {center_coords['full_address']}")
                            st.caption(f"**Mode:** {routing_profile.replace('-', ' ').title()}")
                        with col1b:
                            st.caption(f"**Time Limit:** {time_range} minutes")
                            st.caption(f"**Analysis Type:** Catchment area")
                        
                        # Clean isochrone section
                    
                    with col2:
                        st.markdown("**🗺️ Catchment Area:**")
                        
                        try:
                            # Extract isochrone polygon following the working pattern from routing.py
                            # Convert to geography and then extract coordinates
                            isochrone_geo_result = isochrone_result.select(
                                to_geography(col('ISOCHRONE')['features'][0]['geometry']).alias('GEO')
                            )
                            
                            isochrone_pandas = isochrone_geo_result.select('GEO').to_pandas()
                            
                            # Safe JSON parsing with error handling
                            def safe_json_parse(geo_str):
                                if geo_str is None or pd.isna(geo_str):
                                    return None
                                try:
                                    return json.loads(geo_str)["coordinates"]
                                except (json.JSONDecodeError, TypeError, KeyError):
                                    return None
                            
                            isochrone_pandas["coordinates"] = isochrone_pandas["GEO"].apply(safe_json_parse)
                            
                            # Add tooltip for polygon
                            isochrone_pandas["tooltip"] = f"⏰ CATCHMENT AREA\nReachable in {time_range} minutes\nFrom: {center_address}\nMode: {routing_profile.replace('-', ' ').title()}\nArea shows all locations accessible within time limit"
                            
                            # Remove rows with failed parsing
                            isochrone_pandas = isochrone_pandas.dropna(subset=['coordinates'])
                            
                            if len(isochrone_pandas) > 0:
                                # Create center point
                                center_point_df = pd.DataFrame([{
                                    'lat': center_lat,
                                    'lon': center_lon,
                                    'type': f'{center_address} ({time_range}min catchment)',
                                    'color': [255, 0, 0],
                                    'tooltip': f"⏰ ISOCHRONE CENTER\n{center_coords['full_address']}\nTime Range: {time_range} minutes\nProfile: {routing_profile.replace('-', ' ').title()}\n📍 {center_lat:.4f}, {center_lon:.4f}"
                                }])
                                
                                # Create PyDeck map
                                view_state = pdk.ViewState(
                                    latitude=center_lat,
                                    longitude=center_lon,
                                    zoom=11,
                                    pitch=0
                                )
                                
                                layers = [
                                    pdk.Layer(
                                        'PolygonLayer',
                                        isochrone_pandas,
                                        pickable=True,
                                        get_polygon='coordinates',
                                        get_fill_color=[29, 181, 232, 100],
                                        get_line_color=[255, 255, 255],
                                        line_width_min_pixels=2
                                    ),
                                    pdk.Layer(
                                        'ScatterplotLayer',
                                        center_point_df,
                                        pickable=True,
                                        get_position=['lon', 'lat'],
                                        get_color='color',
                                        get_radius=100,
                                        radius_scale=1,
                                        radius_min_pixels=12,
                                        radius_max_pixels=50
                                    )
                                ]
                                
                                st.pydeck_chart(pdk.Deck(
                                    map_style=None,
                                    initial_view_state=view_state,
                                    layers=layers,
                                    height=400,
                                    tooltip={'text': '{tooltip}'}
                                ))
                            else:
                                st.warning("⚠️ Could not extract isochrone geometry for visualization")
                                
                        except Exception as viz_error:
                            st.error(f"⚠️ Visualization error: {str(viz_error)}")
                            st.markdown("**Raw isochrone data available above for inspection**")
                
                else:
                    st.error("❌ No results returned from ISOCHRONES function")
                    
            except Exception as e:
                st.error(f"❌ Error calling ISOCHRONES function: {str(e)}")

# Footer information
st.markdown("---")
st.markdown('''
<h1sub>📚 FUNCTION INFORMATION</h1sub>

**🗺️ DIRECTIONS Function:**
- **Purpose**: Point-to-point routing and navigation
- **Input**: Routing profile, start coordinates, end coordinates  
- **Output**: Route geometry, distance, duration, turn-by-turn directions

**🚚 OPTIMIZATION Function:**
- **Purpose**: Vehicle routing problem (VRP) solving
- **Input**: Array of jobs (locations, capacity, skills), array of vehicles (capacity, skills, start/end)
- **Output**: Optimized routes, total cost, duration, distance

**⏰ ISOCHRONES Function:**
- **Purpose**: Time-based catchment area analysis
- **Input**: Routing profile, center coordinates, time range (minutes)
- **Output**: Polygon representing reachable area within time limit

**🚗 Available Profiles:**
- `driving-car`: Standard car routing
- `driving-hgv`: Heavy goods vehicle routing  
- `cycling-road`: Road bicycle routing
- `cycling-electric`: Electric bicycle routing
- `foot-walking`: Pedestrian routing
''', unsafe_allow_html=True)
