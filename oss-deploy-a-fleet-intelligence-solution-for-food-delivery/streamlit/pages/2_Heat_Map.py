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
    selected_city = st.selectbox("City", get_california_cities(), index=0)

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
def get_hex_df(h3_res: int, h: int, m: int) -> pd.DataFrame:
    sql = f"""
        WITH latest AS (
            SELECT order_id, point_geom,
            
            FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V
            WHERE hour(TO_TIMESTAMP(CURR_TIME)) = {h}
              AND minute(TO_TIMESTAMP(CURR_TIME)) = {m}
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY order_id ORDER BY CURR_TIME DESC
            ) = 1
        )
        SELECT h3_point_to_cell_string(point_geom, {h3_res}) AS h3,
               COUNT(*) AS count
        FROM latest
        GROUP BY ALL
    """
    df = session.sql(sql).to_pandas()
    df["TOOLTIP"] = "Couriers in cell: " + df["COUNT"].astype(str)
    return df


@st.cache_resource(ttl="2d")
def get_point_df(h: int, m: int) -> pd.DataFrame:
    sql = f"""
        WITH latest AS (
            SELECT order_id,
                   DELIVERY_NAME, 
                   point_geom,
                   ST_SIMPLIFY(GEOMETRY, 10) AS route_simpl
            
            
            FROM 
            (SELECT A.*,B.DELIVERY_NAME,C.GEOMETRY FROM 
            OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.COURIER_LOCATIONS_V A
            INNER JOIN 
            OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_NAMES B ON A.ORDER_ID = B.ORDER_ID
            INNER JOIN

            (SELECT ORDER_ID,GEOMETRY FROM OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.ORDERS_ASSIGNED_TO_COURIERS) C
            ON A.ORDER_ID = C.ORDER_ID
            
            )
            
            
            
            
            
            WHERE hour(TO_TIMESTAMP(CURR_TIME)) = {h}
              AND minute(TO_TIMESTAMP(CURR_TIME)) = {m}
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY order_id ORDER BY CURR_TIME DESC
            ) = 1
        )
        SELECT order_id                        AS "order_id",
               DELIVERY_NAME                   AS DELIVERY_NAME,
               ST_X(point_geom)::FLOAT        AS "lon",
               ST_Y(point_geom)::FLOAT        AS "lat",
               ST_ASGEOJSON(route_simpl)      AS "route_gj"
        FROM latest
    """
    df = session.sql(sql).to_pandas()
    df.columns = df.columns.str.lower()
    df["POSITION"] = df[["lon", "lat"]].values.tolist()
    df["ROUTE"] = df["route_gj"].apply(
        lambda g: json.loads(g)["coordinates"] if isinstance(g, str) else [])
    df["TOOLTIP"] = "Delivery: " + df["delivery_name"].astype(str)
    return df[["order_id", "POSITION", "ROUTE", "TOOLTIP"]]

delivery_plans = session.table('OPENROUTESERVICE_SETUP.FLEET_INTELLIGENCE_FOOD_DELIVERY.DELIVERY_ROUTE_PLAN')\
    .with_column('DELIVERY_NAME', F.concat(F.col('RESTAURANT_NAME'), F.lit(' -> '), F.col('CUSTOMER_STREET')))

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
    return pdk.Layer(
        "ScatterplotLayer", df, id="couriers",
        get_position="POSITION", get_fill_color=[0, 0, 0, 160],
        get_radius=30, pickable=True, auto_highlight=True, opacity=0.8,
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
    prev_filters={}
)
for k, v in state_defaults.items():
    if k not in st.session_state:
        st.session_state[k] = v

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

hex_df   = get_hex_df(h3_res, hour, minute)
point_df = get_point_df(hour, minute)

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
legend_html = f"""
<div style="margin-top:8px;">
  <div style="font-size: 0.85rem; margin-bottom: 6px; color: #6b7b86;">Legend (Couriers per cell)</div>
  <div style="height: 10px; border-radius: 6px; background: linear-gradient(90deg, {gradient});"></div>
  <div style="display:flex; justify-content:space-between; font-size: 0.8rem; color: #9fb0bc;">
    <span>{min_count}</span>
    <span>{max_count}</span>
  </div>
</div>
"""
st.sidebar.markdown(legend_html, unsafe_allow_html=True)

layers = [make_hex_layer(hex_df)]
if show_dots:
    layers.append(make_point_layer(point_df))

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
