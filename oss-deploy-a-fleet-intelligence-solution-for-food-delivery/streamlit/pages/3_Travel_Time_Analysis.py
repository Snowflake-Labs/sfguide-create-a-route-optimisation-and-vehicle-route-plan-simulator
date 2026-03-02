import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import json
from snowflake.snowpark.context import get_active_session
from city_config import get_city, get_company, get_california_cities

COMPANY = get_company()

st.set_page_config(
    page_title=f"{COMPANY['name']} - Travel Time Analysis",
    layout="wide",
    initial_sidebar_state="expanded",
)

with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

st.logo('logo.svg')

session = get_active_session()

with st.sidebar:
    selected_city = st.selectbox("City", get_california_cities(), index=0)

CITY = get_city(selected_city)

st.markdown(f'''
<h0orange>{COMPANY["name"]}</h0orange><h0black> |</h0black><h0blue> California Travel Time Analysis</h0blue><BR>
<h1grey>Visualize reachable areas using ORS isochrones overlaid with H3 hexagon travel times — {CITY["name"]}</h1grey>
''', unsafe_allow_html=True)

st.divider()

res_table_map = {7: "CA_H3_RES7", 8: "CA_H3_RES8", 9: "CA_H3_RES9"}

with st.sidebar:
    st.header("Controls")

    resolution = st.selectbox(
        "H3 Resolution",
        options=[7, 8, 9],
        index=2,
        help="9 = last mile (~174m), 8 = delivery zone (~460m), 7 = long range (~1.2km)"
    )

    hex_table = res_table_map[resolution]

    travel_mode = st.selectbox(
        "Travel Mode",
        options=["driving-car", "cycling-regular", "foot-walking"],
        index=0
    )

    isochrone_minutes = st.slider(
        "Isochrone Range (minutes)",
        min_value=1,
        max_value=60,
        value=10,
        help="Max travel time boundary from origin (ORS limit: 60 min)"
    )

    show_isochrone_boundary = st.checkbox("Show Isochrone Boundary", value=True)

    @st.cache_data(ttl=300)
    def get_sample_hexagons(table_name, center_lon, center_lat, limit=100):
        query = f"""
        SELECT h3_index, lon, lat,
               ST_DISTANCE(centroid, ST_MAKEPOINT({center_lon}, {center_lat})) AS dist
        FROM OPENROUTESERVICE_SETUP.PUBLIC.{table_name}
        ORDER BY dist
        LIMIT {limit}
        """
        try:
            return session.sql(query).to_pandas()
        except:
            return pd.DataFrame()

    sample_hexes = get_sample_hexagons(hex_table, CITY["longitude"], CITY["latitude"])

    if not sample_hexes.empty:
        hex_options = sample_hexes["H3_INDEX"].tolist()
        selected_hex = st.selectbox(
            "Origin Hexagon",
            options=hex_options,
            index=0,
            help="Choose a hexagon as the origin point"
        )
    else:
        st.warning(f"No hexagons found in {hex_table}.")
        selected_hex = None

    st.divider()
    st.subheader("Legend")
    colors = ["#2ECC71", "#F39C12", "#FF6B35", "#E63946", "#8B0000"]
    labels = ["0-5 min", "5-10 min", "10-15 min", "15-20 min", "20+ min"]
    legend_html = ""
    for color, label in zip(colors, labels):
        legend_html += f'<div style="display:flex;align-items:center;margin-bottom:4px;"><div style="width:16px;height:16px;background-color:{color};margin-right:8px;border-radius:3px;"></div><span style="font-size:0.85rem;color:#6b7b86;">{label}</span></div>'
    st.markdown(legend_html, unsafe_allow_html=True)

if selected_hex:
    origin_row = sample_hexes[sample_hexes["H3_INDEX"] == selected_hex]
    if not origin_row.empty:
        origin_lon = float(origin_row.iloc[0]["LON"])
        origin_lat = float(origin_row.iloc[0]["LAT"])
    else:
        origin_lon = CITY["longitude"]
        origin_lat = CITY["latitude"]

    @st.cache_data(ttl=120)
    def get_isochrone_geojson(origin_lon, origin_lat, iso_minutes, mode):
        try:
            result = session.sql(f"""
                SELECT OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES(
                    '{mode}', {origin_lon}, {origin_lat}, {iso_minutes}
                )::VARCHAR AS geojson
            """).to_pandas()
            if not result.empty:
                return result.iloc[0]["GEOJSON"]
        except Exception as e:
            st.error(f"ORS Isochrone error: {e}")
        return None

    @st.cache_data(ttl=120)
    def get_hexagons_in_polygon(origin_hex, geojson_str, resolution, hex_table_name, travel_table_name, has_travel):
        geojson_obj = json.loads(geojson_str)
        geom_str = json.dumps(geojson_obj["features"][0]["geometry"])
        escaped_geom = geom_str.replace("'", "''")

        max_k = {9: 60, 8: 25, 7: 10}.get(resolution, 60)

        if has_travel:
            query = f"""
            WITH candidates AS (
                SELECT h.h3_index, h.lon, h.lat, h.centroid,
                       H3_GRID_DISTANCE('{origin_hex}', h.h3_index) AS ring_distance
                FROM {hex_table_name} h
                WHERE h.h3_index IN (
                    SELECT VALUE::VARCHAR FROM TABLE(FLATTEN(H3_GRID_DISK('{origin_hex}', {max_k})))
                )
            ),
            hexagons_in_isochrone AS (
                SELECT h3_index, lon, lat, ring_distance
                FROM candidates
                WHERE ST_CONTAINS(TO_GEOGRAPHY('{escaped_geom}'), centroid)
            ),
            with_travel_times AS (
                SELECT hx.*,
                    COALESCE(tt.travel_time_seconds,
                        hx.ring_distance * 60 * CASE {resolution}
                            WHEN 9 THEN 0.35 WHEN 8 THEN 0.9 WHEN 7 THEN 2.4 END
                    ) AS travel_time_seconds,
                    COALESCE(tt.travel_distance_meters,
                        hx.ring_distance * CASE {resolution}
                            WHEN 9 THEN 174 WHEN 8 THEN 460 WHEN 7 THEN 1220 END
                    ) AS travel_distance_meters
                FROM hexagons_in_isochrone hx
                LEFT JOIN {travel_table_name} tt
                    ON (tt.origin_h3 = '{origin_hex}' AND tt.dest_h3 = hx.h3_index)
                    OR (tt.dest_h3 = '{origin_hex}' AND tt.origin_h3 = hx.h3_index)
            )
            SELECT h3_index, lon, lat, ring_distance, travel_time_seconds,
                   ROUND(travel_time_seconds / 60, 1) AS travel_time_mins,
                   travel_distance_meters,
                   ROUND(travel_distance_meters / 1000, 2) AS travel_distance_km
            FROM with_travel_times
            ORDER BY travel_time_seconds
            """
        else:
            query = f"""
            WITH candidates AS (
                SELECT h.h3_index, h.lon, h.lat, h.centroid,
                       H3_GRID_DISTANCE('{origin_hex}', h.h3_index) AS ring_distance
                FROM {hex_table_name} h
                WHERE h.h3_index IN (
                    SELECT VALUE::VARCHAR FROM TABLE(FLATTEN(H3_GRID_DISK('{origin_hex}', {max_k})))
                )
            ),
            hexagons_in_isochrone AS (
                SELECT h3_index, lon, lat, ring_distance
                FROM candidates
                WHERE ST_CONTAINS(TO_GEOGRAPHY('{escaped_geom}'), centroid)
            )
            SELECT h3_index, lon, lat, ring_distance,
                   ring_distance * 60 * CASE {resolution}
                       WHEN 9 THEN 0.35 WHEN 8 THEN 0.9 WHEN 7 THEN 2.4 END
                   AS travel_time_seconds,
                   ROUND(ring_distance * 60 * CASE {resolution}
                       WHEN 9 THEN 0.35 WHEN 8 THEN 0.9 WHEN 7 THEN 2.4 END / 60, 1)
                   AS travel_time_mins,
                   ring_distance * CASE {resolution}
                       WHEN 9 THEN 174 WHEN 8 THEN 460 WHEN 7 THEN 1220 END
                   AS travel_distance_meters,
                   ROUND(ring_distance * CASE {resolution}
                       WHEN 9 THEN 174 WHEN 8 THEN 460 WHEN 7 THEN 1220 END / 1000, 2)
                   AS travel_distance_km
            FROM hexagons_in_isochrone
            ORDER BY travel_time_seconds
            """
        try:
            return session.sql(query).to_pandas()
        except Exception as e:
            st.error(f"Query error: {e}")
            return pd.DataFrame()

    def parse_iso_coords(geojson_str):
        iso_coords = []
        try:
            geojson = json.loads(geojson_str)
            if "features" in geojson and len(geojson["features"]) > 0:
                coords = geojson["features"][0]["geometry"]["coordinates"]
                if geojson["features"][0]["geometry"]["type"] == "Polygon":
                    iso_coords = [{"polygon": [{"lng": c[0], "lat": c[1]} for c in ring]} for ring in coords]
                elif geojson["features"][0]["geometry"]["type"] == "MultiPolygon":
                    for poly in coords:
                        for ring in poly:
                            iso_coords.append({"polygon": [{"lng": c[0], "lat": c[1]} for c in ring]})
        except:
            pass
        return iso_coords

    def get_isochrone_and_hexagons(origin_hex, origin_lon, origin_lat, resolution, iso_minutes, mode):
        hex_table = f"OPENROUTESERVICE_SETUP.PUBLIC.{res_table_map[resolution]}"
        travel_table_map = {7: "CA_TRAVEL_TIME_RES7", 8: "CA_TRAVEL_TIME_RES8", 9: "CA_TRAVEL_TIME_RES9"}
        travel_table = f"OPENROUTESERVICE_SETUP.PUBLIC.{travel_table_map[resolution]}"

        has_travel_table = False
        try:
            session.sql(f"SELECT 1 FROM {travel_table} LIMIT 0").collect()
            has_travel_table = True
        except:
            pass

        geojson_str = get_isochrone_geojson(origin_lon, origin_lat, iso_minutes, mode)
        if not geojson_str:
            return pd.DataFrame(), []

        iso_coords = parse_iso_coords(geojson_str)
        df = get_hexagons_in_polygon(origin_hex, geojson_str, resolution, hex_table, travel_table, has_travel_table)
        return df, iso_coords

    with st.spinner(f"Computing {isochrone_minutes}-min isochrone and filtering hexagons..."):
        df, iso_coords = get_isochrone_and_hexagons(
            selected_hex, origin_lon, origin_lat, resolution, isochrone_minutes, travel_mode
        )

    if not df.empty:
        def get_color(travel_mins):
            if travel_mins <= 5:
                return [46, 204, 113, 180]
            elif travel_mins <= 10:
                return [243, 156, 18, 180]
            elif travel_mins <= 15:
                return [255, 107, 53, 180]
            elif travel_mins <= 20:
                return [230, 57, 70, 180]
            else:
                return [139, 0, 0, 180]

        df["color"] = df["TRAVEL_TIME_MINS"].apply(get_color)

        st.markdown('<h1sub>Coverage Summary</h1sub>', unsafe_allow_html=True)

        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("Reachable Hexagons", f"{len(df):,}")
        with col2:
            st.metric("Avg Travel Time", f"{df['TRAVEL_TIME_MINS'].mean():.1f} min")
        with col3:
            st.metric("Max Travel Time", f"{df['TRAVEL_TIME_MINS'].max():.1f} min")
        with col4:
            area_per_hex = {9: 0.03, 8: 0.18, 7: 1.3}
            st.metric("Coverage Area", f"{len(df) * area_per_hex[resolution]:.1f} km\u00b2")

        st.divider()

        st.markdown('<h1sub>Isochrone Reachability Map</h1sub>', unsafe_allow_html=True)

        layers = []

        h3_layer = pdk.Layer(
            "H3HexagonLayer",
            df,
            pickable=True,
            stroked=True,
            filled=True,
            extruded=False,
            get_hexagon="H3_INDEX",
            get_fill_color="color",
            get_line_color=[255, 255, 255, 80],
            line_width_min_pixels=1,
            opacity=0.7,
        )
        layers.append(h3_layer)

        origin_df = df[df["H3_INDEX"] == selected_hex]
        if origin_df.empty:
            origin_df = pd.DataFrame([{
                "H3_INDEX": selected_hex, "LON": origin_lon, "LAT": origin_lat,
                "TRAVEL_TIME_MINS": 0, "TRAVEL_DISTANCE_KM": 0, "RING_DISTANCE": 0
            }])
        origin_layer = pdk.Layer(
            "H3HexagonLayer",
            origin_df,
            pickable=True,
            stroked=True,
            filled=True,
            extruded=False,
            get_hexagon="H3_INDEX",
            get_fill_color=[41, 181, 232, 220],
            get_line_color=[0, 0, 0, 255],
            line_width_min_pixels=3,
        )
        layers.append(origin_layer)

        if show_isochrone_boundary and iso_coords:
            iso_layer = pdk.Layer(
                "PolygonLayer",
                iso_coords,
                get_polygon="polygon",
                get_fill_color=[41, 181, 232, 20],
                get_line_color=[17, 86, 127, 200],
                line_width_min_pixels=2,
                stroked=True,
                filled=True,
                pickable=False,
            )
            layers.append(iso_layer)

        view_state = pdk.ViewState(
            latitude=origin_lat,
            longitude=origin_lon,
            zoom=12 if resolution == 9 else (11 if resolution == 8 else 10),
            pitch=0
        )

        tooltip = {
            "html": "<b>Hex:</b> {H3_INDEX}<br/><b>Travel Time:</b> {TRAVEL_TIME_MINS} min<br/><b>Distance:</b> {TRAVEL_DISTANCE_KM} km<br/><b>Ring:</b> {RING_DISTANCE}",
            "style": {
                "backgroundColor": "#24323D",
                "color": "white"
            }
        }

        deck = pdk.Deck(
            map_provider="carto",
            map_style="light",
            layers=layers,
            initial_view_state=view_state,
            tooltip=tooltip,
        )

        st.pydeck_chart(deck, use_container_width=True)

        st.divider()

        st.markdown('<h1sub>Travel Time Distribution</h1sub>', unsafe_allow_html=True)

        col1, col2 = st.columns(2)

        with col1:
            ring_stats = df.groupby("RING_DISTANCE").agg({
                "TRAVEL_TIME_MINS": ["mean", "min", "max", "count"]
            }).round(2)
            ring_stats.columns = ["Avg Time (min)", "Min Time", "Max Time", "Hexagons"]
            ring_stats = ring_stats.reset_index()
            ring_stats.columns = ["Ring", "Avg Time (min)", "Min Time", "Max Time", "Hexagons"]
            st.dataframe(ring_stats, use_container_width=True, hide_index=True)

        with col2:
            max_val = max(df["TRAVEL_TIME_MINS"].max(), 20)
            bins = [0, 5, 10, 15, 20, max_val + 1]
            bin_labels = ["0-5 min", "5-10 min", "10-15 min", "15-20 min", "20+ min"]
            df["time_bucket"] = pd.cut(df["TRAVEL_TIME_MINS"], bins=bins, labels=bin_labels)
            bucket_df = df["time_bucket"].value_counts().sort_index().reset_index()
            bucket_df.columns = ["Time Bucket", "Count"]

            chart = alt.Chart(bucket_df).mark_bar().encode(
                x=alt.X("Time Bucket:N", sort=bin_labels, title=None),
                y=alt.Y("Count:Q", title="Hexagons"),
                color=alt.value("#FF6B35"),
                tooltip=["Time Bucket", "Count"]
            ).properties(height=300)
            st.altair_chart(chart, use_container_width=True)

        with st.expander("View Detailed Data"):
            st.dataframe(
                df[["H3_INDEX", "RING_DISTANCE", "TRAVEL_TIME_MINS", "TRAVEL_DISTANCE_KM"]].sort_values("TRAVEL_TIME_MINS"),
                use_container_width=True,
                hide_index=True
            )
    else:
        st.warning("No hexagons found within the isochrone. Try increasing the range or check if hexagon data exists.")
else:
    st.info("Select an origin hexagon from the sidebar to begin analysis.")

st.divider()

st.markdown(f'''
<h1grey>Isochrone: {isochrone_minutes} min | Mode: {travel_mode} | H3 Resolution: {resolution} | Powered by Snowflake & OpenRouteService</h1grey>
''', unsafe_allow_html=True)
