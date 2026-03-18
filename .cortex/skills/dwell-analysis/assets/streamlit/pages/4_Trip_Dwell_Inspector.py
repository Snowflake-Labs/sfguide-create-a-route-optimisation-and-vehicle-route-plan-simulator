import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import os
import snowflake.connector

st.set_page_config(page_title="Trip Dwell Inspector", layout="wide")

SCHEMA = "FLEET_INTELLIGENCE.DWELL_ANALYSIS"

@st.cache_resource
def get_connection():
    return snowflake.connector.connect(
        connection_name=os.getenv("SNOWFLAKE_CONNECTION_NAME")
    )

def run_query(sql, params=None):
    conn = get_connection()
    return pd.read_sql(sql, conn, params=params)

st.title("Trip Dwell Inspector")
st.caption("Explore individual truck dwell sessions on a map")

col1, col2 = st.columns([1, 3])

with col1:
    trucks = run_query(f"""
        SELECT DISTINCT TRUCK_ID FROM {SCHEMA}.DT_DWELL_ENRICHED 
        WHERE STATUS LIKE 'DWELL%' ORDER BY TRUCK_ID LIMIT 500
    """)
    selected_truck = st.selectbox("Select Truck", trucks['TRUCK_ID'].tolist())

    dates = run_query(f"""
        SELECT DISTINCT DATE_TRUNC('day', SESSION_START)::DATE AS D 
        FROM {SCHEMA}.DT_DWELL_ENRICHED
        WHERE TRUCK_ID = %s AND STATUS LIKE 'DWELL%%'
        ORDER BY D
    """, params=[selected_truck])
    if len(dates) > 0:
        selected_date = st.selectbox("Select Date", dates['D'].tolist())
    else:
        selected_date = None
        st.warning("No dwell data for this truck.")

    status_filter = st.multiselect("Dwell Types",
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
            WHERE TRUCK_ID = %s
              AND DATE_TRUNC('day', SESSION_START)::DATE = %s
              AND STATUS IN ({stat_str})
              AND DWELL_MINUTES > 0
            ORDER BY SESSION_START
        """, params=[selected_truck, str(selected_date)])

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
                tooltip={"text": "{LOCATION_NAME}\n{STATUS}\nDwell: {DWELL_MINUTES} min\n{SESSION_START} → {SESSION_END}"},
                map_style="mapbox://styles/mapbox/light-v10"
            )
            st.pydeck_chart(deck)

            st.subheader(f"Dwell Sessions: {selected_truck} on {selected_date}")
            c1, c2, c3 = st.columns(3)
            c1.metric("Sessions", len(sessions))
            c2.metric("Total Dwell", f"{sessions['DWELL_MINUTES'].sum():.0f} min")
            c3.metric("Avg Dwell", f"{sessions['DWELL_MINUTES'].mean():.1f} min")

            timeline = alt.Chart(sessions).mark_bar().encode(
                x=alt.X('SESSION_START:T', title='Time'),
                x2='SESSION_END:T',
                y=alt.Y('STATUS:N', title='Dwell Type'),
                color=alt.Color('STATUS:N', scale=alt.Scale(scheme='category10')),
                tooltip=['LOCATION_NAME:N', 'STATUS:N', 'DWELL_MINUTES:Q', 'SESSION_START:T', 'SESSION_END:T']
            ).properties(height=200)
            st.altair_chart(timeline, use_container_width=True)

            st.dataframe(
                sessions[['SESSION_START', 'SESSION_END', 'STATUS', 'LOCATION_NAME', 'CITY',
                          'DWELL_MINUTES', 'PING_COUNT', 'H3_CELL_R7']],
                use_container_width=True, hide_index=True
            )
    else:
        st.info("Select a truck, date, and at least one dwell type to inspect.")
