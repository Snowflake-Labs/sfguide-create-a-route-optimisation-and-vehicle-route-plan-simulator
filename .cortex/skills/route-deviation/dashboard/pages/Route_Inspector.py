import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import json
from snowflake.snowpark.context import get_active_session

st.set_page_config(page_title="Route Inspector", layout="wide")

session = get_active_session()
SOURCE_SCHEMA = "SYNTHETIC_DATASETS.FLEET_INTELLIGENCE"
TARGET_SCHEMA = "FLEET_INTELLIGENCE.ROUTE_DEVIATION"

@st.cache_data(ttl=300)
def run_query(sql):
    return session.sql(sql).to_pandas()

st.title("Route Inspector")
st.caption("GPS point-level inspection with teleportation detection and quality filtering")

try:
    col1, col2 = st.columns(2)

    with col1:
        driver_ids = run_query(f"""
            SELECT DISTINCT TRUCK_ID FROM {TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS
            ORDER BY TRUCK_ID LIMIT 500
        """)['TRUCK_ID'].tolist()
        selected_driver = st.selectbox("Select Driver (Truck ID)", driver_ids)

    with col2:
        if selected_driver:
            trip_ids = run_query(f"""
                SELECT TRIP_ID, TRIP_DATE, ROUTE_VARIATION, DISTANCE_DEVIATION_PCT, IS_ROUTE_DEVIATION
                FROM {TARGET_SCHEMA}.TRIP_DEVIATION_ANALYSIS
                WHERE TRUCK_ID = '{selected_driver}'
                ORDER BY TRIP_DATE, TRIP_ID
            """)
            trip_labels = trip_ids.apply(
                lambda r: f"{r['TRIP_ID']} | {r['ROUTE_VARIATION']} | {r['DISTANCE_DEVIATION_PCT']:.1f}% dev {'⚠' if r['IS_ROUTE_DEVIATION'] else ''}",
                axis=1
            ).tolist()
            selected_idx = st.selectbox("Select Trip", range(len(trip_labels)), format_func=lambda i: trip_labels[i])
            selected_trip = trip_ids.iloc[selected_idx]['TRIP_ID']

    if selected_driver and selected_trip:
        st.divider()

        points = run_query(f"""
            SELECT TELEMETRY_ID, TS, LATITUDE, LONGITUDE, SPEED_KMH, HEADING_DEG,
                   POSTED_SPEED_KMH, STATUS, IS_SPEEDING, IS_DETOUR,
                   GPS_ACCURACY_M, LOCATION_ID, LOCATION_TYPE
            FROM {SOURCE_SCHEMA}.FACT_TRUCK_TELEMETRY
            WHERE TRIP_ID = '{selected_trip}'
            ORDER BY TS
        """)

        st.markdown(f"**{len(points)} GPS points** for trip `{selected_trip}`")

        if len(points) > 1:
            points['PREV_LAT'] = points['LATITUDE'].shift(1)
            points['PREV_LNG'] = points['LONGITUDE'].shift(1)
            points['PREV_TS'] = points['TS'].shift(1)
            points['TIME_DELTA_S'] = (pd.to_datetime(points['TS']) - pd.to_datetime(points['PREV_TS'])).dt.total_seconds()

            import math
            def haversine_m(lat1, lon1, lat2, lon2):
                if pd.isna(lat1) or pd.isna(lat2):
                    return 0
                R = 6371000
                phi1, phi2 = math.radians(lat1), math.radians(lat2)
                dphi = math.radians(lat2 - lat1)
                dlam = math.radians(lon2 - lon1)
                a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlam/2)**2
                return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

            points['DIST_M'] = points.apply(
                lambda r: haversine_m(r['PREV_LAT'], r['PREV_LNG'], r['LATITUDE'], r['LONGITUDE']), axis=1
            )
            points['CALC_SPEED_KMH'] = points.apply(
                lambda r: (r['DIST_M'] / r['TIME_DELTA_S'] * 3.6) if r['TIME_DELTA_S'] and r['TIME_DELTA_S'] > 0 else 0, axis=1
            )
            points['IS_TELEPORT'] = (points['CALC_SPEED_KMH'] > 200) & (points['DIST_M'] > 5000)

            teleport_count = points['IS_TELEPORT'].sum()
            detour_count = points['IS_DETOUR'].sum() if 'IS_DETOUR' in points.columns else 0
            speeding_count = points['IS_SPEEDING'].sum() if 'IS_SPEEDING' in points.columns else 0

            m1, m2, m3, m4, m5 = st.columns(5)
            m1.metric("GPS Points", f"{len(points):,}")
            m2.metric("Teleportations", f"{teleport_count}", delta="anomaly" if teleport_count > 0 else None, delta_color="inverse")
            m3.metric("Detour Points", f"{detour_count}")
            m4.metric("Speeding Points", f"{speeding_count}")
            m5.metric("Avg GPS Accuracy", f"{points['GPS_ACCURACY_M'].mean():.1f} m")

            st.divider()

            filter_col1, filter_col2 = st.columns(2)
            with filter_col1:
                show_teleports = st.checkbox("Highlight teleportations", value=True)
                hide_teleports = st.checkbox("Hide teleported points", value=False)
            with filter_col2:
                show_detours = st.checkbox("Highlight detour points", value=True)
                min_accuracy = st.slider("Max GPS accuracy (m)", 0, 100, 50)

            display_points = points.copy()
            if hide_teleports:
                display_points = display_points[~display_points['IS_TELEPORT']]
            if min_accuracy < 100:
                display_points = display_points[display_points['GPS_ACCURACY_M'] <= min_accuracy]

            st.subheader("GPS Track Map")

            normal_pts = display_points[~display_points.get('IS_TELEPORT', False) & ~display_points.get('IS_DETOUR', False)]
            map_layers = []

            if len(normal_pts) > 0:
                map_layers.append(pdk.Layer(
                    "ScatterplotLayer", data=normal_pts,
                    get_position=['LONGITUDE', 'LATITUDE'],
                    get_color=[41, 181, 232, 160], get_radius=30,
                    pickable=True
                ))

            if show_teleports and not hide_teleports:
                teleport_pts = display_points[display_points['IS_TELEPORT']]
                if len(teleport_pts) > 0:
                    map_layers.append(pdk.Layer(
                        "ScatterplotLayer", data=teleport_pts,
                        get_position=['LONGITUDE', 'LATITUDE'],
                        get_color=[231, 76, 60, 220], get_radius=80,
                        pickable=True
                    ))

            if show_detours:
                detour_pts = display_points[display_points['IS_DETOUR'] == True]
                if len(detour_pts) > 0:
                    map_layers.append(pdk.Layer(
                        "ScatterplotLayer", data=detour_pts,
                        get_position=['LONGITUDE', 'LATITUDE'],
                        get_color=[243, 156, 18, 200], get_radius=50,
                        pickable=True
                    ))

            if len(display_points) > 1:
                path_coords = display_points[['LONGITUDE', 'LATITUDE']].values.tolist()
                path_df = pd.DataFrame([{'path': path_coords}])
                map_layers.insert(0, pdk.Layer(
                    "PathLayer", data=path_df, get_path='path',
                    get_color=[100, 100, 100, 100], width_min_pixels=1
                ))

            if map_layers and len(display_points) > 0:
                center_lat = display_points['LATITUDE'].mean()
                center_lon = display_points['LONGITUDE'].mean()
                deck = pdk.Deck(
                    map_provider="carto", map_style="light",
                    initial_view_state=pdk.ViewState(latitude=center_lat, longitude=center_lon, zoom=10, pitch=0),
                    layers=map_layers,
                    tooltip={"html": "<b>Time:</b> {TS}<br/><b>Speed:</b> {SPEED_KMH} km/h<br/><b>Status:</b> {STATUS}<br/><b>Accuracy:</b> {GPS_ACCURACY_M}m"},
                    height=500
                )
                st.pydeck_chart(deck, use_container_width=True)
                st.caption("Blue = normal | Red = teleportation | Orange = detour")

            st.divider()

            col_speed, col_accuracy = st.columns(2)

            with col_speed:
                st.subheader("Speed Profile")
                speed_df = display_points[['TS', 'SPEED_KMH', 'POSTED_SPEED_KMH', 'CALC_SPEED_KMH']].copy()
                speed_df['TS'] = pd.to_datetime(speed_df['TS'])
                base = alt.Chart(speed_df).encode(x=alt.X('TS:T', title='Time'))
                actual = base.mark_line(color='#29B5E8', strokeWidth=1).encode(y=alt.Y('SPEED_KMH:Q', title='Speed (km/h)'))
                posted = base.mark_line(color='#E74C3C', strokeDash=[4,4], strokeWidth=1).encode(y='POSTED_SPEED_KMH:Q')
                st.altair_chart((actual + posted).properties(height=250), use_container_width=True)
                st.caption("Blue = actual speed | Red dashed = posted speed limit")

            with col_accuracy:
                st.subheader("GPS Accuracy Over Time")
                acc_df = display_points[['TS', 'GPS_ACCURACY_M']].copy()
                acc_df['TS'] = pd.to_datetime(acc_df['TS'])
                acc_chart = alt.Chart(acc_df).mark_area(color='#29B5E8', opacity=0.3).encode(
                    x=alt.X('TS:T', title='Time'),
                    y=alt.Y('GPS_ACCURACY_M:Q', title='Accuracy (m)')
                ).properties(height=250)
                st.altair_chart(acc_chart, use_container_width=True)

            st.divider()

            st.subheader("Point-Level Data")
            display_table_cols = ['TS', 'LATITUDE', 'LONGITUDE', 'SPEED_KMH', 'CALC_SPEED_KMH',
                                  'STATUS', 'IS_SPEEDING', 'IS_DETOUR', 'IS_TELEPORT',
                                  'GPS_ACCURACY_M', 'LOCATION_TYPE']
            available = [c for c in display_table_cols if c in display_points.columns]
            st.dataframe(display_points[available], use_container_width=True, hide_index=True, height=400)

except Exception as e:
    st.error(f"Error loading data: {e}")
    st.info("Ensure the ETL pipeline has been run and tables exist in FLEET_INTELLIGENCE.ROUTE_DEVIATION")
