# SwiftBite Food Delivery - Courier Routes
# Track individual courier deliveries with route visualization

import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import json
from datetime import time, datetime

import snowflake.snowpark.functions as F
from snowflake.snowpark.types import *
from snowflake.snowpark.window import Window
from snowflake.snowpark.context import get_active_session
from city_config import get_city, get_company, get_california_cities

COMPANY = get_company()

session = get_active_session()
st.set_page_config(layout="wide")

with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

st.logo('logo.svg')

with st.sidebar:
    selected_city = st.selectbox("City", get_california_cities(), index=0)

CITY = get_city(selected_city)

def bar_creation(dataframe, measure, attribute):
    df = dataframe.to_pandas()
    
    bars = alt.Chart(df).mark_bar().encode(
        y=alt.Y(attribute, sort=None, axis=None),
        x=alt.X(measure, axis=None),
        color=alt.value("#FF6B35"),
        tooltip=[
            alt.Tooltip(attribute, title=attribute.replace('_', ' ').title()),
            alt.Tooltip(measure, title=measure.replace('_', ' ').title())
        ]
    ).properties(height=300)
    
    text = bars.mark_text(
        align='right',
        baseline='middle',
        dx=-10,
        fontSize=14
    ).encode(
        color=alt.value("#FFFFFF"),
        x=alt.X(measure),
        y=alt.Y(attribute, sort=None),
        text=alt.Text(measure, format=",.0f")
    )
    
    return (bars + text).properties(height=200)

delivery_plans = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_PLAN')
routes = delivery_plans.select('GEOMETRY', 'ORDER_ID', 'DISTANCE_METERS', 'COURIER_ID')
delivery_summary = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY')

delivery_plans = delivery_plans.with_column('DELIVERY_NAME', F.concat(F.col('RESTAURANT_NAME'), F.lit(' -> '), F.col('CUSTOMER_STREET')))

all_courier_locations = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V')
all_courier_locations = all_courier_locations.with_column('POINT_TIME_STR', F.col('POINT_TIME').astype(StringType()))

@st.cache_data
def get_couriers():
    return delivery_plans.select('COURIER_ID').distinct().sort('COURIER_ID').to_pandas()

with st.sidebar:
    courier = st.selectbox('Choose Courier:', get_couriers())

def get_deliveries(courier):
    return delivery_plans.filter(F.col('COURIER_ID') == courier)\
        .group_by('ORDER_ID', 'DELIVERY_NAME').agg(F.min('DISTANCE_METERS').alias('DISTANCE_METERS'))\
        .sort(F.col('DISTANCE_METERS').desc()).to_pandas()

courier_day = delivery_plans.filter(F.col('COURIER_ID') == courier)
delivery_summaryd = delivery_summary.filter(F.col('COURIER_ID') == courier)

st.markdown(f'''
<h0orange>{COMPANY["name"]}</h0orange><h0black> |</h0black><h0blue> Courier Tracking</h0blue><BR>
<h1grey>Viewing Deliveries for Courier {courier}</h1grey>
''', unsafe_allow_html=True)

time_by_hour = all_courier_locations.filter(F.col('COURIER_ID') == courier)\
    .join(routes.select('ORDER_ID', 'DISTANCE_METERS'), 'ORDER_ID')\
    .with_column('HOUR', F.hour(F.to_timestamp('POINT_TIME')))\
    .group_by('HOUR', 'ORDER_ID').agg(F.max('DISTANCE_METERS').alias('DISTANCE_METERS'))

time_by_hour = time_by_hour.group_by('HOUR').agg(
    F.count('*').alias('DELIVERIES'),
    F.sum('DISTANCE_METERS').alias('DISTANCE')
)

try:
    perhour_stats = time_by_hour.agg(
        F.avg('DELIVERIES').alias('DELIVERIES'),
        F.avg('DISTANCE').alias('DISTANCE')
    ).to_pandas()
except:
    perhour_stats = pd.DataFrame({'DELIVERIES': [0], 'DISTANCE': [0]})

st.markdown(f'<h1grey>DELIVERY ACTIVITY FOR {courier} TODAY</h1grey>', unsafe_allow_html=True)

try:
    df = time_by_hour.to_pandas()
    
    col1, col2 = st.columns(2)
    
    with col1:
        chart_deliveries = alt.Chart(df).mark_rect().encode(
            x=alt.X('HOUR:O', title='Hour', axis=alt.Axis(values=list(range(24)))),
            y=alt.Y('value:O', title='', axis=None),
            color=alt.Color('DELIVERIES:Q', title='Deliveries', 
                          scale=alt.Scale(range=['#ffe5cc', '#ffcc99', '#ff9f36', '#FF6B35']),
                          legend=None),
            tooltip=[alt.Tooltip('HOUR:O', title='Hour'), alt.Tooltip('DELIVERIES:Q', title='Deliveries')]
        ).transform_calculate(value='"Deliveries"').properties(title='Deliveries per Hour', height=80)
        st.altair_chart(chart_deliveries, use_container_width=True)
    
    with col2:
        chart_distance = alt.Chart(df).mark_rect().encode(
            x=alt.X('HOUR:O', title='Hour', axis=alt.Axis(values=list(range(24)))),
            y=alt.Y('value:O', title='', axis=None),
            color=alt.Color('DISTANCE:Q', title='Distance',
                          scale=alt.Scale(range=['#c6e5f1', '#96d5ef', '#63c6eb', '#29B5E8']),
                          legend=None),
            tooltip=[alt.Tooltip('HOUR:O', title='Hour'), alt.Tooltip('DISTANCE:Q', title='Distance (m)', format=',.0f')]
        ).transform_calculate(value='"Distance"').properties(title='Distance per Hour', height=80)
        st.altair_chart(chart_distance, use_container_width=True)
except Exception as e:
    st.warning(f"Could not load time analysis: {e}")

with st.sidebar:
    try:
        speed_stats = delivery_summaryd.agg(
            F.avg('AVERAGE_KMH').alias('AVG_KMH'),
            F.max('AVERAGE_KMH').alias('MAX_KMH')
        ).to_pandas()
        courier_stats = courier_day.agg(
            F.count('*').alias('A'),
            F.sum('DISTANCE_METERS').alias('B')
        ).to_pandas()
        
        st.markdown(f'<h1grey style="font-size: 0.9em;">DELIVERIES TODAY<BR></h1grey><h0orange style="font-size: 1.5em;">{courier_stats.A.iloc[0]}</h0orange>', unsafe_allow_html=True)
        st.markdown(f'<h1grey style="font-size: 0.9em;">TOTAL DISTANCE<BR></h1grey><h0blue style="font-size: 1.5em;">{(courier_stats.B.iloc[0]/1000):.1f} km</h0blue>', unsafe_allow_html=True)
        st.markdown(f'<h1grey style="font-size: 0.9em;">AVG SPEED<BR></h1grey><h0blue style="font-size: 1.5em;">{speed_stats.AVG_KMH.iloc[0]:.1f} km/h</h0blue>', unsafe_allow_html=True)
        st.markdown(f'<h1grey style="font-size: 0.9em;">MAX SPEED<BR></h1grey><h0blue style="font-size: 1.5em;">{speed_stats.MAX_KMH.iloc[0]:.1f} km/h</h0blue>', unsafe_allow_html=True)
    except Exception as e:
        st.warning(f"Stats unavailable: {e}")

st.markdown(f'<h1grey>DELIVERY DISTANCES FOR {courier}</h1grey>', unsafe_allow_html=True)

try:
    col1, col2 = st.columns(2)
    
    with col1:
        st.markdown('<h1sub>Shortest Deliveries</h1sub>', unsafe_allow_html=True)
        shortest = courier_day.sort(F.col('DISTANCE_METERS').asc()).limit(5)
        st.altair_chart(bar_creation(shortest, 'DISTANCE_METERS', 'DELIVERY_NAME'))
    
    with col2:
        st.markdown('<h1sub>Longest Deliveries</h1sub>', unsafe_allow_html=True)
        longest = courier_day.sort(F.col('DISTANCE_METERS').desc()).limit(5)
        st.altair_chart(bar_creation(longest, 'DISTANCE_METERS', 'DELIVERY_NAME'))
except Exception as e:
    st.warning(f"Could not load delivery charts: {e}")

st.divider()

st.markdown('<h1sub>Individual Delivery Details</h1sub>', unsafe_allow_html=True)

deliveries_df = get_deliveries(courier)
if len(deliveries_df) > 0:
    selected_delivery = st.selectbox('Choose Delivery (sorted by distance):', deliveries_df.DELIVERY_NAME)
    order_id = deliveries_df.query(f'DELIVERY_NAME == "{selected_delivery}"').ORDER_ID.iloc[0]
    
    selected_order = delivery_summary.filter(F.col('ORDER_ID') == order_id)
    selected_order = selected_order.with_column('LONR', F.call_function('ST_X', F.col('RESTAURANT_LOCATION')))
    selected_order = selected_order.with_column('LATR', F.call_function('ST_Y', F.col('RESTAURANT_LOCATION')))
    selected_order = selected_order.with_column('LONC', F.call_function('ST_X', F.col('CUSTOMER_LOCATION')))
    selected_order = selected_order.with_column('LATC', F.call_function('ST_Y', F.col('CUSTOMER_LOCATION')))
    
    order_data = selected_order.to_pandas()
    
    if len(order_data) > 0:
        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("Distance", f"{order_data['ROUTE_DISTANCE_METERS'].iloc[0]/1000:.2f} km")
        with col2:
            st.metric("ETA", f"{order_data['ROUTE_DURATION_SECS'].iloc[0]/60:.0f} min")
        with col3:
            st.metric("Avg Speed", f"{order_data['AVERAGE_KMH'].iloc[0]:.1f} km/h")
        with col4:
            st.metric("Order Time", order_data['ORDER_TIME'].iloc[0].strftime('%H:%M'))
        
        delivery_locations = all_courier_locations.filter(F.col('ORDER_ID') == order_id)
        times = delivery_locations.select(
            F.col('POINT_TIME').alias('POINT_TIME'),
            F.col('POINT_INDEX')
        ).sort(F.col('POINT_INDEX')).to_pandas()
        
        if len(times) > 0:
            times['POINT_TIME'] = pd.to_datetime(times['POINT_TIME'], errors='coerce')
            times = times.sort_values('POINT_INDEX').reset_index(drop=True)
            times['POINT_TIME_STR'] = times['POINT_TIME'].dt.strftime('%Y-%m-%d %H:%M:%S')
            
            slider_options = times['POINT_TIME_STR'].tolist()
            Choose_Time = st.select_slider("Track courier position:", slider_options)
            
            selected_idx = times[times['POINT_TIME_STR'] == Choose_Time]['POINT_INDEX'].iloc[0]
            
            current_pos = delivery_locations.filter(
                F.col('POINT_INDEX') == int(selected_idx)
            ).to_pandas()
            
            if len(current_pos) > 0:
                route_geom = session.sql(f"""
                    SELECT ST_ASGEOJSON(GEOMETRY) AS GEOM 
                    FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_SUMMARY 
                    WHERE ORDER_ID = '{order_id}'
                """).collect()[0]['GEOM']
                
                route_coords = json.loads(route_geom)['coordinates']
                
                current_lon = float(current_pos['LON'].iloc[0])
                current_lat = float(current_pos['LAT'].iloc[0])
                current_speed = float(current_pos['KMH'].iloc[0])
                
                restaurant_lon = float(order_data['LONR'].iloc[0])
                restaurant_lat = float(order_data['LATR'].iloc[0])
                customer_lon = float(order_data['LONC'].iloc[0])
                customer_lat = float(order_data['LATC'].iloc[0])
                restaurant_name = str(order_data['RESTAURANT_NAME'].iloc[0])
                customer_addr = str(order_data['CUSTOMER_ADDRESS'].iloc[0])
                
                route_layer = pdk.Layer(
                    type="PathLayer",
                    data=[{"coordinates": route_coords}],
                    get_path="coordinates",
                    get_color=[255, 107, 53],
                    width_min_pixels=4,
                    width_max_pixels=6
                )
                
                restaurant_layer = pdk.Layer(
                    'ScatterplotLayer',
                    data=[{
                        'lon': restaurant_lon,
                        'lat': restaurant_lat,
                        'tooltip': f"Restaurant: {restaurant_name}"
                    }],
                    get_position=['lon', 'lat'],
                    get_radius=50,
                    radius_min_pixels=8,
                    radius_max_pixels=15,
                    get_color=[230, 57, 70],
                    pickable=True
                )
                
                customer_layer = pdk.Layer(
                    'ScatterplotLayer',
                    data=[{
                        'lon': customer_lon,
                        'lat': customer_lat,
                        'tooltip': f"Customer: {customer_addr}"
                    }],
                    get_position=['lon', 'lat'],
                    get_radius=50,
                    radius_min_pixels=8,
                    radius_max_pixels=15,
                    get_color=[46, 204, 113],
                    pickable=True
                )
                
                current_layer = pdk.Layer(
                    'ScatterplotLayer',
                    data=[{
                        'lon': current_lon,
                        'lat': current_lat,
                        'tooltip': f"Courier: {Choose_Time}\nSpeed: {current_speed:.1f} km/h"
                    }],
                    get_position=['lon', 'lat'],
                    get_radius=80,
                    radius_min_pixels=12,
                    radius_max_pixels=20,
                    get_color=[0, 53, 69],
                    pickable=True
                )
                
                center_lon = (restaurant_lon + customer_lon) / 2
                center_lat = (restaurant_lat + customer_lat) / 2
                
                view_state = pdk.ViewState(
                    latitude=center_lat,
                    longitude=center_lon,
                    zoom=13
                )
                
                tooltip = {
                    "html": "{tooltip}",
                    "style": {"backgroundColor": "#24323D", "color": "white"}
                }
                
                col1, col2 = st.columns([0.6, 0.4])
                
                with col1:
                    st.pydeck_chart(pdk.Deck(
                        map_style=None,
                        initial_view_state=view_state,
                        layers=[route_layer, restaurant_layer, customer_layer, current_layer],
                        tooltip=tooltip
                    ))
                
                with col2:
                    st.markdown('<h1sub>Delivery Details</h1sub>', unsafe_allow_html=True)
                    
                    order_time = order_data['ORDER_TIME'].iloc[0]
                    delivery_time = order_data['DELIVERY_TIME'].iloc[0]
                    distance_km = float(order_data['ROUTE_DISTANCE_METERS'].iloc[0]) / 1000
                    duration_mins = float(order_data['ROUTE_DURATION_SECS'].iloc[0]) / 60
                    avg_speed = float(order_data['AVERAGE_KMH'].iloc[0])
                    
                    st.markdown(f"""
                    **Restaurant:** {restaurant_name}
                    
                    **Customer:** {customer_addr}
                    
                    **Order Placed:** {order_time.strftime('%H:%M:%S')}
                    
                    **Delivered:** {delivery_time.strftime('%H:%M:%S')}
                    
                    **Distance:** {distance_km:.2f} km
                    
                    **Duration:** {duration_mins:.0f} minutes
                    
                    **Current Position:** {Choose_Time}
                    
                    **Current Speed:** {current_speed:.1f} km/h
                    """)
                
                st.markdown("---")
                if st.checkbox("Show AI Delivery Analysis"):
                    with st.spinner("Analyzing with Snowflake Cortex..."):
                        try:
                            ai_prompt = f"Analyze this food delivery in {CITY['name']} from {restaurant_name} to {customer_addr}, {distance_km:.2f}km in {duration_mins:.0f}min. Brief insights on delivery efficiency and potential optimizations."
                            
                            from snowflake.snowpark.functions import call_function, lit
                            result_df = session.create_dataframe([[ai_prompt]], schema=['prompt'])
                            result_df = result_df.select(F.call_function('snowflake.cortex.complete', F.lit('claude-3-5-sonnet'), result_df['prompt']).alias('analysis'))
                            result = result_df.collect()[0]['ANALYSIS']
                            
                            st.info(str(result))
                        except Exception as e:
                            st.error(f"Analysis failed: {e}")
