import json
import math
import streamlit as st
import streamlit.components.v1 as components
import pandas as pd
import pydeck as pdk
import branca.colormap as cm
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.functions import col, lit, call_function, object_construct, array_construct, to_geography
from snowflake.snowpark.types import FloatType, StringType


# ─────────────────────────────  PAGE CONFIG  ────────────────────────────────
st.set_page_config(
    page_title="Retail Catchment Analysis",
    page_icon="🏪",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ─────────────────────────────  CSS  & LOGO  ────────────────────────────────
try:
    with open('extra.css') as f:
        st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)
except Exception:
    pass

try:
    st.logo('logo.svg')
except Exception:
    pass

st.markdown('''
<h0black>RETAIL |</h0black><h0blue> CATCHMENT ANALYSIS</h0blue><BR>
<h1grey>Analyze competitor catchments for retail stores</h1grey>
''', unsafe_allow_html=True)


# ─────────────────────────────  SESSION  ────────────────────────────────────
session = get_active_session()


# ─────────────────────────────  SIDEBAR INPUTS  ─────────────────────────────
with st.sidebar:
    st.markdown('<h1sub>Parameters</h1sub>', unsafe_allow_html=True)

    # Where routing functions live (keep consistent with other apps)
    route_functions_option = st.radio(
        'Where are the routing functions',
        ['OPEN_ROUTE_SERVICE_NEW_YORK'],
        index=0
    )

    st.markdown('<h1sub>Store Location</h1sub>', unsafe_allow_html=True)
    
    # Get retailers for dropdown
    retailers_df = session.sql("SELECT DISTINCT retailer FROM FLEET_INTELLIGENCE.PUBLIC.NYC_RETAIL_STORES ORDER BY retailer").to_pandas()
    selected_retailer = st.selectbox('Select Retailer', retailers_df['RETAILER'].tolist())
    
    # Get stores for selected retailer (using proper SQL escaping)
    escaped_retailer = selected_retailer.replace("'", "''")  # Double apostrophes for SQL escaping
    stores_sql = f"""
        SELECT store_id, store_name, address, latitude, longitude, store_type, daily_footfall 
        FROM FLEET_INTELLIGENCE.PUBLIC.NYC_RETAIL_STORES 
        WHERE retailer = '{escaped_retailer}' 
        ORDER BY store_name
    """
    stores_df = session.sql(stores_sql).to_pandas()
    
    # Create display options for stores (name + address)
    store_options = []
    for _, row in stores_df.iterrows():
        store_options.append(f"{row['STORE_NAME']} - {row['ADDRESS']}")
    
    # Ensure we have store options
    if store_options:
        selected_store_display = st.selectbox('Select Store Location', store_options)
        
        # Get coordinates for selected store
        if selected_store_display and selected_store_display in store_options:
            selected_store_idx = store_options.index(selected_store_display)
            selected_store = stores_df.iloc[selected_store_idx]
            center_lat = selected_store['LATITUDE']
            center_lon = selected_store['LONGITUDE']
            selected_store_name = selected_store['STORE_NAME']
            
            # Show selected coordinates
            st.caption(f"📍 Coordinates: {center_lat:.4f}, {center_lon:.4f}")
        else:
            # Fallback to first store if selection is invalid
            selected_store = stores_df.iloc[0]
            center_lat = selected_store['LATITUDE']
            center_lon = selected_store['LONGITUDE']
            selected_store_name = selected_store['STORE_NAME']
            st.caption(f"📍 Coordinates: {center_lat:.4f}, {center_lon:.4f}")
    else:
        # Fallback coordinates if no stores found
        center_lat = 40.7589
        center_lon = -73.9851
        selected_store_name = "Default Location"
        st.error("No stores found for selected retailer")
        st.caption(f"📍 Using default coordinates: {center_lat:.4f}, {center_lon:.4f}")

    st.markdown('<h1sub>Travel Mode</h1sub>', unsafe_allow_html=True)
    mode_label = st.selectbox('Mode', ['Walking', 'Driving'])
    profile = 'foot-walking' if mode_label.lower().startswith('walk') else 'driving-car'

    st.markdown('<h1sub>Customer Catchment</h1sub>', unsafe_allow_html=True)
    num_rings = st.slider('Number of catchment zones', min_value=1, max_value=5, value=3)
    max_minutes = st.slider('Maximum travel time (minutes)', min_value=1, max_value=120, value=30)

    st.markdown('<h1sub>Display Options</h1sub>', unsafe_allow_html=True)
    show_isochrones = st.checkbox('Show catchment boundaries', value=True)
    show_competitors = st.checkbox('Show competitor stores', value=True)
    
    st.markdown('<h1sub>Demographics</h1sub>', unsafe_allow_html=True)
    show_density = st.checkbox('Show demographic analysis (H3)', value=True)
    demographic_metric = st.selectbox(
        'Visualization metric',
        ['Address Count', 'Population Density', 'Household Income'],
        help="Choose which demographic metric to visualize with colors"
    )
    h3_res = st.slider('H3 resolution', min_value=6, max_value=10, value=7)
    
    st.markdown('<h1sub>Filtering</h1sub>', unsafe_allow_html=True)
    # Create ring options based on number of rings and max minutes
    ring_options = ["All Rings (Outermost)"]
    if num_rings > 1:
        # Calculate ring breakpoints inline to avoid function order issues
        step = max(1, math.floor(max_minutes / num_rings))
        temp_ring_minutes = [step * i for i in range(1, num_rings + 1)]
        if temp_ring_minutes[-1] != max_minutes:
            temp_ring_minutes[-1] = max_minutes
        
        for i, minutes in enumerate(temp_ring_minutes, 1):
            ring_options.append(f"Zone {i} (≤{minutes} min)")
    
    filter_ring = st.selectbox(
        'Filter data by catchment zone',
        ring_options,
        help="Choose which catchment zone to use for filtering address density and competitor analysis"
    )

    st.caption('Analysis runs only when you click the button below')
    build = st.button('📊 Analyze Customer Reach', type='primary')


# ─────────────────────────────  AI ANALYSIS FUNCTIONS  ──────────────────────
def get_ai_analysis_snowpark(selected_store, retailer, lat, lon, competitors_df, demographics_df, ring_minutes, max_minutes, travel_mode, demographic_metric):
    """Get AI-powered market analysis using Snowflake's AI_COMPLETE with Snowpark object construction"""
    
    # Create the analysis data directly in Snowflake using object_construct
    try:
        # Create base prompt without data
        base_prompt = """
        Based on the comprehensive retail market data provided, write a detailed market analysis and strategic recommendations. 
        Use the following structure with HTML styling for Streamlit:

        <h1sub>🏪 Store Performance Analysis</h1sub>
        Analyze the selected store's position, daily footfall, and competitive advantages.

        <h1sub>🎯 Catchment Area Insights</h1sub>
        Discuss the travel time zones, accessibility, and customer reach potential.

        <h1sub>⚔️ Competitive Landscape</h1sub>
        Analyze competitor density, market saturation, and competitive threats/opportunities.
        Make competitor names <span style="color: #29B5E8; font-weight: bold;">bold and blue</span>.

        <h1sub>👥 Demographic Profile</h1sub>
        Analyze population density, household income, and customer demographic fit.
        Highlight income ranges in <span style="color: #2E7D32; font-weight: bold;">green</span>.

        <h1sub>📍 Recommended New Store Location</h1sub>
        Based on the analysis, recommend ONE specific location for a new store. Provide:
        - Exact latitude and longitude coordinates (4 decimal places)
        - Clear reasoning for this location choice
        - Expected benefits and market opportunity
        - Distance from existing competitors

        Format the coordinates EXACTLY as: RECOMMENDED_LOCATION: 40.7589,-73.9851

        <h1sub>🚀 Strategic Recommendations</h1sub>
        Provide actionable business recommendations for market expansion and optimization.

        Use bullet points, emphasize key metrics with <h1grey>tags</h1grey>, and make the analysis actionable for business decision-making.
        Format monetary values with commas and currency symbols. Round coordinates to 4 decimal places.
        
        Market Data:
        """
        
        # Create Snowpark DataFrame with the analysis data
        analysis_df = session.create_dataframe([{
            'STORE_NAME': str(selected_store.get('STORE_NAME', 'N/A')),
            'RETAILER': str(retailer), 
            'STORE_TYPE': str(selected_store.get('STORE_TYPE', 'N/A')),
            'ADDRESS': str(selected_store.get('ADDRESS', 'N/A')),
            'LATITUDE': float(lat),
            'LONGITUDE': float(lon),
            'DAILY_FOOTFALL': int(selected_store.get('DAILY_FOOTFALL', 0)) if selected_store.get('DAILY_FOOTFALL') is not None else 0,
            'TRAVEL_MODE': str(travel_mode),
            'MAX_TRAVEL_TIME': int(max_minutes),
            'CATCHMENT_ZONES': len(ring_minutes) if ring_minutes else 1,
            'TOTAL_COMPETITORS': len(competitors_df) if not competitors_df.empty else 0,
            'COMPETITOR_FOOTFALL': int(competitors_df['DAILY_FOOTFALL'].sum()) if not competitors_df.empty and 'DAILY_FOOTFALL' in competitors_df.columns else 0,
            'DEMOGRAPHIC_METRIC': str(demographic_metric),
            'H3_CELLS': len(demographics_df) if not demographics_df.empty else 0,
            'TOTAL_ADDRESSES': int(demographics_df['COUNT'].sum()) if not demographics_df.empty and 'COUNT' in demographics_df.columns else 0,
            'AVG_POPULATION_DENSITY': float(demographics_df['POPULATION_DENSITY'].mean()) if not demographics_df.empty and 'POPULATION_DENSITY' in demographics_df.columns else 0,
            'AVG_HOUSEHOLD_INCOME': float(demographics_df['AVG_HOUSEHOLD_INCOME'].mean()) if not demographics_df.empty and 'AVG_HOUSEHOLD_INCOME' in demographics_df.columns else 0
        }])
        
        # Use object_construct to build the data object and combine with prompt
        result = analysis_df.select(
            call_function('AI_COMPLETE', 
                         lit('claude-3-5-sonnet'),
                         call_function('CONCAT',
                                     lit(base_prompt),
                                     object_construct(
                                         lit('store_name'), col('STORE_NAME'),
                                         lit('retailer'), col('RETAILER'),
                                         lit('store_type'), col('STORE_TYPE'),
                                         lit('address'), col('ADDRESS'),
                                         lit('latitude'), col('LATITUDE'),
                                         lit('longitude'), col('LONGITUDE'),
                                         lit('daily_footfall'), col('DAILY_FOOTFALL'),
                                         lit('travel_mode'), col('TRAVEL_MODE'),
                                         lit('max_travel_time_minutes'), col('MAX_TRAVEL_TIME'),
                                         lit('catchment_zones'), col('CATCHMENT_ZONES'),
                                         lit('total_competitors'), col('TOTAL_COMPETITORS'),
                                         lit('total_competitor_footfall'), col('COMPETITOR_FOOTFALL'),
                                         lit('demographic_metric'), col('DEMOGRAPHIC_METRIC'),
                                         lit('h3_cells_analyzed'), col('H3_CELLS'),
                                         lit('total_addresses'), col('TOTAL_ADDRESSES'),
                                         lit('avg_population_density'), col('AVG_POPULATION_DENSITY'),
                                         lit('avg_household_income'), col('AVG_HOUSEHOLD_INCOME')
                                     ).astype(StringType())
                                     )
                         ).astype(StringType())
        ).collect()
        
        return result[0][0] if result else "Analysis unavailable at this time."
    
    except Exception as e:
        return f"<h1sub>⚠️ Analysis Error</h1sub><br/>Unable to generate AI analysis: {str(e)}"

def create_analysis_data_object(selected_store, retailer, lat, lon, competitors_df, demographics_df, ring_minutes, max_minutes, travel_mode, demographic_metric):
    """Create comprehensive data object for AI analysis"""
    
    # Store details
    store_data = {
        "store_name": selected_store.get('STORE_NAME', 'N/A'),
        "retailer": retailer,
        "store_type": selected_store.get('STORE_TYPE', 'N/A'),
        "address": selected_store.get('ADDRESS', 'N/A'),
        "latitude": lat,
        "longitude": lon,
        "daily_footfall": selected_store.get('DAILY_FOOTFALL', 0)
    }
    
    # Catchment analysis
    catchment_data = {
        "travel_mode": travel_mode,
        "max_travel_time_minutes": max_minutes,
        "catchment_zones": len(ring_minutes),
        "zone_boundaries_minutes": ring_minutes
    }
    
    # Competitor analysis
    competitor_data = {
        "total_competitors": len(competitors_df),
        "competitors_by_retailer": {},
        "total_competitor_footfall": 0
    }
    
    if not competitors_df.empty:
        # Group competitors by retailer
        for retailer_name in competitors_df['RETAILER'].unique():
            retailer_stores = competitors_df[competitors_df['RETAILER'] == retailer_name]
            competitor_data["competitors_by_retailer"][retailer_name] = {
                "store_count": len(retailer_stores),
                "avg_footfall": retailer_stores['DAILY_FOOTFALL'].mean(),
                "total_footfall": retailer_stores['DAILY_FOOTFALL'].sum()
            }
        
        competitor_data["total_competitor_footfall"] = competitors_df['DAILY_FOOTFALL'].sum()
    
    # Demographic analysis
    demographic_data = {
        "analysis_metric": demographic_metric,
        "total_h3_cells": len(demographics_df),
        "demographic_stats": {}
    }
    
    if not demographics_df.empty:
        demographic_data["demographic_stats"] = {
            "address_count": {
                "total": demographics_df['COUNT'].sum(),
                "average_per_cell": demographics_df['COUNT'].mean(),
                "max_per_cell": demographics_df['COUNT'].max()
            }
        }
        
        if 'POPULATION_DENSITY' in demographics_df.columns:
            demographic_data["demographic_stats"]["population_density"] = {
                "average": demographics_df['POPULATION_DENSITY'].mean(),
                "max": demographics_df['POPULATION_DENSITY'].max(),
                "min": demographics_df['POPULATION_DENSITY'].min()
            }
        
        if 'AVG_HOUSEHOLD_INCOME' in demographics_df.columns:
            demographic_data["demographic_stats"]["household_income"] = {
                "average": demographics_df['AVG_HOUSEHOLD_INCOME'].mean(),
                "max": demographics_df['AVG_HOUSEHOLD_INCOME'].max(),
                "min": demographics_df['AVG_HOUSEHOLD_INCOME'].min()
            }
    
    # Combine all data
    analysis_object = {
        "store_details": store_data,
        "catchment_analysis": catchment_data,
        "competitor_analysis": competitor_data,
        "demographic_profile": demographic_data,
        "market_context": "New York City retail market analysis"
    }
    
    return json.dumps(analysis_object, indent=2)

@st.cache_data
def get_ai_analysis(analysis_data_json):
    """Get AI-powered market analysis using Snowflake's AI_COMPLETE"""
    
    prompt = f"""
    Based on the comprehensive retail market data provided, write a detailed market analysis and strategic recommendations. 
    Use the following structure with HTML styling for Streamlit:

    <h1sub>🏪 Store Performance Analysis</h1sub>
    Analyze the selected store's position, daily footfall, and competitive advantages.

    <h1sub>🎯 Catchment Area Insights</h1sub>
    Discuss the travel time zones, accessibility, and customer reach potential.

    <h1sub>⚔️ Competitive Landscape</h1sub>
    Analyze competitor density, market saturation, and competitive threats/opportunities.
    Make competitor names <span style="color: #29B5E8; font-weight: bold;">bold and blue</span>.

    <h1sub>👥 Demographic Profile</h1sub>
    Analyze population density, household income, and customer demographic fit.
    Highlight income ranges in <span style="color: #2E7D32; font-weight: bold;">green</span>.

    <h1sub>📍 New Store Location Recommendations</h1sub>
    Provide 3-4 specific recommendations for new store locations based on:
    - Areas with high population density but low competitor presence
    - Demographic alignment with the retailer's target market
    - Accessibility and catchment potential
    - Strategic market gaps

    <h1sub>🚀 Strategic Recommendations</h1sub>
    Provide actionable business recommendations for market expansion and optimization.

    Use bullet points, emphasize key metrics with <h1grey>tags</h1grey>, and make the analysis actionable for business decision-making.
    Format monetary values with commas and currency symbols. Round coordinates to 4 decimal places.
    
    Market Data: {analysis_data_json}
    """
    
    try:
        # Use Snowflake's AI_COMPLETE function
        result = session.sql(f"""
            SELECT AI_COMPLETE('claude-3-5-sonnet', '{prompt.replace("'", "''")}')
        """).collect()
        
        return result[0][0] if result else "Analysis unavailable at this time."
    
    except Exception as e:
        return f"<h1sub>⚠️ Analysis Error</h1sub><br/>Unable to generate AI analysis: {str(e)}"


# ─────────────────────────────  HELPERS  ────────────────────────────────────
def minutes_breakpoints(max_mins: int, n: int) -> list:
    if n <= 1:
        return [max_mins]
    step = max(1, math.floor(max_mins / n))
    values = [step * i for i in range(1, n + 1)]
    if values[-1] != max_mins:
        values[-1] = max_mins
    return values


BASE_COLORS = [
    [41, 181, 232],   # Snowflake blue
    [125, 68, 207],   # Purple
    [212, 91, 144],   # Pink
    [255, 159, 54],   # Orange
    [0, 53, 69],      # Midnight
]


def get_palette(num: int) -> list:
    if num <= len(BASE_COLORS):
        return BASE_COLORS[:num]
    # Cycle if more than base colors (unlikely with max 5)
    return [BASE_COLORS[i % len(BASE_COLORS)] for i in range(num)]


def build_isochrones_dataframe(profile_name: str, longitude: float, latitude: float, minute_values: list) -> pd.DataFrame:
    rows = []
    for minutes in minute_values:
        df = session.create_dataframe([
            {
                'PROFILE': profile_name,
                'LON': float(longitude),
                'LAT': float(latitude),
                'RANGE_MINS': int(minutes)
            }
        ])

        # CALL: <DB>.<SCHEMA>.ISOCHRONES(profile, lon, lat, range_mins)
        # Returns GeoJSON FeatureCollection; we convert geometry to GEOGRAPHY
        result = df.select(
            call_function(f'{route_functions_option}.CORE.ISOCHRONES',
                          col('PROFILE'), col('LON'), col('LAT'), col('RANGE_MINS')).alias('ISOCHRONE')
        )

        geo = result.select(
            to_geography(col('ISOCHRONE')['features'][0]['geometry']).alias('GEO')
        )

        pdf = geo.select('GEO').to_pandas()
        if not pdf.empty and pdf.loc[0, 'GEO'] is not None:
            coords = json.loads(pdf.loc[0, 'GEO'])['coordinates']
            rows.append({'minutes': minutes, 'coordinates': coords})

    return pd.DataFrame(rows)


def make_polygon_layers(iso_df: pd.DataFrame):
    if iso_df.empty:
        return []

    sorted_df = iso_df.sort_values('minutes').reset_index(drop=True)
    palette = get_palette(len(sorted_df))

    layers = []
    for i, row in sorted_df.iterrows():
        color = palette[i]
        # Create tooltip for isochrone polygon
        tooltip_text = f'<b>Catchment Zone</b><br/><b>Travel Time:</b> ≤{row["minutes"]} minutes<br/><b>Zone Number:</b> {i+1} of {len(sorted_df)}<br/><b>Travel Mode:</b> {"Walking" if "foot" in str(row.get("profile", "")) else "Driving"}'
        
        layer = pdk.Layer(
            'PolygonLayer',
            data=pd.DataFrame([{
                'coordinates': row['coordinates'], 
                'minutes': row['minutes'],
                'TOOLTIP': tooltip_text
            }]),
            get_polygon='coordinates',
            filled=True,
            opacity=0.35,
            get_fill_color=[color[0], color[1], color[2], 140],
            get_line_color=[color[0], color[1], color[2]],
            line_width_min_pixels=2,
            pickable=True,
        )
        layers.append(layer)
    return layers


# Colour utilities for H3 layer
def colourise(series: pd.Series, palette: list, vmin, vmax, stops) -> pd.Series:
    cmap = cm.LinearColormap(palette, vmin=vmin, vmax=vmax, index=stops)
    return series.apply(cmap.rgb_bytes_tuple)


# ─────────────────────────────  BUILD ON CLICK  ─────────────────────────────
col_left, col_right = st.columns([3, 2])

with col_left:
    st.markdown('<h1sub>Map</h1sub>', unsafe_allow_html=True)

    if build:
        # Step 1: Calculate customer catchment zones
        with st.spinner('Calculating customer catchment zones...'):
            ring_minutes = minutes_breakpoints(max_minutes, num_rings)
            iso_pdf = build_isochrones_dataframe(profile, center_lon, center_lat, ring_minutes)

        # Step 2: Setup center marker and polygon layers
        # Get footfall for selected store
        selected_footfall = selected_store['DAILY_FOOTFALL'] if 'DAILY_FOOTFALL' in selected_store else 'N/A'
        
        center_df = pd.DataFrame([{
            'lon': center_lon, 
            'lat': center_lat, 
            'TOOLTIP': f'<b>Selected Store</b><br/><b>Name:</b> {selected_store_name}<br/><b>Retailer:</b> {selected_retailer}<br/><b>Daily Footfall:</b> {selected_footfall:,} customers<br/><b>Coordinates:</b> {center_lat:.4f}, {center_lon:.4f}'
        }])
        center_layer = pdk.Layer(
            'ScatterplotLayer',
            data=center_df,
            get_position=['lon', 'lat'],
            get_fill_color=[255, 0, 0],  # Red for selected store
            get_radius=250,
            pickable=True,
        )

        # Step 2b: Setup competitor store layers with isochrone filtering
        competitor_layers = []
        if show_competitors:
            # Determine filter minutes for competitors
            if filter_ring == "All Rings (Outermost)":
                competitor_filter_minutes = max(ring_minutes) if ring_minutes else max_minutes
            else:
                ring_num = int(filter_ring.split()[1])
                competitor_filter_minutes = ring_minutes[ring_num - 1] if ring_minutes else max_minutes
            
            # Get stores within the selected isochrone ring
            with st.spinner(f'Analyzing competitors within {filter_ring.lower()}...'):
                competitors_sql = f"""
                    WITH ISO AS (
                        SELECT TO_GEOGRAPHY(( {route_functions_option}.CORE.ISOCHRONES('{profile}', {center_lon}, {center_lat}, {competitor_filter_minutes}) )['features'][0]['geometry']) AS GEO
                    )
                    SELECT s.retailer, s.store_name, s.address, s.latitude, s.longitude, s.store_type, s.daily_footfall 
                    FROM FLEET_INTELLIGENCE.PUBLIC.NYC_RETAIL_STORES s
                    CROSS JOIN ISO
                    WHERE ST_WITHIN(s.location, ISO.GEO)
                    AND NOT (s.latitude = {center_lat} AND s.longitude = {center_lon})
                    ORDER BY s.retailer, s.store_name
                """
                all_stores_df = session.sql(competitors_sql).to_pandas()
            
            # Create different colors for each retailer
            retailer_colors = {
                "Target": [220, 53, 69],        # Target red
                "Best Buy": [255, 193, 7],      # Best Buy yellow
                "CVS": [156, 39, 176],          # CVS purple
                "Walgreens": [40, 167, 69],     # Walgreens green
                "Home Depot": [255, 87, 34],    # Home Depot orange
                "Staples": [33, 150, 243]       # Staples blue
            }
            
            # Group by retailer and create a layer for each
            for retailer in all_stores_df['RETAILER'].unique():
                retailer_stores = all_stores_df[all_stores_df['RETAILER'] == retailer]
                
                if not retailer_stores.empty:
                    # Prepare data for pydeck
                    competitor_data = []
                    for _, row in retailer_stores.iterrows():
                        competitor_data.append({
                            'lon': row['LONGITUDE'],
                            'lat': row['LATITUDE'],
                            'TOOLTIP': f'<b>Competitor Store</b><br/><b>Retailer:</b> {row["RETAILER"]}<br/><b>Name:</b> {row["STORE_NAME"]}<br/><b>Type:</b> {row["STORE_TYPE"]}<br/><b>Daily Footfall:</b> {row["DAILY_FOOTFALL"]:,} customers<br/><b>Address:</b> {row["ADDRESS"]}<br/><b>Coordinates:</b> {row["LATITUDE"]:.4f}, {row["LONGITUDE"]:.4f}',
                            'RETAILER': row['RETAILER']
                        })
                    
                    competitor_df = pd.DataFrame(competitor_data)
                    
                    # Clean retailer name for layer ID
                    clean_retailer_name = retailer.replace(" ", "_").replace("'", "")
                    
                    competitor_layer = pdk.Layer(
                        'ScatterplotLayer',
                        data=competitor_df,
                        get_position=['lon', 'lat'],
                        get_fill_color=retailer_colors.get(retailer, [128, 128, 128]),  # Default gray if retailer not found
                        get_radius=150,
                        pickable=True,
                        id=f'competitors_{clean_retailer_name}'
                    )
                    competitor_layers.append(competitor_layer)

        poly_layers = make_polygon_layers(iso_pdf)
        hex_layer = None

        # Step 3: Address density calculation if enabled
        if show_density:
            # Determine which ring to use for filtering
            if filter_ring == "All Rings (Outermost)":
                filter_minutes = max(ring_minutes) if ring_minutes else max_minutes
            else:
                # Extract ring number from selection (e.g., "Ring 2 (≤20 min)" -> 2)
                ring_num = int(filter_ring.split()[1])
                filter_minutes = ring_minutes[ring_num - 1] if ring_minutes else max_minutes
            
            # Step 3a: Calculate addresses and demographics at resolution
            with st.spinner(f'Calculating addresses and demographics at H3 resolution {h3_res}...'):
                addr_sql = f"""
                    WITH base_addresses AS (
                        SELECT H3_POINT_TO_CELL_STRING(a.GEOMETRY, {h3_res}) AS H3_CELL,
                               COUNT(*) AS ADDRESS_COUNT
                        FROM FLEET_INTELLIGENCE.PUBLIC.NEW_YORK_ADDRESSES a
                        GROUP BY 1
                    ),
                    demographics AS (
                        SELECT H3_CELL,
                               ADDRESS_COUNT AS COUNT,
                               -- Generate realistic population density (people per sq km) based on NYC patterns
                               -- Manhattan: 25,000-35,000 people/km², Brooklyn: 15,000-25,000, Queens: 8,000-15,000
                               CASE 
                                   WHEN ADDRESS_COUNT > 200 THEN 25000 + (UNIFORM(1,10,RANDOM()) * 1000)::INT  -- Dense Manhattan: 26K-35K
                                   WHEN ADDRESS_COUNT > 100 THEN 20000 + (UNIFORM(1,8,RANDOM()) * 1000)::INT   -- Mid Manhattan/Brooklyn: 21K-28K
                                   WHEN ADDRESS_COUNT > 50 THEN 15000 + (UNIFORM(1,6,RANDOM()) * 1000)::INT    -- Brooklyn/Queens: 16K-21K
                                   ELSE 8000 + (UNIFORM(1,5,RANDOM()) * 1000)::INT                            -- Outer areas: 9K-13K
                               END AS POPULATION_DENSITY,
                               -- Generate realistic household income (USD) correlated with density patterns
                               CASE 
                                   WHEN ADDRESS_COUNT > 200 THEN 
                                       CASE WHEN UNIFORM(0,1,RANDOM()) > 0.7 THEN 85000 + (UNIFORM(1,25,RANDOM()) * 1000)::INT  -- High-income Manhattan: $86K-$110K
                                            ELSE 60000 + (UNIFORM(1,20,RANDOM()) * 1000)::INT END                               -- Mixed Manhattan: $61K-$80K
                                   WHEN ADDRESS_COUNT > 100 THEN 65000 + (UNIFORM(1,15,RANDOM()) * 1000)::INT                  -- Upper-middle areas: $66K-$80K
                                   WHEN ADDRESS_COUNT > 50 THEN 55000 + (UNIFORM(1,12,RANDOM()) * 1000)::INT                   -- Middle class: $56K-$67K
                                   ELSE 45000 + (UNIFORM(1,10,RANDOM()) * 1000)::INT                                           -- Working class: $46K-$55K
                               END AS AVG_HOUSEHOLD_INCOME
                        FROM base_addresses
                    )
                    SELECT * FROM demographics
                """
                addr_h3_df = session.sql(addr_sql).to_pandas()
            
            # Step 3b: Cover selected isochrone ring with H3
            with st.spinner(f'Covering {filter_ring.lower()} with H3 level {h3_res} using H3_COVERAGE...'):
                iso_sql = f"""
                    WITH ISO AS (
                        SELECT TO_GEOGRAPHY(( {route_functions_option}.CORE.ISOCHRONES('{profile}', {center_lon}, {center_lat}, {filter_minutes}) )['features'][0]['geometry']) AS GEO
                    )
                    SELECT H3_INT_TO_STRING(VALUE) AS H3_CELL
                    FROM ISO, TABLE(FLATTEN(H3_COVERAGE(ISO.GEO, {h3_res})))
                """
                iso_h3_df = session.sql(iso_sql).to_pandas()
            
            # Step 3c: Join and create hex layer
            if not addr_h3_df.empty and not iso_h3_df.empty:
                # Perform the join in pandas for better visibility
                hex_df = addr_h3_df.merge(iso_h3_df, on='H3_CELL', how='inner')
                hex_df = hex_df.rename(columns={'H3_CELL': 'H3'})
                
                if not hex_df.empty:
                    # Map UI selection to data column
                    metric_column_map = {
                        'Address Count': 'COUNT',
                        'Population Density': 'POPULATION_DENSITY', 
                        'Household Income': 'AVG_HOUSEHOLD_INCOME'
                    }
                    
                    color_column = metric_column_map[demographic_metric]
                    
                    # Choose color gradient based on metric type
                    if demographic_metric == 'Household Income':
                        # Green gradient for income (green = prosperity)
                        colors = ["#E8F5E8", "#A5D6A7", "#66BB6A", "#43A047", "#2E7D32"]
                    elif demographic_metric == 'Population Density':
                        # Red/Orange gradient for density (red = high density)
                        colors = ["#FFF3E0", "#FFCC80", "#FF9800", "#F57C00", "#E65100"]
                    else:
                        # Blue gradient for address count (default)
                        colors = ["#E3F2FD", "#90CAF9", "#42A5F5", "#1E88E5", "#0D47A1"]
                    
                    qs = hex_df[color_column].quantile([0, .25, .5, .75, 1])
                    hex_df["COLOR"] = colourise(
                        hex_df[color_column], colors, qs.min(), qs.max(), qs
                    )
                    # Add comprehensive demographic tooltip information for H3 hexagons
                    hex_df["TOOLTIP"] = hex_df.apply(
                        lambda row: f'<b>Demographics (H3 Cell)</b><br/><b>H3 Cell:</b> {row["H3"]}<br/><b>Address Count:</b> {row["COUNT"]:,}<br/><b>Population Density:</b> {row.get("POPULATION_DENSITY", "N/A"):,} people/km²<br/><b>Avg Household Income:</b> ${row.get("AVG_HOUSEHOLD_INCOME", "N/A"):,}<br/><b>Resolution:</b> {h3_res}<br/><b>Filter:</b> {filter_ring}',
                        axis=1
                    )
                    hex_layer = pdk.Layer(
                        "H3HexagonLayer", hex_df, id="addr_hex",
                        get_hexagon="H3", get_fill_color="COLOR", get_line_color="COLOR",
                        pickable=True, auto_highlight=True,
                        extruded=False, coverage=1, opacity=0.4,
                    )

        # Build final layer list based on user selections
        # Layer order (bottom to top): Isochrones (largest to smallest) -> H3 hexagons -> Competitors -> Selected store
        layers_to_render = []
        
        # 1. Add isochrones at the bottom (if enabled)
        if show_isochrones:
            # Reverse polygon layers so smallest rings are on top (more interactive)
            reversed_poly_layers = list(reversed(poly_layers))
            layers_to_render.extend(reversed_poly_layers)
        
        # 2. Add H3 layer above isochrones (if enabled)
        if hex_layer is not None:
            layers_to_render.append(hex_layer)
        
        # 3. Add competitor layers above H3 (if enabled)
        if show_competitors:
            layers_to_render.extend(competitor_layers)
        
        # 4. Add selected store on top (always visible)
        layers_to_render.append(center_layer)

        view_state = pdk.ViewState(
            longitude=center_lon,
            latitude=center_lat,
            zoom=11,
            pitch=0
        )

        tooltip = {
            'html': '{TOOLTIP}',
            'style': {
                'backgroundColor': '#29B5E8',
                'color': 'white',
                'fontSize': '12px',
                'padding': '8px',
                'borderRadius': '4px'
            }
        }

        st.pydeck_chart(pdk.Deck(
            layers=layers_to_render,
            map_style=None,
            initial_view_state=view_state,
            tooltip=tooltip,
            height=720,
        ))
        
        # Show density legend bar if H3 layer is enabled and has data
        if show_density and hex_layer is not None:
            st.markdown("---")
            st.markdown(f"**{demographic_metric} Scale**")
            
            # Get the min/max values for the selected metric
            if 'hex_df' in locals() and not hex_df.empty:
                metric_column_map = {
                    'Address Count': 'COUNT',
                    'Population Density': 'POPULATION_DENSITY', 
                    'Household Income': 'AVG_HOUSEHOLD_INCOME'
                }
                
                color_column = metric_column_map[demographic_metric]
                min_val = hex_df[color_column].min()
                max_val = hex_df[color_column].max()
                
                # Format values based on metric type
                if demographic_metric == 'Household Income':
                    min_formatted = f"${min_val:,.0f}"
                    max_formatted = f"${max_val:,.0f}"
                    gradient_colors = "#E8F5E8, #A5D6A7, #66BB6A, #43A047, #2E7D32"
                    scale_label = "Low Income ← → High Income"
                elif demographic_metric == 'Population Density':
                    min_formatted = f"{min_val:,.0f}"
                    max_formatted = f"{max_val:,.0f}"
                    gradient_colors = "#FFF3E0, #FFCC80, #FF9800, #F57C00, #E65100"
                    scale_label = "Low Density ← → High Density"
                else:
                    min_formatted = f"{min_val:,.0f}"
                    max_formatted = f"{max_val:,.0f}"
                    gradient_colors = "#E3F2FD, #90CAF9, #42A5F5, #1E88E5, #0D47A1"
                    scale_label = "Low Address Count ← → High Address Count"
                
                # Create gradient bar HTML (full width)
                gradient_html = f"""
                <div style="margin: 10px 0; width: 100%;">
                    <div style="display: flex; align-items: center; margin-bottom: 5px; width: 100%;">
                        <span style="font-size: 0.8rem; color: #666; margin-right: 10px; min-width: 70px; flex-shrink: 0;">{min_formatted}</span>
                        <div style="
                            height: 25px; 
                            flex: 1;
                            background: linear-gradient(to right, {gradient_colors});
                            border: 1px solid #ddd;
                            border-radius: 4px;
                            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                        "></div>
                        <span style="font-size: 0.8rem; color: #666; margin-left: 10px; min-width: 70px; flex-shrink: 0; text-align: right;">{max_formatted}</span>
                    </div>
                    <div style="text-align: center; font-size: 0.8rem; color: #666; font-weight: 500; margin-top: 8px;">
                        {scale_label}
                    </div>
                </div>
                """
                st.markdown(gradient_html, unsafe_allow_html=True)
        
        # ─────────────────────────────  CATCHMENT ZONE STATISTICS  ──────────────────
        st.markdown("---")
        st.markdown('<h1sub>📊 Catchment Zone Statistics</h1sub>', unsafe_allow_html=True)
        
        with st.spinner('Calculating zone-level statistics...'):
            # Helper function to safely convert values to int
            def safe_int(value, default=0):
                if pd.isna(value) or value is None:
                    return default
                try:
                    return int(float(value))
                except (ValueError, TypeError):
                    return default
            
            # Calculate statistics for each catchment zone
            zone_stats = []
            
            # Get ring minutes for analysis
            ring_minutes = sorted(minutes_breakpoints(max_minutes, num_rings))
            
            for i, minutes in enumerate(ring_minutes, 1):
                with st.spinner(f'Analyzing Zone {i} (≤{minutes} min)...'):
                    # Get addresses and demographics for this specific zone
                    zone_sql = f"""
                        WITH zone_isochrone AS (
                            SELECT TO_GEOGRAPHY(( {route_functions_option}.CORE.ISOCHRONES('{profile}', {center_lon}, {center_lat}, {minutes}) )['features'][0]['geometry']) AS GEO
                        ),
                        zone_addresses AS (
                            SELECT H3_POINT_TO_CELL_STRING(a.GEOMETRY, {h3_res}) AS H3_CELL,
                                   COUNT(*) AS ADDRESS_COUNT
                            FROM FLEET_INTELLIGENCE.PUBLIC.NEW_YORK_ADDRESSES a
                            CROSS JOIN zone_isochrone zi
                            WHERE ST_WITHIN(a.geometry, zi.GEO)
                            GROUP BY 1
                        ),
                        zone_demographics AS (
                            SELECT H3_CELL,
                                   ADDRESS_COUNT,
                                   -- Generate realistic population density (people per sq km) based on NYC patterns
                                   -- Manhattan: 25,000-35,000 people/km², Brooklyn: 15,000-25,000, Queens: 8,000-15,000
                                   CASE 
                                       WHEN ADDRESS_COUNT > 500 THEN 25000 + (UNIFORM(1,10,RANDOM()) * 1000)::INT  -- Dense Manhattan: 26K-35K
                                       WHEN ADDRESS_COUNT > 300 THEN 20000 + (UNIFORM(1,8,RANDOM()) * 1000)::INT   -- Mid Manhattan/Dense Brooklyn: 21K-28K  
                                       WHEN ADDRESS_COUNT > 150 THEN 15000 + (UNIFORM(1,6,RANDOM()) * 1000)::INT   -- Brooklyn/Dense Queens: 16K-21K
                                       WHEN ADDRESS_COUNT > 75 THEN 8000 + (UNIFORM(1,5,RANDOM()) * 1000)::INT     -- Queens/Outer areas: 9K-13K
                                       WHEN ADDRESS_COUNT > 25 THEN 4000 + (UNIFORM(1,3,RANDOM()) * 1000)::INT     -- Suburban: 5K-7K
                                       ELSE 2000 + (UNIFORM(1,2,RANDOM()) * 1000)::INT                             -- Low density: 3K-4K
                                   END AS POPULATION_DENSITY,
                                   -- Generate realistic household income (USD) correlated with density patterns
                                   CASE 
                                       WHEN ADDRESS_COUNT > 500 THEN 
                                           CASE WHEN UNIFORM(0,1,RANDOM()) > 0.6 THEN 85000 + (UNIFORM(1,25,RANDOM()) * 1000)::INT  -- High-income Manhattan: $86K-$110K
                                                ELSE 60000 + (UNIFORM(1,20,RANDOM()) * 1000)::INT END                               -- Mixed Manhattan: $61K-$80K
                                       WHEN ADDRESS_COUNT > 300 THEN 65000 + (UNIFORM(1,15,RANDOM()) * 1000)::INT                  -- Upper-middle areas: $66K-$80K
                                       WHEN ADDRESS_COUNT > 150 THEN 55000 + (UNIFORM(1,12,RANDOM()) * 1000)::INT                  -- Middle class Brooklyn: $56K-$67K
                                       WHEN ADDRESS_COUNT > 75 THEN 45000 + (UNIFORM(1,10,RANDOM()) * 1000)::INT                   -- Working class: $46K-$55K
                                       WHEN ADDRESS_COUNT > 25 THEN 40000 + (UNIFORM(1,8,RANDOM()) * 1000)::INT                    -- Lower-middle class: $41K-$48K
                                       ELSE 35000 + (UNIFORM(1,6,RANDOM()) * 1000)::INT                                            -- Lower income: $36K-$41K
                                   END AS AVG_HOUSEHOLD_INCOME
                            FROM zone_addresses
                        ),
                        zone_competitors AS (
                            SELECT COALESCE(COUNT(*), 0) as competitor_count,
                                   COALESCE(SUM(s.daily_footfall), 0) as total_competitor_footfall,
                                   COALESCE(COUNT(DISTINCT s.retailer), 0) as unique_retailers
                            FROM FLEET_INTELLIGENCE.PUBLIC.NYC_RETAIL_STORES s
                            CROSS JOIN zone_isochrone zi
                            WHERE ST_WITHIN(s.location, zi.GEO)
                            AND NOT (s.latitude = {center_lat} AND s.longitude = {center_lon})
                        )
                        SELECT 
                            {i} as zone_number,
                            {minutes} as max_travel_time,
                            COALESCE(COUNT(zd.H3_CELL), 0) as h3_cells,
                            COALESCE(SUM(zd.ADDRESS_COUNT), 0) as total_addresses,
                            COALESCE(ROUND(AVG(zd.POPULATION_DENSITY), 0), 0) as avg_population_density,
                            COALESCE(ROUND(AVG(zd.AVG_HOUSEHOLD_INCOME), 0), 0) as avg_household_income,
                            COALESCE(MAX(zc.competitor_count), 0) as competitor_stores,
                            COALESCE(MAX(zc.total_competitor_footfall), 0) as competitor_footfall,
                            COALESCE(MAX(zc.unique_retailers), 0) as unique_retailers
                        FROM zone_demographics zd
                        CROSS JOIN zone_competitors zc
                        GROUP BY zone_number, max_travel_time
                    """
                    
                    zone_result = session.sql(zone_sql).to_pandas()
                    if not zone_result.empty:
                        zone_stats.append(zone_result.iloc[0])
            
            if zone_stats:
                # Create a comprehensive statistics table
                stats_df = pd.DataFrame(zone_stats)
                
                # Display zone statistics
                st.markdown("### Zone Summary")
                
                # Create formatted table
                for _, row in stats_df.iterrows():
                    col1, col2, col3, col4 = st.columns(4)
                    
                    with col1:
                        st.metric(
                            f"🎯 Zone {safe_int(row['ZONE_NUMBER'])}",
                            f"≤ {safe_int(row['MAX_TRAVEL_TIME'])} min",
                            help=f"{mode_label} travel time"
                        )
                    
                    with col2:
                        st.metric(
                            "📍 Total Addresses",
                            f"{safe_int(row['TOTAL_ADDRESSES']):,}",
                            help="Addresses within this zone"
                        )
                    
                    with col3:
                        st.metric(
                            "👥 Avg Pop. Density",
                            f"{safe_int(row['AVG_POPULATION_DENSITY']):,} /km²",
                            help="Average population density"
                        )
                    
                    with col4:
                        st.metric(
                            "💰 Avg Income",
                            f"${safe_int(row['AVG_HOUSEHOLD_INCOME']):,}",
                            help="Average household income"
                        )
                    
                    # Second row for competition metrics
                    col5, col6, col7, col8 = st.columns(4)
                    
                    with col5:
                        st.metric(
                            "🏪 Competitor Stores",
                            f"{safe_int(row['COMPETITOR_STORES'])}",
                            help="Number of competing stores"
                        )
                    
                    with col6:
                        st.metric(
                            "📊 Competitor Traffic",
                            f"{safe_int(row['COMPETITOR_FOOTFALL']):,}",
                            help="Daily competitor footfall"
                        )
                    
                    with col7:
                        st.metric(
                            "🏷️ Unique Retailers",
                            f"{safe_int(row['UNIQUE_RETAILERS'])}",
                            help="Different retail brands"
                        )
                    
                    with col8:
                        # Calculate market penetration
                        zone_addresses = safe_int(row['TOTAL_ADDRESSES'])
                        market_penetration = (selected_footfall / (zone_addresses / 100)) if zone_addresses > 0 else 0
                        st.metric(
                            "📈 Market Penetration",
                            f"{market_penetration:.2f}%",
                            help="Your store's penetration rate"
                        )
                    
                    st.markdown("---")

        # ─────────────────────────────  AI ANALYSIS  ────────────────────────────────
        st.markdown('<h1sub>🤖 AI-Powered Market Analysis</h1sub>', unsafe_allow_html=True)
        
        with st.spinner('Generating comprehensive market analysis...'):
            # Get AI analysis using the enhanced function
            ai_analysis = get_ai_analysis_snowpark(
                selected_store, selected_retailer, center_lat, center_lon,
                all_stores_df if 'all_stores_df' in locals() else pd.DataFrame(),
                hex_df if 'hex_df' in locals() else pd.DataFrame(),
                ring_minutes, max_minutes, profile, demographic_metric
            )
            
            # Display the analysis
            with st.container(height=600):
                st.markdown(ai_analysis, unsafe_allow_html=True)
        
        # ─────────────────────────────  RECOMMENDED LOCATION MAP  ───────────────────
        st.markdown("---")
        st.markdown('<h1sub>🎯 AI-Generated Recommended Store Location</h1sub>', unsafe_allow_html=True)
        
        # Extract recommended coordinates from AI response
        import re
        recommended_coords = None
        coord_pattern = r'RECOMMENDED_LOCATION:\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)'
        match = re.search(coord_pattern, ai_analysis)
        
        if match:
            recommended_lat = float(match.group(1))
            recommended_lon = float(match.group(2))
            recommended_coords = (recommended_lat, recommended_lon)
            
            st.success(f"📍 **Recommended Location**: {recommended_lat:.4f}, {recommended_lon:.4f}")
            
            # Create a clean map with competitors and recommended location
            with st.spinner('Building recommendation map...'):
                # Prepare competitor data for the map
                if 'all_stores_df' in locals() and not all_stores_df.empty:
                    competitors_map_df = all_stores_df.copy()
                    # Add tooltip for competitors
                    competitors_map_df['TOOLTIP'] = competitors_map_df.apply(lambda row: 
                        f"<b>{row['RETAILER']}</b><br/>"
                        f"📍 {row['STORE_NAME']}<br/>"
                        f"🚶 Daily Footfall: {row['DAILY_FOOTFALL']:,}<br/>"
                        f"📍 {row['ADDRESS']}", axis=1
                    )
                    
                    # Create recommended location data
                    recommended_df = pd.DataFrame([{
                        'LATITUDE': recommended_lat,
                        'LONGITUDE': recommended_lon,
                        'TOOLTIP': f"<b>🌟 RECOMMENDED NEW STORE</b><br/>"
                                  f"📍 Location: {recommended_lat:.4f}, {recommended_lon:.4f}<br/>"
                                  f"🏷️ Retailer: {selected_retailer}<br/>"
                                  f"✨ AI-Recommended Optimal Location"
                    }])
                    
                    # Create PyDeck layers for recommendation map
                    recommendation_layers = []
                    
                    # Competitor stores layer
                    competitor_layer = pdk.Layer(
                        'ScatterplotLayer',
                        data=competitors_map_df,
                        get_position='[LONGITUDE, LATITUDE]',
                        get_color='[70, 130, 180, 200]',  # Steel blue for competitors
                        get_radius=300,
                        pickable=True,
                        auto_highlight=True
                    )
                    recommendation_layers.append(competitor_layer)
                    
                    # Recommended location layer (larger and distinct)
                    recommended_layer = pdk.Layer(
                        'ScatterplotLayer',
                        data=recommended_df,
                        get_position='[LONGITUDE, LATITUDE]',
                        get_color='[255, 215, 0, 255]',  # Gold for recommendation
                        get_radius=500,
                        pickable=True,
                        auto_highlight=True
                    )
                    recommendation_layers.append(recommended_layer)
                    
                    # Create the recommendation map
                    recommendation_view_state = pdk.ViewState(
                        latitude=recommended_lat,
                        longitude=recommended_lon,
                        zoom=12,
                        pitch=0,
                        bearing=0
                    )
                    
                    recommendation_deck = pdk.Deck(
                        layers=recommendation_layers,
                        initial_view_state=recommendation_view_state,
                        tooltip={'html': '{TOOLTIP}', 'style': {'backgroundColor': 'steelblue', 'color': 'white'}},
                        height=500
                    )
                    
                    # Display the recommendation map
                    st.pydeck_chart(recommendation_deck, use_container_width=True)
                    
                    # Add legend for recommendation map
                    st.markdown("""
                    <div style="display: flex; justify-content: center; margin-top: 10px;">
                        <div style="background: white; padding: 10px; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                            <div style="display: flex; align-items: center; gap: 15px;">
                                <div style="display: flex; align-items: center; gap: 5px;">
                                    <div style="width: 12px; height: 12px; background: rgb(70, 130, 180); border-radius: 50%;"></div>
                                    <span style="font-size: 12px;">Competitor Stores</span>
                                </div>
                                <div style="display: flex; align-items: center; gap: 5px;">
                                    <div style="width: 12px; height: 12px; background: rgb(255, 215, 0); border-radius: 50%;"></div>
                                    <span style="font-size: 12px;">🌟 AI Recommended Location</span>
                                </div>
                            </div>
                        </div>
                    </div>
                    """, unsafe_allow_html=True)
                    
                else:
                    st.warning("No competitor data available for recommendation map.")
        else:
            st.warning("⚠️ Unable to extract recommended coordinates from AI analysis. Please check the analysis text above for location recommendations.")
    else:
        st.info('Set parameters in the sidebar, then press "Analyze Customer Reach".')


with col_right:
    st.markdown('<h1sub>Legend</h1sub>', unsafe_allow_html=True)
    
    # Store legend
    if build and show_competitors:
        st.markdown("**Store Locations:**")
        
        # Retailer colors for legend
        retailer_colors = {
            "Target": [220, 53, 69],        # Target red
            "Best Buy": [255, 193, 7],      # Best Buy yellow
            "CVS": [156, 39, 176],          # CVS purple
            "Walgreens": [40, 167, 69],     # Walgreens green
            "Home Depot": [255, 87, 34],    # Home Depot orange
            "Staples": [33, 150, 243]       # Staples blue
        }
        
        store_legend_rows = []
        store_legend_rows.append(
            f"""
            <div style='display:flex;align-items:center;margin:4px 0;'>
              <span style='display:inline-block;width:12px;height:12px;background-color: rgb(255,0,0);border-radius:50%;margin-right:6px;border:1px solid rgba(0,0,0,0.15);'></span>
              <span style='font-size:0.85rem;color:#1f2937;'>Selected Store</span>
            </div>
            """
        )
        
        for retailer, color in retailer_colors.items():
            r, g, b = color
            store_legend_rows.append(
                f"""
                <div style='display:flex;align-items:center;margin:4px 0;'>
                  <span style='display:inline-block;width:12px;height:12px;background-color: rgb({r},{g},{b});border-radius:50%;margin-right:6px;border:1px solid rgba(0,0,0,0.15);'></span>
                  <span style='font-size:0.85rem;color:#1f2937;'>{retailer}</span>
                </div>
                """
            )
        
        store_html = f"""
        <div style='padding:4px 2px; margin-bottom:10px;'>
        {"".join(store_legend_rows)}
        </div>
        """
        components.html(store_html, height=min(200, 30 * len(store_legend_rows)))
    
    # Isochrone legend
    if build and show_isochrones:
        mins = sorted(minutes_breakpoints(max_minutes, num_rings))
        palette = get_palette(len(mins))

        rows = []
        for m, (r, g, b) in zip(mins, palette):
            rows.append(
                f"""
                <div style='display:flex;align-items:center;margin:6px 0;'>
                  <span style='display:inline-block;width:14px;height:14px;background-color: rgb({r},{g},{b});border-radius:3px;margin-right:8px;border:1px solid rgba(0,0,0,0.15);'></span>
                  <span style='font-size:0.95rem;color:#1f2937;'>≤ {m} min</span>
                </div>
                """
            )
        html = """
        <div style='padding:4px 2px;'>
        {rows}
        </div>
        """.format(rows="\n".join(rows))
        components.html(html, height=min(300, 36 * len(rows) + 20))
    else:
        st.caption('Legend appears after analyzing customer reach')
