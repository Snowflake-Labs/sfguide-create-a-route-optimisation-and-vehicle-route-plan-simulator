import json
from typing import List

import branca.colormap as cm
import pandas as pd
import pydeck as pdk
import streamlit as st
from snowflake.snowpark.context import get_active_session
import altair as alt
from snowflake.snowpark.functions import *

# ─────────────────────────────  PAGE CONFIG  ────────────────────────────────
st.set_page_config(
    page_title="Drivers Density Map",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ─────────────────────────────  CSS Style sheet  ────────────────────────────────

with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

session = get_active_session()

st.markdown('''
<h0black>New York Taxi |</h0black><h0blue>Control Center</h0blue><BR>
<h1black>Vehicle Heat Map</h1black>
''', unsafe_allow_html=True)


with st.sidebar:
    st.markdown(
    '''Select an hour & minute to see each driver’s **latest position** in that
    minute. Tick *Show drivers locations* to display clickable dots. 
    Click a dot to view its route — dark‑blue path with red start, green 
    finish, and a dark‑blue marker for the current position.'''
    )

# ─────────────────────────────  DATA HELPERS  ───────────────────────────────
@st.cache_resource(ttl="2d")
def get_hex_df(h3_res: int, h: int, m: int) -> pd.DataFrame:
    sql = f"""
        WITH latest AS (
            SELECT trip_id, point_geom,
            
            FROM DATA.DRIVER_LOCATIONS
            WHERE hour(TO_TIMESTAMP(point_time)) = {h}
              AND minute(TO_TIMESTAMP(point_time)) = {m}
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY trip_id ORDER BY point_time DESC
            ) = 1
        )
        SELECT h3_point_to_cell_string(point_geom, {h3_res}) AS h3,
               COUNT(*) AS count
        FROM latest
        GROUP BY ALL
    """
    df = session.sql(sql).to_pandas()
    df["TOOLTIP"] = "Drivers in cell: " + df["COUNT"].astype(str)
    return df


@st.cache_resource(ttl="2d")
def get_point_df(h: int, m: int) -> pd.DataFrame:
    sql = f"""
        WITH latest AS (
            SELECT trip_id,
                   ROUTE_DESCRIPTION, 
                   point_geom,
                   ST_SIMPLIFY(route, 10) AS route_simpl
            FROM ALL_DRIVER_LOCATIONS
            WHERE hour(TO_TIMESTAMP(point_time)) = {h}
              AND minute(TO_TIMESTAMP(point_time)) = {m}
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY trip_id ORDER BY point_time DESC
            ) = 1
        )
        SELECT trip_id                        AS "trip_id",
               ROUTE_DESCRIPTION              AS ROUTE_DESCRIPTION,
               ST_X(point_geom)::FLOAT       AS "lon",
               ST_Y(point_geom)::FLOAT       AS "lat",
               ST_ASGEOJSON(route_simpl)     AS "route_gj"
        FROM latest
    """
    df = session.sql(sql).to_pandas()
    df["POSITION"] = df[["lon", "lat"]].values.tolist()
    df["ROUTE"] = df["route_gj"].apply(
        lambda g: json.loads(g)["coordinates"] if isinstance(g, str) else [])
    df["TOOLTIP"] = "Route: " + df["ROUTE_DESCRIPTION"].astype(str)
    return df[["trip_id", "POSITION", "ROUTE", "TOOLTIP"]]
    
# ─────────────────────────────  Vehicle Stats  ────────────────────────────────



vehicle_plans = session.table('CURATED_VEHICLE_PLANS')

longest_trips = vehicle_plans.order_by(col('DISTANCE').desc()).limit(5)
shortest_trips = vehicle_plans.order_by(col('DISTANCE').asc()).limit(5)

top_pickup = vehicle_plans.group_by('PICKUP PLACE').agg(count('*').alias('PICKUPS')).sort(col('PICKUPS').desc()).limit(5)
top_dropoff = vehicle_plans.group_by('DROPOFF PLACE').agg(count('*').alias('DROPOFFS')).sort(col('DROPOFFS').desc()).limit(5)

        



def bar_creation(dataframe, measure, attribute):
    # before any charts are defined or rendered.

    # Ensure the input is a pandas DataFrame, as Altair works with pandas DataFrames
    # If dataframe is already a pandas DataFrame, .to_pandas() is redundant but harmless.
    # If it's a Snowpark DataFrame, this correctly converts it.
    df = dataframe.to_pandas()

    # Create the bars
    bars = alt.Chart(df).mark_bar().encode(
        y=alt.Y(attribute, sort=None, axis=None), # Hide the y-axis labels
        x=alt.X(measure, axis=None),              # Hide the x-axis labels
        color=alt.value("#29B5E8"),               # Set a fixed color for the bars
        
        tooltip=[                                 # <--- MODIFIED HERE to add titles
            alt.Tooltip(attribute, title=attribute.replace('_', ' ').title()), # Title from attribute name
            alt.Tooltip(measure, title=measure.replace('_', ' ').title())    # Title from measure name
        ]              # Add tooltip for interactivity
    ).properties(height=300) # Set a fixed height for the bars chart

    # Create the text layer for point values
    # Properties like align, baseline, dx, color, and fontSize are part of mark_text()
    text = bars.mark_text(
        align='right',    # Align text to the right side of its x-position (end of the bar)
        baseline='middle',
        dx=-10,            # Nudge text to the left (inside the bar) for better visibility
         # Set text color to white
        fontSize=18       # Set the font size for the text labels
    ).encode(
        color=alt.value("#FFFFFF"),
        # These are the encoding channels that map data to visual properties
        x=alt.X(measure), # X-position of the text (at the end of the bar)
        y=alt.Y(attribute, sort=None), # Y-position of the text (aligned with the bar)
        text=alt.Text(measure, format=",.0f") # The actual text to display (formatted measure value)
    )

    # Combine the bar chart and the text layer
    # Note: The height property on the combined chart will override the individual chart heights
    final_chart = (bars + text).properties(height=200)



    return final_chart


col1,col2 = st.columns(2)

with col1:
 
    st.markdown('<h1grey>TOP LOCATIONS</h1grey>',unsafe_allow_html=True)
    cola,colb = st.columns(2)
    with cola:
        st.markdown('<h1sub>Pickups</h1sub>',unsafe_allow_html=True)
    
        st.altair_chart(bar_creation(top_pickup,'PICKUPS','PICKUP PLACE'), use_container_width=True)

    with colb:
        st.markdown('<h1sub>DROPOFFS</h1sub>',unsafe_allow_html=True)
        

        st.altair_chart(bar_creation(top_dropoff,'DROPOFFS','DROPOFF PLACE'), use_container_width=True)


with col2:
    
    st.markdown('<h1grey>ROUTES FOR ALL DRIVERS</h1grey>',unsafe_allow_html=True)
    colc,cold = st.columns(2)

    with colc:
        st.markdown('<h1sub>Shortest Routes</h1sub>',unsafe_allow_html=True)
    
                                                                  
        st.altair_chart(bar_creation(shortest_trips,'DISTANCE','TRIP_ID'), use_container_width=True)

    with cold:
        st.markdown('<h1sub>Longest Routes</h1sub>',unsafe_allow_html=True)
    
        st.altair_chart(bar_creation(longest_trips,'DISTANCE','TRIP_ID'), use_container_width=True)



# ─────────────────────────────  LAYER BUILDERS  ─────────────────────────────
def make_hex_layer(df):
    return pdk.Layer(
        "H3HexagonLayer", df, id="hexes",
        get_hexagon="H3", get_fill_color="COLOR", get_line_color="COLOR",
        pickable=True, auto_highlight=True,
        extruded=False, coverage=1, opacity=0.3,
    )

def make_point_layer(df):
    return pdk.Layer(
        "ScatterplotLayer", df, id="drivers",
        get_position="POSITION", get_fill_color=[0, 0, 0, 160],
        get_radius=30, pickable=True, auto_highlight=True, opacity=0.8,
    )

def make_route_layer(path):
    return pdk.Layer(
        "PathLayer", [{"path": path}], id="route",
        get_path="path", get_width=4, width_min_pixels=3,
        get_color=[0, 0, 150, 190],
    )

def make_endpoint_layers(path):
    if not path:
        return []
    start, end = path[0], path[-1]
    s = pdk.Layer(
        "ScatterplotLayer", [{"pos": start}], id="start",
        get_position="pos", get_fill_color=[255, 0, 0, 220], get_radius=120)
    e = pdk.Layer(
        "ScatterplotLayer", [{"pos": end}], id="end",
        get_position="pos", get_fill_color=[0, 180, 0, 220], get_radius=120)
    return [s, e]

def make_current_layer(pos):
    return pdk.Layer(
        "ScatterplotLayer", [{"pos": pos}], id="current",
        get_position="pos", get_fill_color=[0, 0, 150, 220], get_radius=120)

def colourise(series, palette, vmin, vmax, stops):
    cmap = cm.LinearColormap(palette, vmin=vmin, vmax=vmax, index=stops)
    return series.apply(cmap.rgb_bytes_tuple)

# ─────────────────────────────  SESSION STATE  ──────────────────────────────
state_defaults = dict(
    view_state=dict(latitude=40.74258515841464,
                    longitude=-73.98452997207642,
                    zoom=10, pitch=0, bearing=0),
    selected_route=None,
    selected_pos=None,
    prev_filters={}
)
for k, v in state_defaults.items():
    if k not in st.session_state:
        st.session_state[k] = v

# ─────────────────────────────  SIDEBAR  ────────────────────────────────────
with st.sidebar:
    st.header("Controls")
    show_dots  = st.checkbox("Show drivers locations", True)
    h3_res     = st.slider("H3 resolution", 6, 9, 7)
    colour_pal = st.selectbox("Colour scheme", ("Contrast", "Snowflake"))
    st.divider(); st.subheader("Time slice")
    hour   = st.slider("Hour",   0, 23, 6)
    minute = st.slider("Minute", 0, 59, 5)

# ─────────────────────────────  RESET ROUTE IF FILTERS CHANGED  ────────────
curr_filters = dict(show=show_dots, h3=h3_res, h=hour, m=minute)
if curr_filters != st.session_state.prev_filters:
    st.session_state.selected_route = None
    st.session_state.selected_pos   = None
st.session_state.prev_filters = curr_filters

# ─────────────────────────────  FETCH DATA  ────────────────────────────────
hex_df   = get_hex_df(h3_res, hour, minute)
point_df = get_point_df(hour, minute)

qs, colors = (
    (hex_df["COUNT"].quantile([0, .25, .5, .75, 1]),
     ["#466b75", "#11567F", "#29B5E8", "yellow", "#FF9F36", "#D45B90"])
    if colour_pal == "Contrast" else
    (hex_df["COUNT"].quantile([0, .33, .66, 1]),
     ["#666666", "#24BFF2", "#126481", "#D966FF"])
)
hex_df["COLOR"] = colourise(
    hex_df["COUNT"], colors, qs.min(), qs.max(), qs)

# ─────────────────────────────  BUILD LAYERS  ──────────────────────────────
layers = [make_hex_layer(hex_df)]
if show_dots:
    layers.append(make_point_layer(point_df))

route, pos = st.session_state.selected_route, st.session_state.selected_pos
if route:
    layers.append(make_route_layer(route))
    layers.extend(make_endpoint_layers(route))
    layers.append(make_current_layer(pos))

# ─────────────────────────────  DRAW MAP  ──────────────────────────────────


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
event = st.pydeck_chart(
    deck, on_select="rerun",
    selection_mode="single-object",
    use_container_width=True,
    key="drivers-map",
)

# ─────────────────────────────  HANDLE CLICK  ──────────────────────────────
if isinstance(event, dict):
    obj = event.get("object")
    sel = event.get("selection", {}).get("objects", {}).get("drivers", [])
    if obj and "ROUTE" in obj:
        new_route, new_pos = obj["ROUTE"], obj["POSITION"]
    elif sel:
        new_route, new_pos = sel[0]["ROUTE"], sel[0]["POSITION"]
    else:
        new_route = new_pos = None

    if new_route and (
        new_route != st.session_state.selected_route
        or new_pos  != st.session_state.selected_pos
    ):
        st.session_state.selected_route = new_route
        st.session_state.selected_pos   = new_pos
        st.rerun()          # immediate rerun to render the route