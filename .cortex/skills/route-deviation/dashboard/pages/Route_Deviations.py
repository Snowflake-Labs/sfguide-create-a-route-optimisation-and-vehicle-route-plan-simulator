import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import json
from snowflake.snowpark.context import get_active_session

st.set_page_config(page_title="Route Deviations", layout="wide")

session = get_active_session()
SCHEMA = "FLEET_INTELLIGENCE.ROUTE_DEVIATION"

@st.cache_data(ttl=300)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("Route Deviations")
st.caption("Trip-level deviation analysis with expected vs actual route comparison")

try:
    col_filter1, col_filter2, col_filter3 = st.columns(3)

    with col_filter1:
        variation_opts = ['All'] + run_query(f"""
            SELECT DISTINCT ROUTE_VARIATION FROM {SCHEMA}.TRIP_DEVIATION_ANALYSIS ORDER BY 1
        """)['ROUTE_VARIATION'].tolist()
        selected_variation = st.selectbox("Route Variation", variation_opts)

    with col_filter2:
        profile_opts = ['All'] + run_query(f"""
            SELECT DISTINCT DRIVER_PROFILE FROM {SCHEMA}.DRIVER_DEVIATION_SUMMARY ORDER BY 1
        """)['DRIVER_PROFILE'].tolist()
        selected_profile = st.selectbox("Driver Profile", profile_opts)

    with col_filter3:
        deviation_only = st.checkbox("Show deviations only", value=False)

    where_clauses = []
    if selected_variation != 'All':
        where_clauses.append(f"t.ROUTE_VARIATION = '{selected_variation}'")
    if selected_profile != 'All':
        where_clauses.append(f"d.DRIVER_PROFILE = '{selected_profile}'")
    if deviation_only:
        where_clauses.append("t.IS_ROUTE_DEVIATION = TRUE")

    where_sql = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""

    trips = run_query(f"""
        SELECT t.TRIP_ID, t.TRUCK_ID, t.DRIVER_ID, t.TRIP_DATE, t.ROUTE_VARIATION,
               t.TRIP_TYPE, t.ACTUAL_DISTANCE_KM, t.EXPECTED_DISTANCE_KM,
               t.DISTANCE_DEVIATION_KM, t.DISTANCE_DEVIATION_PCT,
               t.ACTUAL_DURATION_MIN, t.EXPECTED_DURATION_MIN,
               t.DURATION_DEVIATION_MIN, t.DURATION_DEVIATION_PCT,
               t.IS_ROUTE_DEVIATION,
               t.ORIGIN_NAME, t.ORIGIN_CITY, t.DEST_NAME, t.DEST_CITY,
               d.DRIVER_PROFILE, d.HOME_CITY,
               ST_ASGEOJSON(t.ACTUAL_PATH) AS ACTUAL_GEOJSON,
               ST_ASGEOJSON(t.EXPECTED_PATH) AS EXPECTED_GEOJSON
        FROM {SCHEMA}.TRIP_DEVIATION_ANALYSIS t
        LEFT JOIN {SCHEMA}.DRIVER_DEVIATION_SUMMARY d ON t.TRUCK_ID = d.TRUCK_ID
        {where_sql}
        ORDER BY t.DISTANCE_DEVIATION_PCT DESC
        LIMIT 200
    """)

    st.markdown(f"**{len(trips)} trips** matching filters")

    st.divider()

    col_chart1, col_chart2 = st.columns(2)

    with col_chart1:
        st.subheader("Distance Deviation Distribution")
        hist = alt.Chart(trips).mark_bar(color='#29B5E8').encode(
            x=alt.X('DISTANCE_DEVIATION_PCT:Q', bin=alt.Bin(maxbins=30), title='Distance Deviation (%)'),
            y=alt.Y('count():Q', title='Trip Count'),
            tooltip=['count()']
        ).properties(height=250)
        rule = alt.Chart(pd.DataFrame({'x': [20]})).mark_rule(color='#FF4B4B', strokeDash=[4, 4]).encode(x='x:Q')
        rule_neg = alt.Chart(pd.DataFrame({'x': [-20]})).mark_rule(color='#FF4B4B', strokeDash=[4, 4]).encode(x='x:Q')
        st.altair_chart(hist + rule + rule_neg, use_container_width=True)

    with col_chart2:
        st.subheader("Duration vs Distance Deviation")
        scatter = alt.Chart(trips).mark_circle(size=40, opacity=0.6).encode(
            x=alt.X('DISTANCE_DEVIATION_PCT:Q', title='Distance Deviation (%)'),
            y=alt.Y('DURATION_DEVIATION_PCT:Q', title='Duration Deviation (%)'),
            color=alt.Color('ROUTE_VARIATION:N', scale=alt.Scale(
                domain=['OPTIMAL', 'MINOR_DEVIATION', 'MEDIUM_DEVIATION', 'MAJOR_DEVIATION'],
                range=['#2ECC71', '#F39C12', '#E67E22', '#E74C3C']
            )),
            tooltip=['TRIP_ID', 'DRIVER_ID', 'ROUTE_VARIATION', 'DISTANCE_DEVIATION_PCT', 'DURATION_DEVIATION_PCT']
        ).properties(height=250)
        st.altair_chart(scatter, use_container_width=True)

    st.divider()

    st.subheader("Trip Details")
    display_cols = ['TRIP_ID', 'DRIVER_ID', 'DRIVER_PROFILE', 'TRIP_DATE', 'ROUTE_VARIATION',
                    'ORIGIN_CITY', 'DEST_CITY', 'EXPECTED_DISTANCE_KM', 'ACTUAL_DISTANCE_KM',
                    'DISTANCE_DEVIATION_PCT', 'EXPECTED_DURATION_MIN', 'ACTUAL_DURATION_MIN',
                    'DURATION_DEVIATION_PCT', 'IS_ROUTE_DEVIATION']
    available_cols = [c for c in display_cols if c in trips.columns]
    st.dataframe(trips[available_cols], use_container_width=True, hide_index=True)

    st.divider()

    st.subheader("Route Map Comparison")
    st.caption("Select a trip to visualize expected (blue) vs actual (red) route")

    trip_ids = trips['TRIP_ID'].tolist()
    if trip_ids:
        selected_trip = st.selectbox("Select Trip", trip_ids)
        trip_row = trips[trips['TRIP_ID'] == selected_trip].iloc[0]

        info_cols = st.columns(6)
        info_cols[0].metric("Driver", trip_row['DRIVER_ID'])
        info_cols[1].metric("Profile", trip_row.get('DRIVER_PROFILE', 'N/A'))
        info_cols[2].metric("Expected km", f"{trip_row['EXPECTED_DISTANCE_KM']:.1f}")
        info_cols[3].metric("Actual km", f"{trip_row['ACTUAL_DISTANCE_KM']:.1f}")
        info_cols[4].metric("Dist Dev %", f"{trip_row['DISTANCE_DEVIATION_PCT']:.1f}%")
        info_cols[5].metric("Deviation?", "YES" if trip_row['IS_ROUTE_DEVIATION'] else "No")

        layers = []

        if trip_row['EXPECTED_GEOJSON'] and trip_row['EXPECTED_GEOJSON'] != 'null':
            expected_coords = json.loads(trip_row['EXPECTED_GEOJSON']).get('coordinates', [])
            if expected_coords:
                expected_df = pd.DataFrame([{'path': expected_coords, 'type': 'Expected'}])
                layers.append(pdk.Layer(
                    "PathLayer", data=expected_df, get_path='path',
                    get_color=[41, 181, 232, 180], width_min_pixels=4, pickable=True
                ))

        if trip_row['ACTUAL_GEOJSON'] and trip_row['ACTUAL_GEOJSON'] != 'null':
            actual_coords = json.loads(trip_row['ACTUAL_GEOJSON']).get('coordinates', [])
            if actual_coords:
                actual_df = pd.DataFrame([{'path': actual_coords, 'type': 'Actual'}])
                layers.append(pdk.Layer(
                    "PathLayer", data=actual_df, get_path='path',
                    get_color=[231, 76, 60, 180], width_min_pixels=3, pickable=True
                ))

        if layers:
            all_coords = []
            if trip_row['EXPECTED_GEOJSON'] and trip_row['EXPECTED_GEOJSON'] != 'null':
                all_coords.extend(json.loads(trip_row['EXPECTED_GEOJSON']).get('coordinates', []))
            if trip_row['ACTUAL_GEOJSON'] and trip_row['ACTUAL_GEOJSON'] != 'null':
                all_coords.extend(json.loads(trip_row['ACTUAL_GEOJSON']).get('coordinates', []))

            if all_coords:
                lons = [c[0] for c in all_coords]
                lats = [c[1] for c in all_coords]
                center_lon = (min(lons) + max(lons)) / 2
                center_lat = (min(lats) + max(lats)) / 2

                deck = pdk.Deck(
                    map_provider="carto", map_style="light",
                    initial_view_state=pdk.ViewState(latitude=center_lat, longitude=center_lon, zoom=8, pitch=0),
                    layers=layers,
                    tooltip={"text": "{type} route"},
                    height=500
                )
                st.pydeck_chart(deck, use_container_width=True)
                st.caption("Blue = expected ORS route | Red = actual GPS path")
        else:
            st.info("No route geometry available for this trip")

except Exception as e:
    st.error(f"Error loading data: {e}")
    st.info("Ensure the ETL pipeline has been run and tables exist in FLEET_INTELLIGENCE.ROUTE_DEVIATION")
