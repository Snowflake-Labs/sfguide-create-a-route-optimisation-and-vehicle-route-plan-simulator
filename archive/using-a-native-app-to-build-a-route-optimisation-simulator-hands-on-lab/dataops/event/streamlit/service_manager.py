"""
🔧 Open Route Service - Service Manager
Manage ORS services, view status, and monitor logs
"""

import streamlit as st
import pandas as pd
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.exceptions import SnowparkSQLException
import time
from datetime import datetime

# Initialize Snowflake session
session = get_active_session()

# Page configuration
st.set_page_config(
    page_title="ORS Service Manager",
    page_icon="🔧",
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
<h0black>OPEN ROUTE SERVICE |</h0black><h0blue> SERVICE MANAGER</h0blue><BR>
<h1grey>Monitor and Control ORS Services</h1grey>
''', unsafe_allow_html=True)

# Service database and schema configuration
SERVICE_DATABASE = 'OPEN_ROUTE_SERVICE_NEW_YORK'
SERVICE_SCHEMA = 'CORE'

def get_service_display_info(service_name):
    """Get display information for a service based on its name"""
    service_map = {
        'ORS_SERVICE': {'icon': '🗺️', 'display': 'Open Route Service', 'desc': 'Core routing and directions service'},
        'OPEN_ROUTE_SERVICE_NEW_YORK': {'icon': '🗺️', 'display': 'Open Route Service', 'desc': 'Core routing and directions service'},
        'ROUTING_GATEWAY_SERVICE': {'icon': '🚪', 'display': 'Routing Gateway', 'desc': 'API gateway for routing requests'},
        'ROUTING-GATEWAY-SERVICE': {'icon': '🚪', 'display': 'Routing Gateway', 'desc': 'API gateway for routing requests'},
        'DOWNLOADER': {'icon': '⬇️', 'display': 'Data Downloader', 'desc': 'Downloads and updates map data'},
        'VROOM_SERVICE': {'icon': '🚚', 'display': 'VROOM Optimizer', 'desc': 'Vehicle routing optimization engine'},
        'VROOM-SERVICE': {'icon': '🚚', 'display': 'VROOM Optimizer', 'desc': 'Vehicle routing optimization engine'},
    }
    
    if service_name in service_map:
        info = service_map[service_name]
        return f"{info['icon']} {info['display']}", info['desc']
    else:
        # Generic fallback for any other services
        return f"⚙️ {service_name}", f"Service: {service_name}"

def get_service_status():
    """Get the current status of all services"""
    try:
        # Use fully qualified name - no USE statements needed in Streamlit
        status_query = f"SHOW SERVICES IN SCHEMA {SERVICE_DATABASE}.{SERVICE_SCHEMA}"
        result = session.sql(status_query).to_pandas()
        
        if not result.empty:
            # Try different possible column names for service name
            service_name_col = None
            for col_name in ['name', 'SERVICE_NAME', 'service_name', 'NAME']:
                if col_name in result.columns:
                    service_name_col = col_name
                    break
            
            if service_name_col:
                # Rename column to standard name for consistency
                result = result.rename(columns={service_name_col: 'SERVICE_NAME'})
                
            # Try different possible column names for status
            status_col = None
            for col_name in ['status', 'STATUS', 'Status']:
                if col_name in result.columns:
                    status_col = col_name
                    break
                    
            if status_col and status_col != 'STATUS':
                result = result.rename(columns={status_col: 'STATUS'})
        
        return result
    except Exception as e:
        st.error(f"❌ Error fetching service status: {str(e)}")
        return pd.DataFrame()

def start_service(database, schema, service_name):
    """Start a specific service"""
    try:
        start_query = f"ALTER SERVICE {database}.{schema}.{service_name} RESUME"
        session.sql(start_query).collect()
        return True, f"✅ Successfully started {service_name}"
    except SnowparkSQLException as e:
        return False, f"❌ Error starting {service_name}: {str(e)}"
    except Exception as e:
        return False, f"❌ Unexpected error starting {service_name}: {str(e)}"

def stop_service(database, schema, service_name):
    """Stop a specific service"""
    try:
        stop_query = f"ALTER SERVICE {database}.{schema}.{service_name} SUSPEND"
        session.sql(stop_query).collect()
        return True, f"🛑 Successfully stopped {service_name}"
    except SnowparkSQLException as e:
        return False, f"❌ Error stopping {service_name}: {str(e)}"
    except Exception as e:
        return False, f"❌ Unexpected error stopping {service_name}: {str(e)}"

def get_service_logs(database, schema, service_name, limit=100):
    """Get logs for a specific service using SPCS SYSTEM$GET_SERVICE_LOGS"""
    try:
        # Based on ORS SPCS services, map service names to their actual container names
        container_mapping = {
            'ROUTING_GATEWAY_SERVICE': 'reverse-proxy',
            'ROUTING GATEWAY SERVICE': 'reverse-proxy', 
            'ORS_SERVICE': 'ors',
            'ORS SERVICE': 'ors',
            'DOWNLOADER': 'downloader',
            'VROOM_SERVICE': 'vroom',
            'VROOM SERVICE': 'vroom'
        }
        
        # Get the correct container name or try common patterns
        possible_containers = []
        
        # First try the mapped container name
        if service_name.upper() in container_mapping:
            possible_containers.append(container_mapping[service_name.upper()])
        
        # Then try common ORS container patterns
        possible_containers.extend([
            'reverse-proxy',  # Common for gateway services
            'ors',            # Correct for main ORS service
            'downloader',     # Common for downloader
            'vroom',          # Correct for VROOM service
            service_name.lower().replace('_', '-'),
            service_name.lower(),
            'main',           # Sometimes used as default container name
            'app'             # Another common container name
        ])
        
        # Remove duplicates while preserving order
        seen = set()
        unique_containers = []
        for container in possible_containers:
            if container not in seen:
                seen.add(container)
                unique_containers.append(container)
        
        logs_text = ""
        successful_container = None
        
        for container in unique_containers:
            try:
                # Correct SPCS syntax: service_name, instance_number, container_name
                log_query = f"SELECT SYSTEM$GET_SERVICE_LOGS('{database}.{schema}.{service_name}', 0, '{container}')"
                result = session.sql(log_query).collect()
                if result and result[0][0] and str(result[0][0]).strip():
                    logs_text = str(result[0][0])
                    successful_container = container
                    break
            except Exception as container_error:
                # Continue trying other containers
                continue
        
        if logs_text:
            return f"=== {service_name} Logs (Container: {successful_container}) ===\n\n{logs_text}"
        else:
            return f"No logs available for {service_name}\n\nTried containers: {', '.join(unique_containers)}\n\nNote: Check Snowsight > Services > {service_name} > Logs to see available container names."
        
    except Exception as e:
        return f"Error retrieving logs for {service_name}: {str(e)}\n\nTroubleshooting:\n1. Check service permissions\n2. Verify service is running\n3. Check container names in Snowsight"

def start_all_services(service_names):
    """Start all ORS services"""
    results = []
    for service_name in service_names:
        display_name, _ = get_service_display_info(service_name)
        success, message = start_service(SERVICE_DATABASE, SERVICE_SCHEMA, service_name)
        results.append((display_name, success, message))
        time.sleep(1)  # Small delay between service starts
    return results

def stop_all_services(service_names):
    """Stop all ORS services"""
    results = []
    for service_name in service_names:
        display_name, _ = get_service_display_info(service_name)
        success, message = stop_service(SERVICE_DATABASE, SERVICE_SCHEMA, service_name)
        results.append((display_name, success, message))
        time.sleep(1)  # Small delay between service stops
    return results

# Sidebar controls
st.sidebar.markdown('<h1sub>🎛️ Service Controls</h1sub>', unsafe_allow_html=True)

# Get current service status for bulk operations
temp_service_status_df = get_service_status()
service_names = temp_service_status_df['SERVICE_NAME'].tolist() if not temp_service_status_df.empty and 'SERVICE_NAME' in temp_service_status_df.columns else []

# TEMPORARY: Fallback to hardcoded service names if discovery fails
if not service_names:
    service_names = ['ORS_SERVICE', 'ROUTING_GATEWAY_SERVICE', 'DOWNLOADER', 'VROOM_SERVICE']

# Clean bulk actions section
st.sidebar.markdown("**Bulk Actions:**")

col1, col2 = st.sidebar.columns(2)

with col1:
    if st.button("🚀 Start All", key="start_all", type="primary"):
        if service_names:
            st.sidebar.info(f"Starting {len(service_names)} services...")
            with st.spinner("Starting all services..."):
                results = start_all_services(service_names)
                for service_name, success, message in results:
                    if success:
                        st.success(message)
                    else:
                        st.error(message)
            st.rerun()
        else:
            st.warning("No services found to start")
            st.sidebar.error("❌ No services detected for bulk start operation")

with col2:
    if st.button("🛑 Stop All", key="stop_all"):
        if service_names:
            with st.spinner("Stopping all services..."):
                results = stop_all_services(service_names)
                for service_name, success, message in results:
                    if success:
                        st.success(message)
                    else:
                        st.error(message)
            st.rerun()
        else:
            st.warning("No services found to stop")

st.sidebar.markdown("---")

# Manual refresh button only
if st.sidebar.button("🔄 Refresh Status"):
    st.rerun()

# Main content
st.markdown('<h1sub>📊 SERVICE STATUS DASHBOARD</h1sub>', unsafe_allow_html=True)

# Get current service status
service_status_df = get_service_status()

if not service_status_df.empty:
    # Create metrics row
    col1, col2, col3, col4 = st.columns(4)
    
    if '"status"' in service_status_df.columns:
        # Clean the status values first (remove quotes) then count
        status_clean = service_status_df['"status"'].astype(str).str.replace('"', '').str.upper()
        running_count = len(status_clean[status_clean == 'RUNNING'])
        stopped_count = len(status_clean[status_clean == 'SUSPENDED'])
        total_count = len(service_status_df)
        error_count = total_count - running_count - stopped_count
    else:
        running_count = stopped_count = error_count = total_count = 0
    
    with col1:
        st.metric("🚀 Running Services", running_count)
    with col2:
        st.metric("🛑 Stopped Services", stopped_count)
    with col3:
        st.metric("⚠️ Error/Unknown", error_count)
    with col4:
        st.metric("📊 Total Services", total_count)
    
    st.markdown("---")
    
    # Service management section
    st.markdown('<h1sub>🔧 INDIVIDUAL SERVICE MANAGEMENT</h1sub>', unsafe_allow_html=True)
    
    # Create service management cards for dynamically discovered services
    if 'SERVICE_NAME' in service_status_df.columns:
        for i, service_name in enumerate(service_status_df['SERVICE_NAME'].tolist()):
            display_name, description = get_service_display_info(service_name)
            
            with st.container():
                col1, col2, col3, col4 = st.columns([3, 2, 1, 1])
                
                with col1:
                    st.markdown(f"**{display_name}**")
                    st.caption(description)
                
                with col2:
                    # Find service status
                    service_row = service_status_df[service_status_df['SERVICE_NAME'] == service_name]
                    if not service_row.empty:
                        status = service_row.iloc[0]['STATUS'] if 'STATUS' in service_row.columns else 'Unknown'
                        if status.upper() == 'RUNNING':
                            st.success(f"✅ {status}")
                        elif status.upper() == 'SUSPENDED':
                            st.error(f"🛑 {status}")
                        else:
                            st.warning(f"⚠️ {status}")
                    else:
                        st.warning("⚠️ Not Found")
                
                with col3:
                    if st.button("🚀 Start", key=f"start_{service_name}"):
                        with st.spinner(f"Starting {display_name}..."):
                            try:
                                success, message = start_service(SERVICE_DATABASE, SERVICE_SCHEMA, service_name)
                                if success:
                                    st.success(message)
                                    time.sleep(2)  # Wait for status update
                                    st.rerun()
                                else:
                                    st.error(message)
                            except Exception as e:
                                st.error(f"❌ Failed to start {display_name}: {str(e)}")
                
                with col4:
                    if st.button("🛑 Stop", key=f"stop_{service_name}"):
                        with st.spinner(f"Stopping {display_name}..."):
                            try:
                                success, message = stop_service(SERVICE_DATABASE, SERVICE_SCHEMA, service_name)
                                if success:
                                    st.success(message)
                                    time.sleep(2)  # Wait for status update
                                    st.rerun()
                                else:
                                    st.error(message)
                            except Exception as e:
                                st.error(f"❌ Failed to stop {display_name}: {str(e)}")
            
            if i < len(service_status_df) - 1:
                st.markdown("---")
    
    st.markdown("---")
    
    # Detailed service status table
    st.markdown('<h1sub>📋 DETAILED SERVICE STATUS</h1sub>', unsafe_allow_html=True)
    
    # Display the service status table with better formatting
    if not service_status_df.empty:
        # Select relevant columns for display using the actual column names (with quotes)
        display_columns = []
        available_columns = {
            '"name"': '🔧 Service',
            '"status"': '📊 Status', 
            '"database_name"': '🗄️ Database',
            '"schema_name"': '📁 Schema',
            '"current_instances"': '📈 Running',
            '"target_instances"': '🎯 Target',
            '"min_instances"': '📉 Min',
            '"max_instances"': '📈 Max',
            '"auto_resume"': '🔄 Auto Resume',
            '"owner"': '👤 Owner',
            '"created_on"': '📅 Created'
        }
        
        # Use the actual column names from the service status
        for col in available_columns.keys():
            if col in service_status_df.columns:
                display_columns.append(col)
        
        if display_columns:
            display_df = service_status_df[display_columns].copy()
            
            # Clean up and format the data using actual column names
            for col in display_df.columns:
                if col == '"name"':
                    # Clean service names - remove quotes and improve display
                    display_df[col] = display_df[col].astype(str).str.replace('"', '').str.replace('_', ' ')
                elif col == '"status"':
                    # Add status symbols and clean quotes
                    display_df[col] = display_df[col].astype(str).str.replace('"', '').apply(lambda x: 
                        f"🟢 {x}" if str(x).upper() == 'RUNNING' 
                        else f"🔴 {x}" if str(x).upper() == 'SUSPENDED'
                        else f"🟡 {x}")
                elif col == '"auto_resume"':
                    # Convert boolean to symbols and clean quotes
                    display_df[col] = display_df[col].astype(str).str.replace('"', '').apply(lambda x: 
                        "✅" if str(x).upper() == 'TRUE' 
                        else "❌" if str(x).upper() == 'FALSE'
                        else str(x))
                elif col in ['"current_instances"', '"target_instances"', '"min_instances"', '"max_instances"']:
                    # Format numbers nicely and clean quotes
                    display_df[col] = display_df[col].astype(str).str.replace('"', '')
                elif col == '"created_on"':
                    # Format dates nicely and clean quotes
                    try:
                        # First remove quotes, then parse datetime
                        cleaned_dates = display_df[col].astype(str).str.replace('"', '')
                        display_df[col] = pd.to_datetime(cleaned_dates, errors='coerce').dt.strftime('%Y-%m-%d %H:%M')
                    except:
                        display_df[col] = display_df[col].astype(str).str.replace('"', '')
                else:
                    # Clean all other string columns (remove quotes)
                    display_df[col] = display_df[col].astype(str).str.replace('"', '')
            
            # Rename columns with emojis
            column_mapping = {col: available_columns[col] for col in display_columns if col in available_columns}
            display_df = display_df.rename(columns=column_mapping)
            
            # Create column config dynamically based on what we actually have
            column_config = {}
            for col in display_df.columns:
                if "Service" in col:
                    column_config[col] = st.column_config.TextColumn(col, width="medium")
                elif "Status" in col:
                    column_config[col] = st.column_config.TextColumn(col, width="medium")
                elif any(word in col for word in ["Running", "Target", "Min", "Max"]):
                    column_config[col] = st.column_config.TextColumn(col, width="small")
                elif "Resume" in col:
                    column_config[col] = st.column_config.TextColumn(col, width="small")
                else:
                    column_config[col] = st.column_config.TextColumn(col, width="medium")
            
            st.dataframe(
                display_df,
                use_container_width=True,
                hide_index=True,
                column_config=column_config
            )
        else:
            st.dataframe(service_status_df, use_container_width=True, hide_index=True)
    
    # Service logs section with tabs
    st.markdown("---")
    st.markdown('<h1sub>📜 SERVICE LOGS</h1sub>', unsafe_allow_html=True)
    
    # Get available services for logs
    if '"name"' in service_status_df.columns:
        # Clean service names (remove quotes)
        available_services = [name.strip('"') for name in service_status_df['"name"'].tolist()]
        
        if available_services:
            # Create tabs for each service
            tabs = st.tabs([get_service_display_info(service)[0] for service in available_services])
            
            for i, (tab, service_name) in enumerate(zip(tabs, available_services)):
                with tab:
                    col1, col2 = st.columns([1, 4])
                    
                    with col1:
                        log_limit = st.number_input(
                            "Log lines:", 
                            min_value=50, 
                            max_value=1000, 
                            value=200, 
                            step=50,
                            key=f"log_limit_{service_name}"
                        )
                    
                    with col2:
                        if st.button(f"🔄 Refresh Logs", key=f"refresh_{service_name}"):
                            st.rerun()
                    
                    # Clean logs section without debug clutter
                    
                    # Fetch and display logs
                    with st.spinner(f"Fetching logs for {service_name}..."):
                        logs_text = get_service_logs(SERVICE_DATABASE, SERVICE_SCHEMA, service_name, log_limit)
                        
                        # Display logs in a scrollable text area
                        st.text_area(
                            f"📋 {service_name} Logs",
                            value=logs_text,
                            height=400,
                            key=f"logs_{service_name}",
                            help="Service logs are refreshed when you click the refresh button"
                        )
        else:
            st.info("No services available for log viewing.")
    else:
        st.info("Service information not available.")

else:
    st.warning("⚠️ No services found. Make sure you have the required permissions to view services in the OPEN_ROUTE_SERVICE_NEW_YORK.CORE schema.")
    st.info("""
    **Required Permissions:**
    - USAGE on OPEN_ROUTE_SERVICE_NEW_YORK database
    - USAGE on OPEN_ROUTE_SERVICE_NEW_YORK.CORE schema
    - MONITOR privilege on services
    - OPERATE privilege on services (for start/stop operations)
    """)

# Footer with helpful information
st.markdown("---")
st.markdown('<h1sub>ℹ️ SERVICE INFORMATION</h1sub>', unsafe_allow_html=True)

info_col1, info_col2 = st.columns(2)

with info_col1:
    st.markdown("""
    **🔧 Service Management:**
    - **Start All**: Resumes all ORS services
    - **Stop All**: Suspends all ORS services  
    - **Individual Controls**: Manage services separately
    - **Auto-refresh**: Automatically update status every 30 seconds
    """)

with info_col2:
    st.markdown("""
    **📊 Service Status:**
    - **RUNNING**: Service is active and processing requests
    - **SUSPENDED**: Service is stopped and not processing requests
    - **ERROR**: Service encountered an issue
    - **UNKNOWN**: Status could not be determined
    """)

# Display current timestamp
st.caption(f"🕒 Last updated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
