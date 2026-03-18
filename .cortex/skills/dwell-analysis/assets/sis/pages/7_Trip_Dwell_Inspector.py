import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
from snowflake.snowpark.context import get_active_session

session = get_active_session()
SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_data(ttl=300)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("Trip dwell inspector")
st.caption("Explore individual truck dwell sessions on a map")

col1, col2 = st.columns([1, 3])

with col1:
    trucks = run_query(f"""
        SELECT DISTINCT TRUCK_ID FROM {SCHEMA}.DT_DWELL_ENRICHED
        WHERE STATUS LIKE 'DWELL%' ORDER BY TRUCK_ID LIMIT 500
    """)
    selected_truck = st.selectbox("Select truck", trucks['TRUCK_ID'].tolist())

    dates = run_query(f"""
        SELECT DISTINCT DATE_TRUNC('day', SESSION_START)::DATE AS D
        FROM {SCHEMA}.DT_DWELL_ENRICHED
        WHERE TRUCK_ID = '{selected_truck}' AND STATUS LIKE 'DWELL%'
        ORDER BY D
    """)
    if len(dates) > 0:
        selected_date = st.selectbox("Select date", dates['D'].tolist())
    else:
        selected_date = None
        st.warning("No dwell data for this truck.")

    status_filter = st.multiselect("Dwell types",
        ["DWELL_WAREHOUSE", "DWELL_DESTINATION", "DWELL_REST_STOP", "DWELL_STORE", "DWELL_DETOUR"],
        default=["DWELL_WAREHOUSE", "DWELL_DESTINATION", "DWELL_REST_STOP", "DWELL_STORE"])

with col2:
    if selected_date and status_filter:
        stat_str = ",".join([f"'{s}'" for s in status_filter])
        sessions = run_query(f"""
            SELECT TRUCK_ID, STATUS, LOCATION_ID, LOCATION_NAME, CITY, FACILITY_TYPE,
                   SESSION_START, SESSION_END, DWELL_MINUTES, PING_COUNT,
                   AVG_LAT, AVG_LNG, H3_CELL_R7, DRIVER_PROFILE
            FROM {SCHEMA}.DT_DWELL_ENRICHED
            WHERE TRUCK_ID = '{selected_truck}'
              AND DATE_TRUNC('day', SESSION_START)::DATE = '{selected_date}'
              AND STATUS IN ({stat_str})
              AND DWELL_MINUTES > 0
            ORDER BY SESSION_START
        """)

        if len(sessions) == 0:
            st.info("No dwell sessions for the selected truck/date combination.")
        else:
            color_map = {
                'DWELL_WAREHOUSE': [65, 105, 225, 200],
                'DWELL_DESTINATION': [50, 205, 50, 200],
                'DWELL_REST_STOP': [255, 165, 0, 200],
                'DWELL_STORE': [148, 103, 189, 200],
                'DWELL_DETOUR': [255, 69, 0, 200],
            }
            sessions['color'] = sessions['STATUS'].map(lambda s: color_map.get(s, [128, 128, 128, 200]))
            sessions['radius'] = sessions['DWELL_MINUTES'].clip(lower=5) * 10

            scatter = pdk.Layer(
                "ScatterplotLayer",
                sessions,
                get_position=["AVG_LNG", "AVG_LAT"],
                get_radius="radius",
                get_fill_color="color",
                pickable=True,
            )

            center_lat = sessions['AVG_LAT'].mean()
            center_lng = sessions['AVG_LNG'].mean()
            view = pdk.ViewState(latitude=center_lat, longitude=center_lng, zoom=8, pitch=0)

            deck = pdk.Deck(
                layers=[scatter],
                initial_view_state=view,
                tooltip={"text": "{LOCATION_NAME}\n{STATUS}\nDwell: {DWELL_MINUTES} min\n{SESSION_START} -> {SESSION_END}"},
            )
            st.pydeck_chart(deck)

            st.subheader(f"Dwell sessions: {selected_truck} on {selected_date}")
            c1, c2, c3 = st.columns(3)
            c1.metric("Sessions", len(sessions))
            c2.metric("Total dwell", f"{sessions['DWELL_MINUTES'].sum():.0f} min")
            c3.metric("Avg dwell", f"{sessions['DWELL_MINUTES'].mean():.1f} min")

            timeline = alt.Chart(sessions).mark_bar().encode(
                x=alt.X('SESSION_START:T', title='Time'),
                x2='SESSION_END:T',
                y=alt.Y('STATUS:N', title='Dwell type'),
                color=alt.Color('STATUS:N', scale=alt.Scale(scheme='category10')),
                tooltip=['LOCATION_NAME:N', 'STATUS:N', 'DWELL_MINUTES:Q', 'SESSION_START:T', 'SESSION_END:T']
            ).properties(height=200)
            st.altair_chart(timeline, use_container_width=True)

            st.dataframe(
                sessions[['SESSION_START', 'SESSION_END', 'STATUS', 'LOCATION_NAME', 'CITY',
                          'DWELL_MINUTES', 'PING_COUNT', 'H3_CELL_R7']],

            )
    else:
        st.info("Select a truck, date, and at least one dwell type to inspect.")
