import streamlit as st
import pandas as pd
import pydeck as pdk
from snowflake.snowpark.context import get_active_session

session = get_active_session()
SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_data(ttl=300)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("H3 congestion heatmap")
st.caption("Hexagonal grid (resolution 7) showing dwell hotspots across Germany — slide through time to see congestion evolution")

hours = run_query(f"""
    SELECT DISTINCT HOUR_BUCKET FROM {SCHEMA}.DT_H3_CONGESTION ORDER BY HOUR_BUCKET
""")

hour_list = hours['HOUR_BUCKET'].tolist()

col1, col2 = st.columns([1, 3])
with col1:
    if len(hour_list) > 1:
        selected_hour = st.select_slider("Time bucket", options=hour_list, value=hour_list[len(hour_list) // 2])
    else:
        selected_hour = hour_list[0] if hour_list else None

    min_vehicles = st.slider("Min vehicles", 1, 20, 1)
    color_metric = st.segmented_control("Color by", ["VEHICLE_COUNT", "AVG_DWELL_MIN", "SESSION_COUNT"], default="VEHICLE_COUNT")

if selected_hour is not None:
    data = run_query(f"""
        SELECT H3_CELL_R7, VEHICLE_COUNT, SESSION_COUNT, AVG_DWELL_MIN, TOTAL_DWELL_MIN
        FROM {SCHEMA}.DT_H3_CONGESTION
        WHERE HOUR_BUCKET = '{selected_hour}'
          AND VEHICLE_COUNT >= {min_vehicles}
    """)

    idx = hour_list.index(selected_hour)
    prev_hour = hour_list[idx - 1] if idx > 0 else None
    if prev_hour is not None:
        prev_data = run_query(f"""
            SELECT SUM(VEHICLE_COUNT) AS TOTAL_VEHICLES
            FROM {SCHEMA}.DT_H3_CONGESTION
            WHERE HOUR_BUCKET = '{prev_hour}'
              AND VEHICLE_COUNT >= {min_vehicles}
        """)
        prev_total = prev_data['TOTAL_VEHICLES'].iloc[0] if len(prev_data) > 0 else 0
    else:
        prev_total = None

    with col2:
        if len(data) == 0:
            st.info(f"No congestion data for {selected_hour} with >= {min_vehicles} vehicles.")
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
            )
            st.pydeck_chart(deck)

            curr_total = int(data['VEHICLE_COUNT'].sum())
            m1, m2 = st.columns(2)
            m1.metric("Active H3 cells", len(data))
            if prev_total is not None:
                delta_val = curr_total - int(prev_total or 0)
                m2.metric("Total vehicles in cells", f"{curr_total:,}", delta=f"{delta_val:+,} vs prev hour")
            else:
                m2.metric("Total vehicles in cells", f"{curr_total:,}")

            st.dataframe(
                data[['H3_CELL_R7', 'VEHICLE_COUNT', 'SESSION_COUNT', 'AVG_DWELL_MIN', 'TOTAL_DWELL_MIN']]
                .sort_values(color_metric, ascending=False).head(20),
                hide_index=True
            )
else:
    with col2:
        st.info("No congestion data available.")
