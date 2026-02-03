import streamlit as st
import pandas as pd
import json
import time
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.functions import col, call_function
import pydeck as pdk

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
    .main-header {
        font-size: 2.5rem;
        font-weight: bold;
        color: #1f77b4;
        text-align: center;
        margin-bottom: 2rem;
    }
    .success-box {
        padding: 1rem;
        border-radius: 0.5rem;
        background-color: #d4edda;
        border: 1px solid #c3e6cb;
        color: #155724;
        margin: 1rem 0;
    }
    .error-box {
        padding: 1rem;
        border-radius: 0.5rem;
        background-color: #f8d7da;
        border: 1px solid #f5c6cb;
        color: #721c24;
        margin: 1rem 0;
    }
    .info-box {
        padding: 1rem;
        border-radius: 0.5rem;
        background-color: #d1ecf1;
        border: 1px solid #bee5eb;
        color: #0c5460;
        margin: 1rem 0;
    }
</style>
""", unsafe_allow_html=True)

# Main header
st.markdown('<div class="main-header">🗺️ OpenStreetMap Generator</div>', unsafe_allow_html=True)
st.markdown("Generate custom OpenStreetMap files for any location worldwide using Snowflake Native App")

# Sidebar for navigation
st.sidebar.title("Navigation")
page = st.sidebar.selectbox(
    "Choose a page:",
    ["🏠 Home", "🗺️ Generate Map", "📊 Generation History", "🎯 Preset Areas", "ℹ️ About"]
)

if page == "🏠 Home":
    st.header("Welcome to OpenStreetMap Generator")
    
    col1, col2 = st.columns(2)
    
    with col1:
        st.subheader("🚀 Quick Start")
        st.markdown("""
        1. **Choose Generation Method**: Select from city name, coordinates, or presets
        2. **Specify Area**: Enter your desired location or coordinates
        3. **Generate Map**: Click generate and wait for processing
        4. **Download**: Get your custom .osm file
        """)
        
        st.subheader("✨ Features")
        st.markdown("""
        - 🌍 **Global Coverage**: Generate maps for any location worldwide
        - 🏙️ **City Search**: Find locations by city or place name
        - 📐 **Precise Coordinates**: Use exact bounding box coordinates
        - 🎯 **Popular Presets**: Quick access to major cities
        - 📊 **Generation History**: Track all your map generations
        - ⚡ **Fast Processing**: Powered by Snowflake's cloud infrastructure
        """)
    
    with col2:
        st.subheader("📈 Recent Activity")
        
        # Get recent map generations
        try:
            recent_maps = session.sql("""
                SELECT 
                    area_description,
                    status,
                    file_size_mb,
                    request_timestamp
                FROM core.map_generation_history 
                LIMIT 5
            """).to_pandas()
            
            if not recent_maps.empty:
                st.dataframe(recent_maps, use_container_width=True)
            else:
                st.info("No map generations yet. Start by generating your first map!")
                
        except Exception as e:
            st.warning("Unable to load recent activity")
        
        st.subheader("🎯 Popular Areas")
        try:
            preset_areas = session.sql("SELECT * FROM TABLE(core.get_preset_areas()) LIMIT 4").to_pandas()
            for _, area in preset_areas.iterrows():
                st.markdown(f"**{area['NAME']}**: {area['DESCRIPTION']}")
        except Exception as e:
            st.warning("Unable to load preset areas")

elif page == "🗺️ Generate Map":
    st.header("Generate Custom Map")
    
    # Generation method selection
    method = st.selectbox(
        "Choose generation method:",
        ["🏙️ City/Place Name", "📐 Bounding Box Coordinates", "🎯 Preset Areas"]
    )
    
    bbox_string = None
    area_name = None
    
    if method == "🏙️ City/Place Name":
        st.subheader("Generate Map by City Name")
        
        col1, col2 = st.columns([2, 1])
        with col1:
            city_name = st.text_input(
                "Enter city or place name:",
                placeholder="e.g., London, UK or Manhattan, New York",
                help="Enter any city, district, or landmark name"
            )
        
        with col2:
            if st.button("🔍 Preview Location", disabled=not city_name):
                if city_name:
                    with st.spinner("Geocoding location..."):
                        try:
                            geocode_result = session.sql(f"""
                                SELECT core.geocode_city('{city_name}') as result
                            """).collect()[0][0]
                            
                            if geocode_result['success']:
                                st.success(f"Found: {geocode_result['display_name']}")
                                bbox = geocode_result['bbox']
                                st.info(f"Coordinates: {bbox['xmin']:.4f},{bbox['ymin']:.4f},{bbox['xmax']:.4f},{bbox['ymax']:.4f}")
                                bbox_string = geocode_result['bbox_string']
                                area_name = city_name
                            else:
                                st.error(f"Error: {geocode_result['error']}")
                        except Exception as e:
                            st.error(f"Geocoding failed: {str(e)}")
    
    elif method == "📐 Bounding Box Coordinates":
        st.subheader("Generate Map by Coordinates")
        
        st.markdown("""
        **Bounding Box Format**: `xmin,ymin,xmax,ymax` (longitude,latitude)
        - **xmin/xmax**: Longitude (-180 to 180)
        - **ymin/ymax**: Latitude (-90 to 90)
        """)
        
        col1, col2 = st.columns(2)
        with col1:
            bbox_input = st.text_input(
                "Bounding box coordinates:",
                placeholder="-74.0479,40.7128,-73.9441,40.7831",
                help="Format: xmin,ymin,xmax,ymax"
            )
        
        with col2:
            area_name_input = st.text_input(
                "Area name (optional):",
                placeholder="e.g., Manhattan",
                help="Descriptive name for this area"
            )
        
        if bbox_input:
            try:
                coords = [float(x.strip()) for x in bbox_input.split(',')]
                if len(coords) == 4:
                    xmin, ymin, xmax, ymax = coords
                    
                    # Validate coordinates
                    if (-180 <= xmin <= 180 and -180 <= xmax <= 180 and 
                        -90 <= ymin <= 90 and -90 <= ymax <= 90 and
                        xmin < xmax and ymin < ymax):
                        
                        bbox_string = bbox_input
                        area_name = area_name_input or "Custom Area"
                        
                        # Calculate area size
                        area_size = (xmax - xmin) * (ymax - ymin)
                        st.info(f"Area size: {area_size:.4f} deg² (~{area_size * 12100:.0f} km²)")
                        
                        if area_size > 1.0:
                            st.warning("⚠️ Large area detected. Generation may take longer or fail.")
                    else:
                        st.error("Invalid coordinates. Check ranges and order.")
                else:
                    st.error("Please provide exactly 4 coordinates.")
            except ValueError:
                st.error("Invalid coordinate format. Use numbers separated by commas.")
    
    elif method == "🎯 Preset Areas":
        st.subheader("Generate Map from Preset Areas")
        
        try:
            preset_areas = session.sql("SELECT * FROM TABLE(core.get_preset_areas())").to_pandas()
            
            selected_preset = st.selectbox(
                "Choose a preset area:",
                options=preset_areas['NAME'].tolist(),
                format_func=lambda x: f"{x} - {preset_areas[preset_areas['NAME']==x]['DESCRIPTION'].iloc[0]}"
            )
            
            if selected_preset:
                selected_row = preset_areas[preset_areas['NAME'] == selected_preset].iloc[0]
                bbox_string = selected_row['BBOX']
                area_name = selected_preset
                
                st.info(f"**Selected**: {selected_preset}")
                st.info(f"**Coordinates**: {bbox_string}")
                st.info(f"**Description**: {selected_row['DESCRIPTION']}")
                
        except Exception as e:
            st.error(f"Unable to load preset areas: {str(e)}")
    
    # Map generation section
    if bbox_string and area_name:
        st.divider()
        st.subheader("Generate Map File")
        
        col1, col2 = st.columns([2, 1])
        with col1:
            output_filename = st.text_input(
                "Output filename:",
                value=f"{area_name.lower().replace(' ', '_').replace(',', '')}.osm",
                help="The name for your generated map file"
            )
        
        with col2:
            st.markdown("**Preview:**")
            st.code(f"Area: {area_name}\nBBox: {bbox_string}\nFile: {output_filename}")
        
        if st.button("🚀 Generate Map", type="primary", use_container_width=True):
            if output_filename:
                with st.spinner("Generating map... This may take several minutes."):
                    try:
                        # Prepare request parameters
                        if method == "🏙️ City/Place Name":
                            request_params = {
                                'city_name': city_name,
                                'output_filename': output_filename
                            }
                            request_type = 'city'
                        else:
                            request_params = {
                                'bbox': bbox_string,
                                'output_filename': output_filename
                            }
                            request_type = 'bbox'
                        
                        # Call the map generation procedure
                        result = session.sql(f"""
                            CALL core.generate_map('{request_type}', PARSE_JSON('{json.dumps(request_params)}'))
                        """).collect()[0][0]
                        
                        if result['success']:
                            st.markdown(f"""
                            <div class="success-box">
                                <h4>✅ Map Generated Successfully!</h4>
                                <p><strong>Request ID:</strong> {result['request_id']}</p>
                                <p><strong>Filename:</strong> {result['filename']}</p>
                                <p><strong>File Size:</strong> {result['file_size_mb']} MB</p>
                                <p><strong>Processing Time:</strong> {result['processing_time_seconds']} seconds</p>
                                <p><strong>Area:</strong> {result['bbox']}</p>
                            </div>
                            """, unsafe_allow_html=True)
                            
                            st.balloons()
                            
                        else:
                            st.markdown(f"""
                            <div class="error-box">
                                <h4>❌ Map Generation Failed</h4>
                                <p><strong>Error:</strong> {result['error']}</p>
                                <p><strong>Request ID:</strong> {result.get('request_id', 'N/A')}</p>
                            </div>
                            """, unsafe_allow_html=True)
                            
                    except Exception as e:
                        st.error(f"Generation failed: {str(e)}")
            else:
                st.error("Please provide an output filename.")

elif page == "📊 Generation History":
    st.header("Map Generation History")
    
    try:
        history = session.sql("""
            SELECT 
                request_id,
                request_timestamp,
                request_type,
                area_description,
                output_filename,
                status,
                file_size_mb,
                processing_time_seconds,
                error_message,
                created_by
            FROM core.map_generation_history
        """).to_pandas()
        
        if not history.empty:
            # Summary metrics
            col1, col2, col3, col4 = st.columns(4)
            
            with col1:
                st.metric("Total Requests", len(history))
            
            with col2:
                successful = len(history[history['STATUS'] == 'COMPLETED'])
                st.metric("Successful", successful)
            
            with col3:
                if successful > 0:
                    avg_size = history[history['STATUS'] == 'COMPLETED']['FILE_SIZE_MB'].mean()
                    st.metric("Avg Size (MB)", f"{avg_size:.1f}")
                else:
                    st.metric("Avg Size (MB)", "N/A")
            
            with col4:
                if successful > 0:
                    avg_time = history[history['STATUS'] == 'COMPLETED']['PROCESSING_TIME_SECONDS'].mean()
                    st.metric("Avg Time (sec)", f"{avg_time:.1f}")
                else:
                    st.metric("Avg Time (sec)", "N/A")
            
            st.divider()
            
            # Filters
            col1, col2 = st.columns(2)
            with col1:
                status_filter = st.multiselect(
                    "Filter by status:",
                    options=history['STATUS'].unique(),
                    default=history['STATUS'].unique()
                )
            
            with col2:
                type_filter = st.multiselect(
                    "Filter by type:",
                    options=history['REQUEST_TYPE'].unique(),
                    default=history['REQUEST_TYPE'].unique()
                )
            
            # Apply filters
            filtered_history = history[
                (history['STATUS'].isin(status_filter)) &
                (history['REQUEST_TYPE'].isin(type_filter))
            ]
            
            # Display table
            st.dataframe(
                filtered_history,
                use_container_width=True,
                column_config={
                    "REQUEST_TIMESTAMP": st.column_config.DatetimeColumn(
                        "Timestamp",
                        format="YYYY-MM-DD HH:mm:ss"
                    ),
                    "FILE_SIZE_MB": st.column_config.NumberColumn(
                        "Size (MB)",
                        format="%.2f"
                    ),
                    "PROCESSING_TIME_SECONDS": st.column_config.NumberColumn(
                        "Time (sec)",
                        format="%.1f"
                    )
                }
            )
            
        else:
            st.info("No map generation history found. Generate your first map to see it here!")
            
    except Exception as e:
        st.error(f"Unable to load generation history: {str(e)}")

elif page == "🎯 Preset Areas":
    st.header("Preset Areas")
    st.markdown("Quick access to popular cities and regions around the world.")
    
    try:
        preset_areas = session.sql("SELECT * FROM TABLE(core.get_preset_areas())").to_pandas()
        
        # Display as cards
        cols = st.columns(2)
        for idx, (_, area) in enumerate(preset_areas.iterrows()):
            with cols[idx % 2]:
                with st.container():
                    st.subheader(area['NAME'])
                    st.write(area['DESCRIPTION'])
                    st.code(f"Coordinates: {area['BBOX']}")
                    
                    if st.button(f"Generate {area['NAME']}", key=f"preset_{idx}"):
                        st.session_state['preset_selection'] = {
                            'name': area['NAME'],
                            'bbox': area['BBOX'],
                            'description': area['DESCRIPTION']
                        }
                        st.rerun()
        
        # Handle preset selection
        if 'preset_selection' in st.session_state:
            selection = st.session_state['preset_selection']
            st.divider()
            st.subheader(f"Generate Map: {selection['name']}")
            
            output_filename = st.text_input(
                "Output filename:",
                value=f"{selection['name'].lower().replace(' ', '_').replace(',', '')}.osm"
            )
            
            if st.button("🚀 Generate Preset Map", type="primary"):
                with st.spinner(f"Generating map for {selection['name']}..."):
                    try:
                        request_params = {
                            'bbox': selection['bbox'],
                            'output_filename': output_filename
                        }
                        
                        result = session.sql(f"""
                            CALL core.generate_map('bbox', PARSE_JSON('{json.dumps(request_params)}'))
                        """).collect()[0][0]
                        
                        if result['success']:
                            st.success(f"✅ Map for {selection['name']} generated successfully!")
                            st.json(result)
                        else:
                            st.error(f"❌ Generation failed: {result['error']}")
                            
                    except Exception as e:
                        st.error(f"Generation failed: {str(e)}")
                
                # Clear selection
                del st.session_state['preset_selection']
        
    except Exception as e:
        st.error(f"Unable to load preset areas: {str(e)}")

elif page == "ℹ️ About":
    st.header("About OpenStreetMap Generator")
    
    col1, col2 = st.columns(2)
    
    with col1:
        st.subheader("🎯 Purpose")
        st.markdown("""
        This Snowflake Native App allows you to generate custom OpenStreetMap (OSM) files 
        for any location worldwide. The generated maps can be used with routing engines 
        like OpenRouteService for navigation and logistics applications.
        """)
        
        st.subheader("🔧 Technical Details")
        st.markdown("""
        - **Data Source**: OpenStreetMap via Overpass API
        - **Geocoding**: Nominatim API for city name resolution
        - **Format**: OSM XML format (compatible with routing engines)
        - **Processing**: Snowflake UDFs with external access integrations
        - **Storage**: Snowflake internal stages
        """)
    
    with col2:
        st.subheader("🌍 Coverage")
        st.markdown("""
        - **Global**: Generate maps for any location worldwide
        - **Flexible**: City names, coordinates, or preset areas
        - **Scalable**: From neighborhoods to metropolitan areas
        - **Real-time**: Always uses latest OpenStreetMap data
        """)
        
        st.subheader("⚡ Performance")
        st.markdown("""
        - **Fast**: Powered by Snowflake's cloud infrastructure
        - **Reliable**: Built-in error handling and retry logic
        - **Trackable**: Complete generation history and metrics
        - **Secure**: External access through Snowflake integrations
        """)
    
    st.divider()
    
    st.subheader("📚 Resources")
    col1, col2, col3 = st.columns(3)
    
    with col1:
        st.markdown("""
        **OpenStreetMap**
        - [Main Website](https://www.openstreetmap.org/)
        - [Overpass API](https://overpass-api.de/)
        - [Data License](https://www.openstreetmap.org/copyright)
        """)
    
    with col2:
        st.markdown("""
        **Snowflake**
        - [Native Apps](https://docs.snowflake.com/en/developer-guide/native-apps/)
        - [External Access](https://docs.snowflake.com/en/developer-guide/external-network-access/)
        - [UDFs](https://docs.snowflake.com/en/developer-guide/udf/python/)
        """)
    
    with col3:
        st.markdown("""
        **Routing**
        - [OpenRouteService](https://openrouteservice.org/)
        - [OSRM](http://project-osrm.org/)
        - [Valhalla](https://valhalla.readthedocs.io/)
        """)

# Footer
st.divider()
st.markdown(
    "<div style='text-align: center; color: #666; padding: 1rem;'>"
    "🗺️ OpenStreetMap Generator • Powered by Snowflake Native Apps • "
    "Data © OpenStreetMap contributors"
    "</div>",
    unsafe_allow_html=True
)
