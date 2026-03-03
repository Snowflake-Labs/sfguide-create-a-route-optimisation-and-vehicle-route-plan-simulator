import streamlit as st
import pandas as pd
import json
from snowflake.snowpark.context import get_active_session

# Initialize Snowflake session
session = get_active_session()

# Page configuration
st.set_page_config(
    page_title="OpenStreetMap Generator",
    page_icon="🗺️",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Custom CSS
st.markdown("""
<style>
    .main-header { font-size: 2.5rem; font-weight: bold; color: #1f77b4; text-align: center; margin-bottom: 2rem; }
    .status-active { padding: 0.5rem 1rem; background-color: #d4edda; border-radius: 0.5rem; color: #155724; }
</style>
""", unsafe_allow_html=True)

# Main header
st.markdown('<div class="main-header">🗺️ OpenStreetMap Generator</div>', unsafe_allow_html=True)

# Check current status
try:
    status_result = session.sql("CALL core.check_status()").collect()[0][0]
    st.markdown(f'<div class="status-active">✅ {status_result}</div>', unsafe_allow_html=True)
except:
    pass

# Sidebar for navigation
st.sidebar.title("Navigation")
page = st.sidebar.selectbox(
    "Choose a page:",
    ["🏠 Home", "🗺️ Generate Map", "🔗 Merge Maps", "🚗 OpenRouteService", "📊 History", "ℹ️ About"]
)

if page == "🏠 Home":
    st.header("Welcome to OpenStreetMap Generator")
    
    col1, col2 = st.columns(2)
    
    with col1:
        st.subheader("🚀 Quick Start")
        st.markdown("""
        1. **Go to Generate Map** - Choose your method
        2. **Enter location** - City name or coordinates
        3. **Download** - Get your .osm file from the stage
        """)
        
        st.subheader("✨ Features")
        st.markdown("""
        - 🌍 **Real OpenStreetMap Data** - Live data from OSM APIs
        - 🏙️ **City Geocoding** - Find any city worldwide via Nominatim
        - 📐 **Custom Coordinates** - Use exact bounding boxes
        - 📁 **File Storage** - Maps saved to Snowflake stage
        """)
    
    with col2:
        st.subheader("📈 Recent Activity")
        try:
            recent = session.sql("""
                SELECT city_name, status, file_size_bytes, created_at
                FROM core.map_generation_history 
                ORDER BY created_at DESC LIMIT 5
            """).to_pandas()
            if not recent.empty:
                st.dataframe(recent, use_container_width=True)
            else:
                st.info("No maps generated yet.")
        except:
            st.info("No history available.")

elif page == "🗺️ Generate Map":
    st.header("Generate Map")
    
    method = st.radio("Method:", ["🏙️ City Name", "📐 Coordinates", "🎯 Preset"])
    
    bbox_string = None
    area_name = None
    
    if method == "🏙️ City Name":
        city_name = st.text_input("Enter city:", placeholder="e.g., London, UK or 'Berlin Mitte'")
        if city_name:
            if st.button("🔍 Preview"):
                try:
                    escaped_city = city_name.replace("'", "''")
                    result = session.sql(f"SELECT core.geocode_city('{escaped_city}')").collect()[0][0]
                    data = json.loads(result)
                    if data['success']:
                        st.success(f"Found: {data['display_name']}")
                        
                        # Show warning if area was reduced
                        if data.get('area_reduced'):
                            st.warning(f"⚠️ {data.get('message', 'Area was reduced to central region.')}")
                            st.info(f"📍 Using central area: {data['bbox_string']} ({data.get('area_sq_deg', 0):.4f} sq deg)")
                        else:
                            st.info(f"📍 Bbox: {data['bbox_string']} ({data.get('area_sq_deg', 0):.4f} sq deg)")
                        
                        st.session_state['bbox_string'] = data['bbox_string']
                        st.session_state['area_name'] = city_name
                        st.session_state['geocode_data'] = data
                    else:
                        st.error(data['error'])
                except Exception as e:
                    st.error(str(e))
            
            # Use session state for persistence
            bbox_string = st.session_state.get('bbox_string')
            area_name = st.session_state.get('area_name', city_name)
    
    elif method == "📐 Coordinates":
        bbox_input = st.text_input("Bounding box (xmin,ymin,xmax,ymax):", placeholder="-0.15,51.50,-0.10,51.52")
        area_name = st.text_input("Area name:", placeholder="My Area")
        if bbox_input:
            bbox_string = bbox_input
            area_name = area_name or "Custom Area"
    
    elif method == "🎯 Preset":
        try:
            presets = session.sql("SELECT * FROM TABLE(core.get_preset_areas())").to_pandas()
            selected = st.selectbox("Choose preset:", presets['NAME'].tolist())
            if selected:
                row = presets[presets['NAME'] == selected].iloc[0]
                bbox_data = row['BBOX']
                if isinstance(bbox_data, str):
                    bbox_data = json.loads(bbox_data)
                bbox_string = f"{bbox_data['xmin']},{bbox_data['ymin']},{bbox_data['xmax']},{bbox_data['ymax']}"
                area_name = selected
                st.info(f"Bbox: {bbox_string}")
        except Exception as e:
            st.error(str(e))
    
    if bbox_string and area_name:
        st.divider()
        if st.button("🚀 Generate Map", type="primary", use_container_width=True):
            with st.spinner("Generating map from OpenStreetMap..."):
                try:
                    if method == "🏙️ City Name":
                        params = json.dumps({"city_name": city_name}).replace("'", "''")
                        result = session.sql(f"CALL core.generate_map('city', PARSE_JSON('{params}'))").collect()[0][0]
                    else:
                        params = json.dumps({"bbox": bbox_string, "area_name": area_name}).replace("'", "''")
                        result = session.sql(f"CALL core.generate_map('bbox', PARSE_JSON('{params}'))").collect()[0][0]
                    
                    if "failed" in result.lower():
                        st.error(result)
                    else:
                        st.success(result)
                        st.balloons()
                        # Clear session state
                        if 'bbox_string' in st.session_state:
                            del st.session_state['bbox_string']
                        if 'area_name' in st.session_state:
                            del st.session_state['area_name']
                except Exception as e:
                    st.error(str(e))

elif page == "🔗 Merge Maps":
    st.header("Merge Multiple Maps")
    
    st.markdown("""
    Combine multiple OSM map files into a single file. This is useful for:
    - **OpenRouteService** - which requires a single map file
    - **Multi-region coverage** - e.g., 4 warehouse locations in different cities
    - **Custom routing areas** - combine specific neighborhoods
    """)
    
    st.divider()
    
    # Get list of available files
    try:
        files_result = session.sql("LIST @core.generated_maps").collect()
        if files_result:
            # Extract just the filenames
            available_files = []
            for f in files_result:
                # File path is in first column, extract just filename
                full_path = f[0]
                filename = full_path.split('/')[-1]
                if filename.endswith('.osm'):
                    available_files.append(filename)
            
            if available_files:
                st.subheader("📁 Select Files to Merge")
                
                # Multi-select for files
                selected_files = st.multiselect(
                    "Choose 2 or more map files:",
                    available_files,
                    help="Hold Ctrl/Cmd to select multiple files"
                )
                
                if len(selected_files) >= 2:
                    # Output filename
                    default_name = f"merged_{'_'.join([f.split('_')[0] for f in selected_files[:3]])}_{pd.Timestamp.now().strftime('%Y-%m-%d')}.osm"
                    output_name = st.text_input("Output filename:", value=default_name)
                    
                    st.divider()
                    
                    if st.button("🔗 Merge Selected Maps", type="primary", use_container_width=True):
                        with st.spinner(f"Merging {len(selected_files)} maps..."):
                            try:
                                # Build array string for SQL
                                files_array = "ARRAY_CONSTRUCT(" + ", ".join([f"'{f}'" for f in selected_files]) + ")"
                                result = session.sql(f"CALL core.merge_maps({files_array}, '{output_name}')").collect()[0][0]
                                data = json.loads(result)
                                
                                if data.get('success'):
                                    st.success(f"✅ Maps merged successfully!")
                                    st.balloons()
                                    
                                    col1, col2, col3 = st.columns(3)
                                    col1.metric("Files Merged", data.get('files_merged', 0))
                                    col2.metric("Total Elements", f"{data.get('total_elements', 0):,}")
                                    col3.metric("File Size", f"{data.get('file_size_bytes', 0) / 1024 / 1024:.1f} MB")
                                    
                                    st.info(f"📄 Output file: `{data.get('filename')}`")
                                    
                                    # Show merged bounds
                                    bounds = data.get('merged_bounds', {})
                                    if bounds:
                                        st.caption(f"Merged bounds: {bounds.get('minlon'):.4f}, {bounds.get('minlat'):.4f} to {bounds.get('maxlon'):.4f}, {bounds.get('maxlat'):.4f}")
                                else:
                                    st.error(f"Merge failed: {data.get('error', 'Unknown error')}")
                            except Exception as e:
                                st.error(f"Error: {str(e)}")
                elif len(selected_files) == 1:
                    st.warning("Please select at least 2 files to merge.")
                else:
                    st.info("👆 Select 2 or more map files from the list above.")
            else:
                st.info("No .osm files found. Generate some maps first!")
        else:
            st.info("No files in stage. Generate some maps first!")
    except Exception as e:
        st.error(f"Error loading files: {str(e)}")

elif page == "🚗 OpenRouteService":
    st.header("OpenRouteService Configuration")
    
    st.markdown("""
    Configure the map file to use with OpenRouteService for routing calculations.
    
    **Steps:**
    1. Generate or merge map files using the other pages
    2. Select the active map below
    3. (Coming soon) Start OpenRouteService with the selected map
    """)
    
    st.divider()
    
    # Show current configuration
    try:
        config_result = session.sql("SELECT core.get_ors_config()").collect()[0][0]
        config = json.loads(config_result) if config_result else {}
        
        col1, col2 = st.columns(2)
        with col1:
            st.subheader("📋 Current Configuration")
            active_map = config.get('active_map')
            ors_status = config.get('ors_status', 'not_configured')
            
            if active_map:
                st.success(f"**Active Map:** {active_map}")
                st.caption(f"ORS source path: `/home/ors/files/{active_map}`")
            else:
                st.warning("**Active Map:** Not set")
            
            status_colors = {
                'not_configured': '🔴',
                'map_selected': '🟡',
                'ors_running': '🟢',
                'ors_stopped': '🟠'
            }
            st.info(f"**Status:** {status_colors.get(ors_status, '⚪')} {ors_status.replace('_', ' ').title()}")
            
            # Show enabled profiles
            enabled_profiles = config.get('enabled_profiles')
            if enabled_profiles:
                try:
                    profiles_list = json.loads(enabled_profiles) if isinstance(enabled_profiles, str) else enabled_profiles
                    if profiles_list:
                        st.markdown(f"**Enabled Profiles:** {', '.join(profiles_list)}")
                except:
                    pass
            
            # Check if config file exists
            if active_map:
                try:
                    config_files = session.sql("LIST @core.generated_maps PATTERN='.*ors-config.*'").collect()
                    if config_files:
                        st.success("📄 **ORS Config:** `ors-config.yml` ✓")
                    else:
                        st.warning("📄 **ORS Config:** Not generated")
                except:
                    pass
        
        with col2:
            st.subheader("🚀 ORS Actions")
            st.markdown("*Coming soon:*")
            st.button("▶️ Start OpenRouteService", disabled=True, help="Feature coming soon")
            st.button("⏹️ Stop OpenRouteService", disabled=True, help="Feature coming soon")
            st.button("🔄 Restart with New Map", disabled=True, help="Feature coming soon")
    except Exception as e:
        st.error(f"Error loading config: {str(e)}")
    
    st.divider()
    
    # Map selection
    st.subheader("🗺️ Select Active Map")
    
    try:
        files_result = session.sql("LIST @core.generated_maps").collect()
        if files_result:
            # Build file list with details
            file_data = []
            for f in files_result:
                full_path = f[0]
                filename = full_path.split('/')[-1]
                if filename.endswith('.osm'):
                    size_mb = f[1] / 1024 / 1024 if f[1] else 0
                    file_data.append({
                        'filename': filename,
                        'size_mb': round(size_mb, 2),
                        'modified': str(f[2]) if len(f) > 2 else 'Unknown'
                    })
            
            if file_data:
                # Show as table
                df = pd.DataFrame(file_data)
                df.columns = ['Filename', 'Size (MB)', 'Modified']
                st.dataframe(df, use_container_width=True, hide_index=True)
                
                # Selection dropdown
                selected_map = st.selectbox(
                    "Choose map to activate:",
                    [f['filename'] for f in file_data],
                    index=None,
                    placeholder="Select a map file..."
                )
                
                if selected_map:
                    # Show preview info
                    selected_info = next((f for f in file_data if f['filename'] == selected_map), None)
                    if selected_info:
                        st.caption(f"Selected: {selected_map} ({selected_info['size_mb']} MB)")
                    
                    st.divider()
                    
                    # Vehicle/Profile selection
                    st.subheader("🚗 Select Vehicle Profiles")
                    st.caption("Choose which routing profiles to enable for OpenRouteService")
                    
                    # Get available profiles
                    try:
                        profiles_df = session.sql("SELECT * FROM TABLE(core.get_available_profiles())").to_pandas()
                        
                        # Group by category
                        col1, col2, col3 = st.columns(3)
                        
                        selected_profiles = []
                        
                        with col1:
                            st.markdown("**🚗 Driving**")
                            driving_profiles = profiles_df[profiles_df['CATEGORY'] == 'Driving']
                            for _, row in driving_profiles.iterrows():
                                if st.checkbox(row['PROFILE_NAME'], value=(row['PROFILE_NAME'] in ['driving-car', 'driving-hgv']), 
                                             help=row['DESCRIPTION'], key=f"profile_{row['PROFILE_NAME']}"):
                                    selected_profiles.append(row['PROFILE_NAME'])
                        
                        with col2:
                            st.markdown("**🚴 Cycling**")
                            cycling_profiles = profiles_df[profiles_df['CATEGORY'] == 'Cycling']
                            for _, row in cycling_profiles.iterrows():
                                if st.checkbox(row['PROFILE_NAME'], value=False, 
                                             help=row['DESCRIPTION'], key=f"profile_{row['PROFILE_NAME']}"):
                                    selected_profiles.append(row['PROFILE_NAME'])
                        
                        with col3:
                            st.markdown("**🚶 Walking**")
                            walking_profiles = profiles_df[profiles_df['CATEGORY'].isin(['Walking', 'Accessibility'])]
                            for _, row in walking_profiles.iterrows():
                                if st.checkbox(row['PROFILE_NAME'], value=(row['PROFILE_NAME'] == 'foot-walking'), 
                                             help=row['DESCRIPTION'], key=f"profile_{row['PROFILE_NAME']}"):
                                    selected_profiles.append(row['PROFILE_NAME'])
                        
                        if not selected_profiles:
                            st.warning("Please select at least one profile")
                        else:
                            st.info(f"Selected profiles: {', '.join(selected_profiles)}")
                    except Exception as e:
                        st.error(f"Error loading profiles: {str(e)}")
                        selected_profiles = ['driving-car', 'driving-hgv', 'foot-walking']
                    
                    st.divider()
                    
                    if selected_profiles and st.button("✅ Set as Active Map & Generate Config", type="primary", use_container_width=True):
                        with st.spinner("Setting active map and generating ORS config..."):
                            try:
                                # Build profiles array for SQL
                                profiles_array = "ARRAY_CONSTRUCT(" + ", ".join([f"'{p}'" for p in selected_profiles]) + ")"
                                result = session.sql(f"CALL core.set_active_map('{selected_map}', {profiles_array})").collect()[0][0]
                                data = json.loads(result)
                                if data.get('success'):
                                    st.success(f"✅ {data.get('message')}")
                                    enabled = data.get('enabled_profiles', [])
                                    st.info(f"📄 ORS config generated with profiles: {', '.join(enabled)}")
                                    st.caption(f"Map path: `/home/ors/files/{selected_map}`")
                                    st.balloons()
                                    st.rerun()
                                else:
                                    st.error(f"Failed: {data.get('error')}")
                            except Exception as e:
                                st.error(f"Error: {str(e)}")
            else:
                st.info("No .osm files found. Generate some maps first!")
        else:
            st.info("No files in stage. Generate some maps first!")
    except Exception as e:
        st.error(f"Error loading files: {str(e)}")
    
    st.divider()
    
    # Future features preview
    st.subheader("🔮 Coming Soon")
    st.markdown("""
    - **Route Calculation** - Calculate optimal routes between points
    - **Isochrones** - Generate travel time zones
    - **Distance Matrix** - Calculate distances between multiple locations
    - **Fleet Optimization** - Optimize delivery routes for multiple vehicles
    """)

elif page == "📊 History":
    st.header("Generation History")
    
    try:
        history = session.sql("""
            SELECT id, created_at, city_name, status, file_path, file_size_bytes, processing_time_seconds
            FROM core.map_generation_history ORDER BY created_at DESC
        """).to_pandas()
        
        if not history.empty:
            col1, col2, col3 = st.columns(3)
            col1.metric("Total", len(history))
            col2.metric("Completed", len(history[history['STATUS'] == 'completed']))
            col3.metric("Failed", len(history[history['STATUS'] == 'failed']))
            
            st.dataframe(history, use_container_width=True)
        else:
            st.info("No history yet.")
    except Exception as e:
        st.error(str(e))
    
    st.divider()
    st.subheader("📁 Generated Files")
    try:
        files = session.sql("LIST @core.generated_maps").collect()
        if files:
            st.success(f"Found {len(files)} files")
            for f in files:
                st.code(f[0])
        else:
            st.info("No files yet.")
    except:
        st.info("No files available.")

elif page == "ℹ️ About":
    st.header("About OpenStreetMap Generator")
    
    st.markdown("""
    **OpenStreetMap Generator** creates custom .osm map files using real OpenStreetMap data.
    
    ### 🔌 APIs Used
    - **[Nominatim API](https://nominatim.openstreetmap.org/)** - Geocoding city names to coordinates
    - **[Overpass API](https://overpass-api.de/)** - Downloading actual map data
    
    ### 📁 Output Format
    Generated maps are in OSM XML format and can be used with:
    - OpenRouteService
    - OSRM
    - Valhalla
    - GraphHopper
    - Other OSM-based routing engines
    
    ### 📏 Size Limits
    - Maximum area: 0.25 square degrees (to prevent timeouts)
    - For larger areas, use multiple requests or download from Geofabrik
    
    ### 💡 Tips
    - Use **Preset** areas for quick testing
    - Use **City Name** for automatic geocoding
    - Use **Coordinates** for precise control
    """)

# Footer
st.divider()
st.markdown("<div style='text-align:center;color:#666;'>🗺️ OpenStreetMap Generator • Powered by Snowflake Native Apps</div>", unsafe_allow_html=True)
