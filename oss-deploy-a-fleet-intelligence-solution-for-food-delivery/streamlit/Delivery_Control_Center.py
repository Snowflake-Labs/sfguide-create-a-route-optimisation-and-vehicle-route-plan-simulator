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

st.markdown(f'<h1sub>{CITY["name"]} Delivery Overview</h1sub>', unsafe_allow_html=True)

col1, col2, col3, col4, col5 = st.columns(5)

try:
    city_orders = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS').filter(F.col('CITY') == selected_city)
    city_summary = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY').filter(F.col('CITY') == selected_city)

    orders_count = city_orders.count()
    couriers_count = city_orders.select('COURIER_ID').distinct().count()
    restaurants_count = city_orders.select('RESTAURANT_ID').distinct().count()

    total_distance = city_summary.agg(
        F.sum('ROUTE_DISTANCE_METERS').alias('TOTAL_DISTANCE')
    ).collect()[0]['TOTAL_DISTANCE']

    avg_delivery_time = city_summary.agg(
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

st.markdown(f'<h1sub>California Overview — All Cities</h1sub>', unsafe_allow_html=True)

try:
    all_city_stats = session.sql("""
        SELECT
            CITY,
            COUNT(*) AS ORDERS,
            COUNT(DISTINCT COURIER_ID) AS COURIERS,
            COUNT(DISTINCT RESTAURANT_ID) AS RESTAURANTS,
            ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 0) AS TOTAL_KM,
            ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_MINS
        FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY
        GROUP BY CITY
        ORDER BY ORDERS DESC
    """).to_pandas()

    col1, col2 = st.columns(2)

    with col1:
        chart_orders = alt.Chart(all_city_stats).mark_bar().encode(
            x=alt.X('ORDERS:Q', title='Orders'),
            y=alt.Y('CITY:N', sort='-x', title=''),
            color=alt.condition(
                alt.datum.CITY == selected_city,
                alt.value('#FF6B35'),
                alt.value('#FFB899')
            ),
            tooltip=['CITY', 'ORDERS', 'COURIERS', 'RESTAURANTS', 'AVG_MINS']
        ).properties(title='Orders by City', height=300)
        st.altair_chart(chart_orders, use_container_width=True)

    with col2:
        chart_km = alt.Chart(all_city_stats).mark_bar().encode(
            x=alt.X('TOTAL_KM:Q', title='Total Distance (km)'),
            y=alt.Y('CITY:N', sort='-x', title=''),
            color=alt.condition(
                alt.datum.CITY == selected_city,
                alt.value('#29B5E8'),
                alt.value('#96D5EF')
            ),
            tooltip=['CITY', 'TOTAL_KM', 'AVG_MINS', 'COURIERS']
        ).properties(title='Distance by City', height=300)
        st.altair_chart(chart_km, use_container_width=True)

except Exception as e:
    st.error(f"Error loading city stats: {e}")

st.divider()

st.markdown(f'<h1sub>{CITY["name"]} Live Delivery Routes</h1sub>', unsafe_allow_html=True)

try:
    @st.cache_data
    def get_city_couriers(city):
        return session.sql(f"""
            SELECT DISTINCT COURIER_ID
            FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY
            WHERE CITY = '{city}'
            ORDER BY COURIER_ID
        """).to_pandas()['COURIER_ID'].tolist()

    city_couriers = get_city_couriers(selected_city)

    map_col, legend_col = st.columns([0.85, 0.15])

    with legend_col:
        filter_options = ['All Couriers'] + city_couriers
        selected_courier = st.selectbox('Filter by Courier', filter_options, index=0)

    courier_filter = f"AND COURIER_ID = '{selected_courier}'" if selected_courier != 'All Couriers' else ''

    routes_df = session.sql(f"""
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
        WHERE CITY = '{selected_city}'
          {courier_filter}
        LIMIT 200
    """).to_pandas()

    routes_df["coordinates"] = routes_df["GEOMETRY_JSON"].apply(
        lambda row: json.loads(row)["coordinates"] if row else []
    )

    routes_df['color'] = routes_df['COURIER_ID'].apply(
        lambda x: driver_color(x)
    )

    routes_df['TOOLTIP'] = routes_df.apply(
        lambda r: f"Courier: {r['COURIER_ID']}<br/>From: {r['RESTAURANT_NAME']}<br/>To: {r['CUSTOMER_ADDRESS']}<br/>ETA: {r['ETA_MINS']:.0f} min<br/>Status: {r['ORDER_STATUS']}", axis=1
    )

    routes_df['start'] = routes_df['coordinates'].apply(lambda c: c[0] if c else None)
    routes_df['end'] = routes_df['coordinates'].apply(lambda c: c[-1] if c else None)

    endpoints_df = routes_df.dropna(subset=['start', 'end']).copy()
    pickup_df = endpoints_df[['COURIER_ID', 'RESTAURANT_NAME', 'start', 'color']].copy()
    pickup_df.rename(columns={'start': 'pos', 'RESTAURANT_NAME': 'label'}, inplace=True)
    pickup_df['TOOLTIP'] = pickup_df.apply(lambda r: f"Pickup: {r['label']} ({r['COURIER_ID']})", axis=1)
    dropoff_df = endpoints_df[['COURIER_ID', 'CUSTOMER_ADDRESS', 'end', 'color']].copy()
    dropoff_df.rename(columns={'end': 'pos', 'CUSTOMER_ADDRESS': 'label'}, inplace=True)
    dropoff_df['TOOLTIP'] = dropoff_df.apply(lambda r: f"Dropoff: {r['label']} ({r['COURIER_ID']})", axis=1)

    pickup_layer = pdk.Layer(
        'ScatterplotLayer', pickup_df,
        get_position='pos', get_fill_color='color',
        get_radius=60, radius_min_pixels=4, radius_max_pixels=10,
        pickable=True, id='pickups',
    )

    dropoff_layer = pdk.Layer(
        'ScatterplotLayer', dropoff_df,
        get_position='pos', get_fill_color='color',
        get_radius=60, radius_min_pixels=4, radius_max_pixels=10,
        get_line_color=[255, 255, 255, 200], line_width_min_pixels=2,
        stroked=True, pickable=True, id='dropoffs',
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
        "html": "<b>{TOOLTIP}</b>",
        "style": {
            "backgroundColor": "#24323D",
            "color": "white"
        }
    }

    deck = pdk.Deck(
        map_provider="carto",
        map_style="light",
        initial_view_state=view_state,
        layers=[path_layer, pickup_layer, dropoff_layer],
        tooltip=tooltip,
        height=500
    )

    with map_col:
        st.pydeck_chart(deck, use_container_width=True)

    with legend_col:
        visible_couriers = routes_df['COURIER_ID'].unique()
        route_count = len(routes_df)
        st.markdown(f'**{route_count} routes** from **{len(visible_couriers)} couriers**')
        st.markdown('<div style="font-size:0.8rem; color:#6b7b86; margin-top:6px;">Each colour = unique courier<br/>● Solid dot = Pickup<br/>◉ Ringed dot = Dropoff</div>', unsafe_allow_html=True)
        legend_items = ''.join(
            f'<div style="display:flex;align-items:center;gap:5px;margin:2px 0;">'
            f'<div style="width:10px;height:10px;border-radius:50%;background:rgb({c[0]},{c[1]},{c[2]});"></div>'
            f'<span style="font-size:0.75rem;color:#6b7b86;">{cid}</span></div>'
            for cid, c in sorted(set((cid, tuple(driver_color(cid)[:3])) for cid in visible_couriers))
        )
        st.markdown(f'<div style="max-height:300px;overflow-y:auto;margin-top:4px;">{legend_items}</div>', unsafe_allow_html=True)

except Exception as e:
    st.error(f"Error loading map: {e}")

st.divider()

st.markdown(f'<h1sub>{CITY["name"]} Courier Performance</h1sub>', unsafe_allow_html=True)

try:
    courier_stats = session.sql(f"""
        SELECT
            COURIER_ID,
            COUNT(*) AS DELIVERIES,
            ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 1) AS TOTAL_KM,
            ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DELIVERY_MINS,
            ROUND(SUM(ROUTE_DURATION_SECS)/3600, 1) AS TOTAL_HOURS
        FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY
        WHERE CITY = '{selected_city}'
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
            title=f'Deliveries by Courier — {CITY["name"]}',
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
            title=f'Distance by Courier — {CITY["name"]}',
            height=400
        )
        st.altair_chart(chart_distance, use_container_width=True)

except Exception as e:
    st.error(f"Error loading courier stats: {e}")

st.divider()

st.markdown(f'<h1sub>{CITY["name"]} Peak Delivery Hours</h1sub>', unsafe_allow_html=True)

try:
    hourly_stats = session.sql(f"""
        SELECT
            HOUR(ORDER_TIME) AS HOUR,
            COUNT(*) AS ORDERS,
            ROUND(SUM(ROUTE_DISTANCE_METERS)/1000, 0) AS TOTAL_KM,
            ROUND(AVG(ROUTE_DURATION_SECS)/60, 1) AS AVG_DELIVERY_MINS
        FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY
        WHERE CITY = '{selected_city}'
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

- **Overture Maps Places** - 160K+ California restaurant locations
- **Overture Maps Addresses** - 13.6M California delivery addresses
- **OpenRouteService** - Real-time routing for optimal delivery paths
''', unsafe_allow_html=True)

st.divider()

st.markdown(f'''
<h1grey>Powered by Snowflake, OpenRouteService & Overture Maps</h1grey>
''', unsafe_allow_html=True)
