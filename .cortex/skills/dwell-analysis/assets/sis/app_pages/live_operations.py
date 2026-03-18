import streamlit as st
import pandas as pd
import pydeck as pdk
from snowflake.snowpark.context import get_active_session

session = get_active_session()
SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_data(ttl=60)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("Live operations")
st.caption("Control tower view — latest vehicle states, open dwell sessions, and event stream")

latest_positions = run_query(f"""
    SELECT TRUCK_ID, STATUS, LATITUDE, LONGITUDE, SPEED_KMH, TS
    FROM {SCHEMA}.DT_STATE_CHANGES
    QUALIFY ROW_NUMBER() OVER (PARTITION BY TRUCK_ID ORDER BY TS DESC) = 1
""")

status_colors = {
    'MOVING': [30, 144, 255, 200],
    'IDLE': [160, 160, 160, 180],
    'DWELL_WAREHOUSE': [255, 69, 0, 200],
    'DWELL_DESTINATION': [50, 205, 50, 200],
    'DWELL_REST_STOP': [255, 165, 0, 200],
    'DWELL_STORE': [148, 103, 189, 200],
    'DWELL_DETOUR': [220, 20, 60, 200],
}

status_counts = latest_positions['STATUS'].value_counts()
cols = st.columns(min(len(status_counts), 7))
for i, (status, cnt) in enumerate(status_counts.items()):
    if i < len(cols):
        cols[i].metric(status.replace('_', ' ').title(), cnt)

latest_positions['color'] = latest_positions['STATUS'].map(
    lambda s: status_colors.get(s, [128, 128, 128, 180])
)
latest_positions['radius'] = latest_positions['STATUS'].apply(
    lambda s: 800 if s.startswith('DWELL') else (400 if s == 'IDLE' else 300)
)

scatter = pdk.Layer(
    "ScatterplotLayer",
    latest_positions,
    get_position=["LONGITUDE", "LATITUDE"],
    get_radius="radius",
    get_fill_color="color",
    pickable=True,
)

view = pdk.ViewState(latitude=51.1657, longitude=10.4515, zoom=6, pitch=0)

deck = pdk.Deck(
    layers=[scatter],
    initial_view_state=view,
    tooltip={"text": "{TRUCK_ID}\n{STATUS}\nSpeed: {SPEED_KMH} km/h\n{TS}"},
)
st.pydeck_chart(deck)

st.divider()

col_left, col_right = st.columns(2)

with col_left:
    st.subheader("Open dwell sessions with SLA countdown")
    open_dwells = run_query(f"""
        SELECT TRUCK_ID, STATUS, LOCATION_NAME, CITY,
               SESSION_START, DWELL_MINUTES, SLA_STATUS,
               WARNING_MINUTES, CRITICAL_MINUTES,
               GREATEST(WARNING_MINUTES - DWELL_MINUTES, 0) AS MINS_TO_WARNING,
               GREATEST(CRITICAL_MINUTES - DWELL_MINUTES, 0) AS MINS_TO_CRITICAL
        FROM {SCHEMA}.DT_SLA_ALERTS
        ORDER BY DWELL_MINUTES DESC
        LIMIT 50
    """)

    if len(open_dwells) > 0:
        st.dataframe(open_dwells, hide_index=True, height=400)
    else:
        st.info("No active SLA alerts.")

with col_right:
    st.subheader("Recent state transitions")
    events = run_query(f"""
        SELECT TRUCK_ID, PREV_STATUS, STATUS, TS, LOCATION_ID
        FROM {SCHEMA}.DT_STATE_CHANGES
        WHERE IS_STATE_CHANGE = 1
        ORDER BY TS DESC
        LIMIT 100
    """)

    if len(events) > 0:
        st.dataframe(events, hide_index=True, height=400)
    else:
        st.info("No recent state transitions.")
