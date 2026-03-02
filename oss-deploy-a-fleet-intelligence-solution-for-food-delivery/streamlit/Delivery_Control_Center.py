# SwiftBite Food Delivery - Fleet Intelligence Control Center
# Main entry point for multi-page Streamlit app

import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import json
from snowflake.snowpark.context import get_active_session
import snowflake.snowpark.functions as F
from city_config import get_city, get_company, get_california_cities, driver_color

COMPANY = get_company()

st.set_page_config(
    page_title=f"{COMPANY['name']} - Fleet Control Center",
    layout="wide",
    initial_sidebar_state="expanded"
)

with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

st.logo('logo.svg')

session = get_active_session()

with st.sidebar:
    selected_city = st.selectbox("City", get_california_cities(), index=0)

CITY = get_city(selected_city)

st.markdown(f'''
<h0orange>{COMPANY["name"]}</h0orange><h0black> |</h0black><h0blue> California Fleet Intelligence</h0blue><BR>
<h1grey>{COMPANY["tagline"]} - {CITY["name"]} Operations</h1grey>
''', unsafe_allow_html=True)

st.divider()

st.markdown('<h1sub>Delivery Fleet Overview</h1sub>', unsafe_allow_html=True)

col1, col2, col3, col4, col5 = st.columns(5)

try:
    orders_count = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS').count()
    couriers_count = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS').select('COURIER_ID').distinct().count()
    restaurants_count = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS').select('RESTAURANT_ID').distinct().count()
    
    total_distance = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY').agg(
        F.sum('ROUTE_DISTANCE_METERS').alias('TOTAL_DISTANCE')
    ).collect()[0]['TOTAL_DISTANCE']
    
    avg_delivery_time = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY').agg(
        F.avg('ROUTE_DURATION_SECS').alias('AVG_DURATION')
    ).collect()[0]['AVG_DURATION']
    
    with col1:
        st.metric("Active Orders", f"{orders_count:,}")
    with col2:
        st.metric("Active Couriers", f"{couriers_count:,}")
    with col3:
        st.metric("Partner Restaurants", f"{restaurants_count:,}")
    with col4:
        st.metric("Total Distance", f"{total_distance/1000:,.0f} km")
    with col5:
        st.metric("Avg Delivery Time", f"{avg_delivery_time/60:.0f} min")
except Exception as e:
    st.warning("Connect to Snowflake and ensure the Fleet Intelligence data is loaded.")
    st.error(f"Error: {e}")

st.divider()

st.markdown('<h1sub>Live Delivery Routes</h1sub>', unsafe_allow_html=True)

try:
    routes_df = session.sql("""
        SELECT 
            COURIER_ID,
            ORDER_ID,
            RESTAURANT_NAME,
            CUSTOMER_ADDRESS,
            ST_ASGEOJSON(GEOMETRY) AS GEOMETRY_JSON,
            ROUTE_DISTANCE_METERS/1000 AS DISTANCE_KM,
            ROUTE_DURATION_SECS/60 AS ETA_MINS,
            ORDER_STATUS
        FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY
        LIMIT 100
    """).to_pandas()
    
    routes_df["coordinates"] = routes_df["GEOMETRY_JSON"].apply(
        lambda row: json.loads(row)["coordinates"] if row else []
    )
    
    routes_df['color'] = routes_df['COURIER_ID'].apply(
        lambda x: driver_color(x)
    )
    
    path_layer = pdk.Layer(
        type="PathLayer",
        data=routes_df,
        pickable=True,
        get_color='color',
        width_scale=20,
        width_min_pixels=2,
        width_max_pixels=5,
        get_path="coordinates",
        get_width=3
    )
    
    view_state = pdk.ViewState(
        latitude=CITY["latitude"],
        longitude=CITY["longitude"],
        zoom=CITY["zoom"] - 0.5,
        pitch=0
    )
    
    tooltip = {
        "html": "<b>Courier:</b> {COURIER_ID}<br/><b>From:</b> {RESTAURANT_NAME}<br/><b>To:</b> {CUSTOMER_ADDRESS}<br/><b>ETA:</b> {ETA_MINS:.0f} min<br/><b>Status:</b> {ORDER_STATUS}",
        "style": {
            "backgroundColor": "#24323D",
            "color": "white"
        }
    }
    
    deck = pdk.Deck(
        map_provider="carto",
        map_style="light",
        initial_view_state=view_state,
        layers=[path_layer],
        tooltip=tooltip,
        height=500
    )
    
    st.pydeck_chart(deck, use_container_width=True)
    
except Exception as e:
    st.error(f"Error loading map: {e}")

st.divider()

st.markdown('<h1sub>Courier Performance Dashboard</h1sub>', unsafe_allow_html=True)

try:
    courier_stats = session.sql("""
        SELECT 
            COURIER_ID,
            COUNT(*) AS DELIVERIES,
            ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 1) AS TOTAL_KM,
            ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DELIVERY_MINS,
            ROUND(SUM(ROUTE_DURATION_SECS)/3600, 1) AS TOTAL_HOURS
        FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY
        GROUP BY COURIER_ID
        ORDER BY DELIVERIES DESC
    """).to_pandas()
    
    col1, col2 = st.columns(2)
    
    with col1:
        chart_deliveries = alt.Chart(courier_stats).mark_bar().encode(
            x=alt.X('DELIVERIES:Q', title='Deliveries Completed'),
            y=alt.Y('COURIER_ID:N', sort='-x', title='Courier'),
            color=alt.value('#FF6B35'),
            tooltip=['COURIER_ID', 'DELIVERIES', 'TOTAL_KM', 'AVG_DELIVERY_MINS']
        ).properties(
            title='Deliveries by Courier',
            height=400
        )
        st.altair_chart(chart_deliveries, use_container_width=True)
    
    with col2:
        chart_distance = alt.Chart(courier_stats).mark_bar().encode(
            x=alt.X('TOTAL_KM:Q', title='Total Distance (km)'),
            y=alt.Y('COURIER_ID:N', sort='-x', title='Courier'),
            color=alt.value('#29B5E8'),
            tooltip=['COURIER_ID', 'DELIVERIES', 'TOTAL_KM', 'AVG_DELIVERY_MINS']
        ).properties(
            title='Distance Covered by Courier',
            height=400
        )
        st.altair_chart(chart_distance, use_container_width=True)

except Exception as e:
    st.error(f"Error loading courier stats: {e}")

st.divider()

st.markdown('<h1sub>Peak Delivery Hours</h1sub>', unsafe_allow_html=True)

try:
    hourly_stats = session.sql("""
        SELECT 
            HOUR(ORDER_TIME) AS HOUR,
            COUNT(*) AS ORDERS,
            ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 0) AS TOTAL_KM,
            ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DELIVERY_MINS
        FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY
        GROUP BY HOUR(ORDER_TIME)
        ORDER BY HOUR
    """).to_pandas()
    
    col1, col2 = st.columns(2)
    
    with col1:
        chart_hourly = alt.Chart(hourly_stats).mark_bar().encode(
            x=alt.X('HOUR:O', title='Hour of Day', axis=alt.Axis(values=list(range(24)))),
            y=alt.Y('ORDERS:Q', title='Number of Orders'),
            color=alt.Color('ORDERS:Q', scale=alt.Scale(scheme='oranges'), legend=None),
            tooltip=['HOUR', 'ORDERS', 'AVG_DELIVERY_MINS']
        ).properties(
            title='Orders per Hour',
            height=250
        )
        st.altair_chart(chart_hourly, use_container_width=True)
    
    with col2:
        chart_eta = alt.Chart(hourly_stats).mark_line(point=True).encode(
            x=alt.X('HOUR:O', title='Hour of Day', axis=alt.Axis(values=list(range(24)))),
            y=alt.Y('AVG_DELIVERY_MINS:Q', title='Avg Delivery Time (min)'),
            color=alt.value('#E63946'),
            tooltip=['HOUR', 'ORDERS', 'AVG_DELIVERY_MINS']
        ).properties(
            title='Average Delivery Time by Hour',
            height=250
        )
        st.altair_chart(chart_eta, use_container_width=True)

except Exception as e:
    st.error(f"Error loading hourly stats: {e}")

st.divider()

st.markdown(f'''
### Navigate {COMPANY["name"]} Control Center

Use the sidebar to access different views:

- **Courier Routes** - Track individual courier deliveries with route visualization and AI insights
- **Delivery Heat Map** - View delivery density and restaurant hotspots across the city

### Data Sources

- **Overture Maps Places** - Restaurant locations and customer addresses
- **Overture Maps Addresses** - Accurate delivery addresses
- **OpenRouteService** - Real-time routing for optimal delivery paths

### Key Metrics

- **On-time delivery rate** tracking with real-time alerts
- **Courier efficiency** metrics including deliveries per hour
- **Restaurant performance** with prep time analytics
- **Customer satisfaction** indicators based on delivery times
''', unsafe_allow_html=True)

st.divider()

st.markdown(f'''
<h1grey>Powered by Snowflake, OpenRouteService & Overture Maps</h1grey>
''', unsafe_allow_html=True)
