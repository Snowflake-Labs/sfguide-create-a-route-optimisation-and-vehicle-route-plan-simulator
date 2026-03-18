import streamlit as st
import pandas as pd
import pydeck as pdk
import os
import snowflake.connector

st.set_page_config(page_title="H3 Congestion Map", layout="wide")

SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_resource
def get_connection():
    return snowflake.connector.connect(
        connection_name=os.getenv("SNOWFLAKE_CONNECTION_NAME") or "airpublic"
    )

def run_query(sql):
    conn = get_connection()
    return pd.read_sql(sql, conn)

st.title("H3 Congestion Heatmap")
st.caption("Hexagonal grid (resolution 7) showing dwell hotspots across Germany")

hours = run_query(f"""
    SELECT DISTINCT HOUR_BUCKET FROM {SCHEMA}.DT_H3_CONGESTION ORDER BY HOUR_BUCKET
""")

col1, col2 = st.columns([1, 3])
with col1:
    selected_date = st.date_input("Date", value=pd.to_datetime("2025-12-07"))
    hour_val = st.slider("Hour of Day", 0, 23, 10)
    min_vehicles = st.slider("Min Vehicles", 1, 20, 1)
    color_metric = st.radio("Color by", ["VEHICLE_COUNT", "AVG_DWELL_MIN", "SESSION_COUNT"])

target_hour = f"{selected_date} {hour_val:02d}:00:00"

data = run_query(f"""
    SELECT H3_CELL_R7, VEHICLE_COUNT, SESSION_COUNT, AVG_DWELL_MIN, TOTAL_DWELL_MIN
    FROM {SCHEMA}.DT_H3_CONGESTION
    WHERE HOUR_BUCKET = '{target_hour}'
      AND VEHICLE_COUNT >= {min_vehicles}
""")

with col2:
    if len(data) == 0:
        st.info(f"No congestion data for {target_hour} with >= {min_vehicles} vehicles. Try a different date/hour.")
    else:
        max_val = data[color_metric].max()
        data['normalized'] = data[color_metric] / max(max_val, 1)
        data['r'] = (data['normalized'] * 255).astype(int)
        data['g'] = ((1 - data['normalized']) * 200).astype(int)
        data['b'] = 50

        layer = pdk.Layer(
            "H3HexagonLayer",
            data,
            pickable=True,
            stroked=True,
            filled=True,
            extruded=True,
            get_hexagon="H3_CELL_R7",
            get_fill_color="[r, 80, b, 180]",
            get_elevation=f"{color_metric}",
            elevation_scale=500,
            elevation_range=[0, 3000],
        )

        view = pdk.ViewState(latitude=51.1657, longitude=10.4515, zoom=6, pitch=45)

        deck = pdk.Deck(
            layers=[layer],
            initial_view_state=view,
            tooltip={"text": "H3: {H3_CELL_R7}\nVehicles: {VEHICLE_COUNT}\nSessions: {SESSION_COUNT}\nAvg Dwell: {AVG_DWELL_MIN} min"},
            map_style="mapbox://styles/mapbox/dark-v10"
        )
        st.pydeck_chart(deck)

        st.metric("Active H3 Cells", len(data))
        st.dataframe(
            data[['H3_CELL_R7', 'VEHICLE_COUNT', 'SESSION_COUNT', 'AVG_DWELL_MIN', 'TOTAL_DWELL_MIN']]
            .sort_values(color_metric, ascending=False).head(20),
            use_container_width=True, hide_index=True
        )
