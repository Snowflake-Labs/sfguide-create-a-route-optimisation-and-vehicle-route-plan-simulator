import json
from typing import List

import branca.colormap as cm
import pandas as pd
import pydeck as pdk
import streamlit as st
from snowflake.snowpark.context import get_active_session
import altair as alt
import snowflake.snowpark.functions as F
from city_config import get_city, get_company, get_california_cities

COMPANY = get_company()

st.set_page_config(
    page_title=f"{COMPANY['name']} - Delivery Heat Map",
    layout="wide",
    initial_sidebar_state="expanded",
)

with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

session = get_active_session()

with st.sidebar:
    city_options = ["All Cities"] + get_california_cities()
    selected_city = st.selectbox("City", city_options, index=0)

city_query_filter = '' if selected_city == 'All Cities' else selected_city
CITY = get_city(selected_city)

st.markdown(f'''
<h0orange>{COMPANY["name"]}</h0orange><h0black> |</h0black><h0blue> Delivery Density</h0blue><BR>
<h1grey>Real-time Courier & Restaurant Activity Map</h1grey>
''', unsafe_allow_html=True)


with st.sidebar:
    st.markdown(
    '''Select an hour & minute to see each courier's **latest position** in that
    minute. Tick *Show courier locations* to display clickable dots. 
    Click a dot to view its route — orange path with red restaurant marker, 
    green customer marker, and dark-blue courier position.'''
    )

@st.cache_resource(ttl="2d")
def get_hex_df(h3_res: int, h: int, m: int, city: str = '') -> pd.DataFrame:
    city_filter = f"AND CITY = '{city}'" if city else ''
    sql = f"""
        WITH active AS (
            SELECT order_id, courier_id, point_geom, courier_state
            FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V
            WHERE hour(TO_TIMESTAMP(CURR_TIME)) = {h}
              AND minute(TO_TIMESTAMP(CURR_TIME)) = {m}
              AND courier_state != 'available'
              {city_filter}
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY order_id ORDER BY CURR_TIME DESC
            ) = 1
        ),
        avail_candidates AS (
            SELECT order_id, courier_id, point_geom, courier_state
            FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V
            WHERE hour(TO_TIMESTAMP(CURR_TIME)) = {h}
              AND minute(TO_TIMESTAMP(CURR_TIME)) <= {m}
              {city_filter}
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY courier_id ORDER BY CURR_TIME DESC
            ) = 1
        ),
        avail AS (
            SELECT * FROM avail_candidates
            WHERE courier_state = 'available'
              AND courier_id NOT IN (SELECT courier_id FROM active)
        ),
        combined AS (
            SELECT point_geom, courier_state FROM active
            UNION ALL
            SELECT point_geom, courier_state FROM avail
        )
        SELECT h3_point_to_cell_string(point_geom, {h3_res}) AS h3,
               COUNT(*) AS count,
               SUM(CASE WHEN courier_state = 'available' THEN 1 ELSE 0 END) AS available_count
        FROM combined
        GROUP BY ALL
    """
    df = session.sql(sql).to_pandas()
    active = df['COUNT'] - df['AVAILABLE_COUNT']
    df["TOOLTIP"] = "Active: " + active.astype(str) + " | Available: " + df["AVAILABLE_COUNT"].astype(str)
    return df


@st.cache_resource(ttl="2d")
def get_point_df(h: int, m: int, city: str = '') -> pd.DataFrame:
    city_filter = f"AND CITY = '{city}'" if city else ''
    sql = f"""
        WITH active_couriers AS (
            SELECT A.order_id, A.courier_id, A.point_geom, A.courier_state,
                   B.DELIVERY_NAME, C.GEOMETRY
            FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V A
            INNER JOIN OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_NAMES B ON A.ORDER_ID = B.ORDER_ID
            INNER JOIN (SELECT ORDER_ID, GEOMETRY FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS) C ON A.ORDER_ID = C.ORDER_ID
            WHERE hour(TO_TIMESTAMP(A.CURR_TIME)) = {h}
              AND minute(TO_TIMESTAMP(A.CURR_TIME)) = {m}
              AND A.COURIER_STATE != 'available'
              {city_filter}
            QUALIFY ROW_NUMBER() OVER (PARTITION BY A.order_id ORDER BY A.CURR_TIME DESC) = 1
        ),
        available_couriers AS (
            SELECT order_id, courier_id, point_geom, courier_state,
                   'Available' AS DELIVERY_NAME, NULL AS GEOMETRY
            FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V
            WHERE hour(TO_TIMESTAMP(CURR_TIME)) = {h}
              AND minute(TO_TIMESTAMP(CURR_TIME)) <= {m}
              {city_filter}
            QUALIFY ROW_NUMBER() OVER (PARTITION BY courier_id ORDER BY CURR_TIME DESC) = 1
        ),
        available_filtered AS (
            SELECT * FROM available_couriers
            WHERE courier_state = 'available'
              AND courier_id NOT IN (SELECT courier_id FROM active_couriers)
        ),
        combined AS (
            SELECT order_id, courier_state, DELIVERY_NAME,
                   ST_X(point_geom)::FLOAT AS lon, ST_Y(point_geom)::FLOAT AS lat,
                   ST_ASGEOJSON(ST_SIMPLIFY(GEOMETRY, 10)) AS route_gj
            FROM active_couriers
            UNION ALL
            SELECT order_id, courier_state, DELIVERY_NAME,
                   ST_X(point_geom)::FLOAT AS lon, ST_Y(point_geom)::FLOAT AS lat,
                   NULL AS route_gj
            FROM available_filtered
        )
        SELECT * FROM combined
    """
    df = session.sql(sql).to_pandas()
    df.columns = df.columns.str.lower()
    df["POSITION"] = df[["lon", "lat"]].values.tolist()
    df["ROUTE"] = df["route_gj"].apply(
        lambda g: json.loads(g)["coordinates"] if isinstance(g, str) else [])
    df["is_available"] = df["courier_state"] == 'available'
    df["TOOLTIP"] = df.apply(lambda r: "Available Courier" if r["is_available"] else "Delivery: " + str(r["delivery_name"]), axis=1)
    return df[["order_id", "POSITION", "ROUTE", "TOOLTIP", "is_available"]]

delivery_plans = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_PLAN')
if selected_city != 'All Cities':
    delivery_plans = delivery_plans.filter(F.col('CITY') == selected_city)
delivery_plans = delivery_plans.with_column('DELIVERY_NAME', F.concat(F.col('RESTAURANT_NAME'), F.lit(' -> '), F.col('CUSTOMER_STREET')))

longest_deliveries = delivery_plans.order_by(F.col('DISTANCE_METERS').desc()).limit(5)

shortest_deliveries = delivery_plans.order_by(F.col('DISTANCE_METERS').asc()).limit(5)

top_restaurants = delivery_plans.group_by('RESTAURANT_NAME').agg(F.count('*').alias('ORDERS')).sort(F.col('ORDERS').desc()).dropna().limit(5)
top_destinations = delivery_plans.group_by('CUSTOMER_STREET').agg(F.count('*').alias('DELIVERIES')).sort(F.col('DELIVERIES').desc()).dropna().limit(5)

def bar_creation(dataframe, measure, attribute):
    df = dataframe.to_pandas()

    bars = alt.Chart(df).mark_bar().encode(
        y=alt.Y(f'{attribute}:N', sort=None, axis=None),
        x=alt.X(f'{measure}:Q', axis=None),
        color=alt.value("#FF6B35"),
        
        tooltip=[
            alt.Tooltip(f'{attribute}:N', title=attribute.replace('_', ' ').title()),
            alt.Tooltip(f'{measure}:Q', title=measure.replace('_', ' ').title())
        ]
    ).properties(height=300)

    text = bars.mark_text(
        align='right',
        baseline='middle',
        dx=-10,
        fontSize=18
    ).encode(
        color=alt.value("#FFFFFF"),
        x=alt.X(f'{measure}:Q'),
        y=alt.Y(f'{attribute}:N', sort=None),
        text=alt.Text(f'{measure}:Q', format=",.0f")
    )

    final_chart = (bars + text).properties(height=200)

    return final_chart


col1,col2 = st.columns(2)

with col1:
 
    st.markdown('<h1grey>TOP LOCATIONS</h1grey>',unsafe_allow_html=True)
    cola,colb = st.columns(2)
    with cola:
        st.markdown('<h1sub>Popular Restaurants</h1sub>',unsafe_allow_html=True)
    
        st.altair_chart(bar_creation(top_restaurants,'ORDERS','RESTAURANT_NAME'), use_container_width=True)

    with colb:
        st.markdown('<h1sub>Frequent Delivery Areas</h1sub>',unsafe_allow_html=True)
        

        st.altair_chart(bar_creation(top_destinations,'DELIVERIES','CUSTOMER_STREET'), use_container_width=True)


with col2:
    
    st.markdown('<h1grey>DELIVERY DISTANCES (METERS)</h1grey>',unsafe_allow_html=True)
    colc,cold = st.columns(2)

    with colc:
        st.markdown('<h1sub>Shortest Deliveries</h1sub>',unsafe_allow_html=True)
    
                                                                  
        st.altair_chart(bar_creation(shortest_deliveries,'DISTANCE_METERS','DELIVERY_NAME'), use_container_width=True)

    with cold:
        st.markdown('<h1sub>Longest Deliveries</h1sub>',unsafe_allow_html=True)
    
        st.altair_chart(bar_creation(longest_deliveries,'DISTANCE_METERS','DELIVERY_NAME'), use_container_width=True)



def make_hex_layer(df):
    return pdk.Layer(
        "H3HexagonLayer", df, id="hexes",
        get_hexagon="H3", get_fill_color="COLOR", get_line_color="COLOR",
        pickable=True, auto_highlight=True,
        extruded=False, coverage=1, opacity=0.3,
    )

def make_point_layer(df):
    active = df[~df["is_available"]] if "is_available" in df.columns else df
    return pdk.Layer(
        "ScatterplotLayer", active, id="couriers",
        get_position="POSITION", get_fill_color=[0, 53, 69, 200],
        get_radius=40, pickable=True, auto_highlight=True, opacity=0.9,
    )

def make_available_layer(df):
    available = df[df["is_available"]] if "is_available" in df.columns else pd.DataFrame()
    if available.empty:
        return None
    return pdk.Layer(
        "ScatterplotLayer", available, id="available",
        get_position="POSITION", get_fill_color=[46, 204, 113, 200],
        get_radius=50, pickable=True, auto_highlight=True, opacity=0.9,
    )

def make_route_layer(path):
    return pdk.Layer(
        "PathLayer", [{"path": path}], id="route",
        get_path="path", get_width=6, width_min_pixels=4,
        get_color=[255, 107, 53],
    )

def make_endpoint_layers(path):
    if not path:
        return []
    start, end = path[0], path[-1]
    s = pdk.Layer(
        "ScatterplotLayer", [{"pos": start}], id="restaurant",
        get_position="pos", get_fill_color=[230, 57, 70, 220], get_radius=120)
    e = pdk.Layer(
        "ScatterplotLayer", [{"pos": end}], id="customer",
        get_position="pos", get_fill_color=[46, 204, 113, 220], get_radius=120)
    return [s, e]

def make_current_layer(pos):
    return pdk.Layer(
        "ScatterplotLayer", [{"pos": pos}], id="current",
        get_position="pos", get_fill_color=[41,181,232], get_radius=120)

def colourise(series, palette, vmin, vmax, stops):
    cmap = cm.LinearColormap(palette, vmin=vmin, vmax=vmax, index=stops)
    return series.apply(cmap.rgb_bytes_tuple)

state_defaults = dict(
    view_state=dict(latitude=CITY["latitude"],
                    longitude=CITY["longitude"],
                    zoom=CITY["zoom"], pitch=0, bearing=0),
    selected_route=None,
    selected_pos=None,
    prev_filters={},
    prev_city=selected_city,
)
for k, v in state_defaults.items():
    if k not in st.session_state:
        st.session_state[k] = v

if st.session_state.get("prev_city") != selected_city:
    st.session_state.view_state = dict(
        latitude=CITY["latitude"], longitude=CITY["longitude"],
        zoom=CITY["zoom"], pitch=0, bearing=0,
    )
    st.session_state.selected_route = None
    st.session_state.selected_pos = None
    st.session_state.prev_city = selected_city

with st.sidebar:
    st.header("Controls")
    show_dots  = st.checkbox("Show courier locations", True)
    h3_res     = st.slider("H3 resolution", 6, 9, 7)
    colour_pal = st.selectbox("Colour scheme", ("SwiftBite", "Snowflake"))
    st.divider(); st.subheader("Time slice")
    hour   = st.slider("Hour",   0, 23, 12)
    minute = st.slider("Minute", 0, 59, 30)

curr_filters = dict(show=show_dots, h3=h3_res, h=hour, m=minute)
if curr_filters != st.session_state.prev_filters:
    st.session_state.selected_route = None
    st.session_state.selected_pos   = None
st.session_state.prev_filters = curr_filters

hex_df   = get_hex_df(h3_res, hour, minute, city_query_filter)
point_df = get_point_df(hour, minute, city_query_filter)

qs, colors = (
    (hex_df["COUNT"].quantile([0, .25, .5, .75, 1]),
     ["#ffe5cc", "#ffcc99", "#ff9f36", "#FF6B35", "#E63946"])
    if colour_pal == "SwiftBite" else
    (hex_df["COUNT"].quantile([0, .33, .66, 1]),
     ["#666666", "#24BFF2", "#126481", "#D966FF"])
)
hex_df["COLOR"] = colourise(
    hex_df["COUNT"], colors, qs.min(), qs.max(), qs)

min_count = int(hex_df["COUNT"].min()) if not hex_df.empty else 0
max_count = int(hex_df["COUNT"].max()) if not hex_df.empty else 0
gradient = ", ".join(colors)
active_count = len(point_df[~point_df['is_available']]) if 'is_available' in point_df.columns else len(point_df)
available_count = len(point_df[point_df['is_available']]) if 'is_available' in point_df.columns else 0
legend_html = f"""
<div style="margin-top:8px;">
  <div style="font-size: 0.85rem; margin-bottom: 6px; color: #6b7b86;">Legend (Couriers per cell)</div>
  <div style="height: 10px; border-radius: 6px; background: linear-gradient(90deg, {gradient});"></div>
  <div style="display:flex; justify-content:space-between; font-size: 0.8rem; color: #9fb0bc;">
    <span>{min_count}</span>
    <span>{max_count}</span>
  </div>
  <div style="margin-top:10px; font-size: 0.85rem;">
    <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
      <div style="width:12px; height:12px; border-radius:50%; background:#003545;"></div>
      <span style="color:#6b7b86;">Active ({active_count})</span>
    </div>
    <div style="display:flex; align-items:center; gap:6px;">
      <div style="width:12px; height:12px; border-radius:50%; background:#2ECC71;"></div>
      <span style="color:#6b7b86;">Available ({available_count})</span>
    </div>
  </div>
</div>
"""
st.sidebar.markdown(legend_html, unsafe_allow_html=True)

layers = [make_hex_layer(hex_df)]
if show_dots:
    layers.append(make_point_layer(point_df))
    avail_layer = make_available_layer(point_df)
    if avail_layer:
        layers.append(avail_layer)

route, pos = st.session_state.selected_route, st.session_state.selected_pos
if route:
    layers.append(make_route_layer(route))
    layers.extend(make_endpoint_layers(route))
    layers.append(make_current_layer(pos))



tooltip = {
   "html": """
    {TOOLTIP} 
   """,
   "style": {
       "width":"50%",
        "backgroundColor": "#24323D",
        "color": "white",
       "text-wrap": "balance"
   }
}

deck = pdk.Deck(
    map_provider="carto", map_style="light",
    initial_view_state=pdk.ViewState(**st.session_state.view_state),
    layers=layers,
    tooltip=tooltip,
)
st.pydeck_chart(deck, use_container_width=True)
