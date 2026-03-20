# SwiftBite Food Delivery - Travel Time Matrix Visualization
# Explore pre-computed travel times between H3 hexagons across California

import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
from snowflake.snowpark.context import get_active_session
from city_config import get_city, get_company, get_california_cities

COMPANY = get_company()

st.set_page_config(layout="wide", page_title=f"{COMPANY['name']} - Travel Time Matrix")

with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

st.logo('logo.svg')

session = get_active_session()

with st.sidebar:
    selected_city = st.selectbox("City", get_california_cities(), index=0)

CITY = get_city(selected_city)

st.markdown(f'''
<h0orange>{COMPANY["name"]}</h0orange><h0black> |</h0black><h0blue> Travel Time Matrix</h0blue><BR>
<h1grey>Pre-computed ORS driving times across {CITY["name"]} (H3 Resolution 9)</h1grey>
''', unsafe_allow_html=True)

if CITY["name"] != "San Francisco":
    st.warning(f"The pre-computed travel time matrix is currently only available for San Francisco. Select San Francisco from the city dropdown to explore the matrix data.")
    st.info("To build a matrix for other cities, use the ORS MATRIX function to compute travel times between H3 hexagons.")
    st.stop()


st.divider()

MATRIX_TABLE = 'OPENROUTESERVICE_SETUP.ROUTING.SF_TRAVEL_TIME_MATRIX'
HEXAGONS_TABLE = 'OPENROUTESERVICE_SETUP.ROUTING.SF_HEXAGONS'

@st.cache_data(ttl=600)
def get_matrix_stats():
    try:
        stats = session.sql(f"""
            SELECT 
                COUNT(*) AS total_pairs,
                COUNT(DISTINCT origin_hex_id) AS unique_origins,
                ROUND(AVG(travel_time_seconds) / 60.0, 1) AS avg_minutes,
                ROUND(MAX(travel_time_seconds) / 60.0, 1) AS max_minutes,
                ROUND(AVG(distance_meters) / 1000.0, 2) AS avg_km,
                ROUND(MAX(distance_meters) / 1000.0, 2) AS max_km
            FROM {MATRIX_TABLE}
            WHERE origin_hex_id != destination_hex_id
        """).to_pandas()
        row = stats.iloc[0].to_dict()
        return {k.lower(): v for k, v in row.items()}
    except Exception as e:
        return None

@st.cache_data(ttl=600)
def get_hexagons():
    try:
        df = session.sql(f"""
            SELECT 
                hex_id,
                longitude,
                latitude,
                address_count,
                ST_ASGEOJSON(boundary) AS boundary_geojson
            FROM {HEXAGONS_TABLE}
            ORDER BY address_count DESC
        """).to_pandas()
        df.columns = [c.lower() for c in df.columns]
        return df
    except Exception as e:
        st.error(f"Error loading hexagons: {e}")
        return pd.DataFrame()

stats = get_matrix_stats()

if stats:
    st.markdown('<h1sub>Matrix Overview</h1sub>', unsafe_allow_html=True)
    
    col1, col2, col3, col4, col5, col6 = st.columns(6)
    with col1:
        st.metric("Total OD Pairs", f"{stats['total_pairs']:,.0f}")
    with col2:
        st.metric("Hexagons", f"{stats['unique_origins']:,.0f}")
    with col3:
        st.metric("Avg Travel Time", f"{stats['avg_minutes']:.1f} min")
    with col4:
        st.metric("Max Travel Time", f"{stats['max_minutes']:.1f} min")
    with col5:
        st.metric("Avg Distance", f"{stats['avg_km']:.1f} km")
    with col6:
        st.metric("Max Distance", f"{stats['max_km']:.1f} km")
    
    st.divider()
else:
    st.warning("Travel time matrix not found. Please ensure the matrix has been computed.")
    st.info("""
    To build the travel time matrix, run:
    ```sql
    -- See OPENROUTESERVICE_SETUP.ROUTING schema for matrix tables
    SELECT * FROM OPENROUTESERVICE_SETUP.ROUTING.SF_HEXAGONS LIMIT 10;
    ```
    """)
    st.stop()

hexagons_df = get_hexagons()

if len(hexagons_df) == 0:
    st.error("No hexagon data available")
    st.stop()

st.markdown('<h1sub>Select Origin Location</h1sub>', unsafe_allow_html=True)

col1, col2 = st.columns([0.6, 0.4])

with col2:
    st.markdown("**Top Hexagons by Address Count:**")
    top_hexagons = hexagons_df.head(20)[['hex_id', 'address_count', 'longitude', 'latitude']].copy()
    top_hexagons['label'] = top_hexagons.apply(
        lambda r: f"{r['hex_id'][:12]}... ({int(r['address_count']):,} addresses)", axis=1
    )
    
    selected_label = st.selectbox(
        "Choose an origin hexagon:",
        top_hexagons['label'].tolist(),
        help="Select a hexagon to see travel times to all other hexagons"
    )
    
    selected_hex = top_hexagons[top_hexagons['label'] == selected_label]['hex_id'].iloc[0]
    
    st.markdown(f"**Selected:** `{selected_hex}`")
    
    max_travel_time = st.slider(
        "Max travel time to display (minutes):",
        min_value=5,
        max_value=40,
        value=20,
        step=5
    )

@st.cache_data(ttl=300)
def get_travel_times_from_origin(origin_hex, max_minutes):
    df = session.sql(f"""
        SELECT 
            m.destination_hex_id AS hex_id,
            m.travel_time_seconds / 60.0 AS travel_minutes,
            m.distance_meters / 1000.0 AS distance_km,
            h.longitude,
            h.latitude,
            h.address_count
        FROM {MATRIX_TABLE} m
        JOIN {HEXAGONS_TABLE} h ON m.destination_hex_id = h.hex_id
        WHERE m.origin_hex_id = '{origin_hex}'
          AND m.travel_time_seconds <= {max_minutes * 60}
        ORDER BY m.travel_time_seconds
    """).to_pandas()
    df.columns = [c.lower() for c in df.columns]
    return df

travel_times = get_travel_times_from_origin(selected_hex, max_travel_time)

with col1:
    if len(travel_times) > 0:
        origin_data = hexagons_df[hexagons_df['hex_id'] == selected_hex].iloc[0]
        
        travel_times['color_r'] = (travel_times['travel_minutes'] / max_travel_time * 255).clip(0, 255).astype(int)
        travel_times['color_g'] = ((1 - travel_times['travel_minutes'] / max_travel_time) * 200).clip(0, 200).astype(int)
        travel_times['color_b'] = 100
        travel_times['color_a'] = 180
        
        hex_layer = pdk.Layer(
            'H3HexagonLayer',
            data=travel_times,
            get_hexagon='hex_id',
            get_fill_color=['color_r', 'color_g', 'color_b', 'color_a'],
            get_line_color=[255, 255, 255, 100],
            line_width_min_pixels=1,
            extruded=False,
            pickable=True,
            auto_highlight=True
        )
        
        origin_layer = pdk.Layer(
            'H3HexagonLayer',
            data=[{'hex_id': selected_hex}],
            get_hexagon='hex_id',
            get_fill_color=[255, 107, 53, 255],
            get_line_color=[255, 255, 255, 200],
            line_width_min_pixels=2,
            extruded=False,
            pickable=True
        )
        
        view_state = pdk.ViewState(
            latitude=origin_data['latitude'],
            longitude=origin_data['longitude'],
            zoom=12,
            pitch=0
        )
        
        tooltip = {
            "html": "<b>Travel Time:</b> {travel_minutes:.1f} min<br/><b>Distance:</b> {distance_km:.1f} km<br/><b>Addresses:</b> {address_count}",
            "style": {"backgroundColor": "#24323D", "color": "white"}
        }
        
        deck = pdk.Deck(
            map_provider="carto",
            map_style="light",
            initial_view_state=view_state,
            layers=[hex_layer, origin_layer],
            tooltip=tooltip
        )
        
        st.pydeck_chart(deck, use_container_width=True, height=500)
    else:
        st.warning("No destinations found within the selected travel time range")

st.divider()

st.markdown('<h1sub>Travel Time Distribution</h1sub>', unsafe_allow_html=True)

if len(travel_times) > 0:
    col1, col2 = st.columns(2)
    
    with col1:
        bins = [0, 5, 10, 15, 20, 25, 30, 35, 40]
        travel_times['time_bucket'] = pd.cut(
            travel_times['travel_minutes'], 
            bins=bins, 
            labels=['0-5', '5-10', '10-15', '15-20', '20-25', '25-30', '30-35', '35-40']
        )
        bucket_counts = travel_times['time_bucket'].value_counts().sort_index().reset_index()
        bucket_counts.columns = ['Time Range (min)', 'Destinations']
        
        chart = alt.Chart(bucket_counts).mark_bar().encode(
            x=alt.X('Time Range (min):N', sort=None, title='Travel Time (minutes)'),
            y=alt.Y('Destinations:Q', title='Number of Destinations'),
            color=alt.value('#FF6B35'),
            tooltip=['Time Range (min)', 'Destinations']
        ).properties(
            title=f'Reachable Destinations from Selected Origin',
            height=300
        )
        st.altair_chart(chart, use_container_width=True)
    
    with col2:
        st.markdown("**Nearest Destinations:**")
        nearest = travel_times.nsmallest(10, 'travel_minutes')[['hex_id', 'travel_minutes', 'distance_km', 'address_count']]
        nearest.columns = ['Hexagon ID', 'Time (min)', 'Distance (km)', 'Addresses']
        nearest['Hexagon ID'] = nearest['Hexagon ID'].str[:15] + '...'
        st.dataframe(nearest, use_container_width=True, hide_index=True)
        
        st.markdown("**Farthest Destinations (within range):**")
        farthest = travel_times.nlargest(10, 'travel_minutes')[['hex_id', 'travel_minutes', 'distance_km', 'address_count']]
        farthest.columns = ['Hexagon ID', 'Time (min)', 'Distance (km)', 'Addresses']
        farthest['Hexagon ID'] = farthest['Hexagon ID'].str[:15] + '...'
        st.dataframe(farthest, use_container_width=True, hide_index=True)

st.divider()

st.markdown('<h1sub>Delivery Coverage Analysis</h1sub>', unsafe_allow_html=True)

col1, col2, col3 = st.columns(3)

with col1:
    delivery_radius = st.selectbox(
        "Delivery time guarantee:",
        [10, 15, 20, 25, 30],
        index=2,
        format_func=lambda x: f"{x} minutes"
    )

coverage_data = get_travel_times_from_origin(selected_hex, delivery_radius)

with col2:
    st.metric(
        "Hexagons Reachable",
        f"{len(coverage_data):,}",
        delta=f"{len(coverage_data)/len(hexagons_df)*100:.1f}% of SF"
    )

with col3:
    total_addresses = coverage_data['address_count'].sum() if len(coverage_data) > 0 else 0
    st.metric(
        "Addresses Covered",
        f"{total_addresses:,}",
        delta=f"within {delivery_radius} min"
    )

st.divider()

with st.expander("How This Matrix Was Built"):
    st.markdown(f"""
    ### Travel Time Matrix Construction
    
    This matrix was pre-computed using the **OpenRouteService MATRIX function** running in Snowflake via SPCS:
    
    1. **H3 Hexagons** (Resolution 9): Generated from Overture Maps address data for {CITY['name']}
    2. **Matrix Calculation**: Used `OPENROUTESERVICE_NATIVE_APP.CORE.MATRIX_TABULAR()` to compute driving times
    3. **Result**: {stats['total_pairs']:,.0f} origin-destination pairs covering {stats['unique_origins']:,.0f} hexagons
    
    ### Performance Benefits
    
    | Approach | Time for 1M lookups |
    |----------|-------------------|
    | Individual DIRECTIONS calls | ~2.8 hours |
    | Pre-computed matrix lookups | ~1 second |
    
    ### SQL to Query the Matrix
    
    ```sql
    -- Find travel time between two hexagons
    SELECT travel_time_seconds / 60.0 AS minutes
    FROM OPENROUTESERVICE_SETUP.ROUTING.SF_TRAVEL_TIME_MATRIX
    WHERE origin_hex_id = '8928308286fffff'
      AND destination_hex_id = '89283082bd7ffff';
    
    -- Find all destinations within 15 minutes
    SELECT destination_hex_id, travel_time_seconds / 60.0 AS minutes
    FROM OPENROUTESERVICE_SETUP.ROUTING.SF_TRAVEL_TIME_MATRIX
    WHERE origin_hex_id = '8928308286fffff'
      AND travel_time_seconds <= 900
    ORDER BY travel_time_seconds;
    ```
    """)

st.markdown(f'''
<h1grey>Powered by Snowflake, OpenRouteService & H3</h1grey>
''', unsafe_allow_html=True)
