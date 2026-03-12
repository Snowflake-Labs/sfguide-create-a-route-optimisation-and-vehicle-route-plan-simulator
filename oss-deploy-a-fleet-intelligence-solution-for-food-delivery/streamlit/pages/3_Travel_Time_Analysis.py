import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
import json
import math
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

TRAVEL_MATRIX_TABLE = "OPENROUTESERVICE_SETUP.ROUTING.SF_TRAVEL_TIME_MATRIX"
SF_HEXAGONS_TABLE = "OPENROUTESERVICE_SETUP.ROUTING.SF_HEXAGONS"
ORS_APP = "OPENROUTESERVICE_NATIVE_APP"

BAND_COLORS = [
    [46, 204, 113],
    [41, 181, 232],
    [243, 156, 18],
    [255, 107, 53],
    [230, 57, 70],
    [139, 0, 0],
    [125, 68, 207],
    [212, 91, 144],
    [0, 53, 69],
    [100, 100, 100],
]

with st.sidebar:
    selected_city = st.selectbox("City", get_california_cities(), index=0)

CITY = get_city(selected_city)

st.markdown(f'''
<h0orange>{COMPANY["name"]}</h0orange><h0black> |</h0black><h0blue> Travel Time Analysis</h0blue><BR>
<h1grey>Isochrone bands with real ORS travel times overlaid on H3 hexagons — {CITY["name"]}</h1grey>
''', unsafe_allow_html=True)

st.divider()

def minutes_breakpoints(max_mins, n):
    if n <= 1:
        return [max_mins]
    step = max(1, math.floor(max_mins / n))
    values = [step * i for i in range(1, n + 1)]
    if values[-1] != max_mins:
        values[-1] = max_mins
    return values

with st.sidebar:
    st.header("Controls")

    resolution = st.selectbox(
        "H3 Resolution",
        options=[7, 8, 9],
        index=2,
        help="9 = last mile (~174m), 8 = delivery zone (~460m), 7 = long range (~1.2km)"
    )

    travel_mode = "driving-car"

    isochrone_minutes = st.slider(
        "Max Travel Time (minutes)",
        min_value=2,
        max_value=60,
        value=10,
        help="Max travel time boundary from origin (ORS limit: 60 min)"
    )

    num_bands = st.slider(
        "Number of Time Bands",
        min_value=2,
        max_value=10,
        value=5,
        help="How many concentric isochrone bands to generate"
    )

    show_isochrone_boundary = st.checkbox("Show Isochrone Boundaries", value=True)

    band_minutes = minutes_breakpoints(isochrone_minutes, num_bands)

    res_table_map = {7: "CA_H3_RES7", 8: "CA_H3_RES8", 9: "CA_H3_RES9"}

    @st.cache_data(ttl=300)
    def get_origin_hexagons(center_lon, center_lat, res, limit=100):
        table = f"OPENROUTESERVICE_SETUP.PUBLIC.{res_table_map[res]}"
        query = f"""
        SELECT h3_index AS HEX_ID, lon AS LON, lat AS LAT,
               ST_DISTANCE(centroid, ST_MAKEPOINT({center_lon}, {center_lat})) AS dist
        FROM {table}
        ORDER BY dist
        LIMIT {limit}
        """
        try:
            return session.sql(query).to_pandas()
        except:
            return pd.DataFrame()

    sample_hexes = get_origin_hexagons(CITY["longitude"], CITY["latitude"], resolution)

    if not sample_hexes.empty:
        hex_options = sample_hexes["HEX_ID"].tolist()
        selected_hex = st.selectbox(
            "Origin Hexagon",
            options=hex_options,
            index=0,
            help="Choose a hexagon as the origin point"
        )
    else:
        st.warning("No SF hexagons found.")
        selected_hex = None

    st.divider()
    st.subheader("Legend")
    legend_html = '<div style="display:flex;align-items:center;margin-bottom:4px;"><div style="width:16px;height:16px;background-color:rgb(41,181,232);margin-right:8px;border-radius:3px;border:2px solid black;"></div><span style="font-size:0.85rem;color:#6b7b86;">Origin</span></div>'
    prev = 0
    for i, mins in enumerate(band_minutes):
        c = BAND_COLORS[i % len(BAND_COLORS)]
        label = f"{prev}-{mins} min"
        legend_html += f'<div style="display:flex;align-items:center;margin-bottom:4px;"><div style="width:16px;height:16px;background-color:rgb({c[0]},{c[1]},{c[2]});margin-right:8px;border-radius:3px;"></div><span style="font-size:0.85rem;color:#6b7b86;">{label}</span></div>'
        prev = mins
    st.markdown(legend_html, unsafe_allow_html=True)

if selected_hex:
    origin_row = sample_hexes[sample_hexes["HEX_ID"] == selected_hex]
    if not origin_row.empty:
        origin_lon = float(origin_row.iloc[0]["LON"])
        origin_lat = float(origin_row.iloc[0]["LAT"])
    else:
        origin_lon = CITY["longitude"]
        origin_lat = CITY["latitude"]

    @st.cache_data(ttl=120)
    def build_isochrone(mode, lon, lat, minutes):
        try:
            result = session.sql(f"""
                SELECT {ORS_APP}.CORE.ISOCHRONES(
                    '{mode}', {lon}, {lat}, {minutes}
                )::VARCHAR AS geojson
            """).to_pandas()
            if not result.empty and result.iloc[0]["GEOJSON"]:
                geojson = json.loads(result.iloc[0]["GEOJSON"])
                geom = geojson["features"][0]["geometry"]
                return geom
        except Exception as e:
            st.error(f"ORS Isochrone error ({minutes} min): {e}")
        return None

    @st.cache_data(ttl=120)
    def get_h3_coverage(geom_json, res):
        escaped = json.dumps(geom_json).replace("'", "''")
        query = f"""
        SELECT f.VALUE::VARCHAR AS h3_index
        FROM TABLE(FLATTEN(
            H3_COVERAGE_STRINGS(TO_GEOGRAPHY('{escaped}'), {res})
        )) f
        """
        try:
            return session.sql(query).to_pandas()
        except Exception as e:
            st.error(f"H3 coverage error: {e}")
            return pd.DataFrame()

    @st.cache_data(ttl=120)
    def get_travel_times_for_origin(origin_hex):
        query = f"""
        SELECT DESTINATION_HEX_ID AS H3_INDEX,
               TRAVEL_TIME_SECONDS,
               ROUND(TRAVEL_TIME_SECONDS / 60, 1) AS TRAVEL_TIME_MINS,
               DISTANCE_METERS,
               ROUND(DISTANCE_METERS / 1000, 2) AS TRAVEL_DISTANCE_KM
        FROM {TRAVEL_MATRIX_TABLE}
        WHERE ORIGIN_HEX_ID = '{origin_hex}'
        """
        try:
            return session.sql(query).to_pandas()
        except Exception as e:
            st.error(f"Matrix query error: {e}")
            return pd.DataFrame()

    def parse_iso_coords(geom):
        iso_coords = []
        try:
            coords = geom["coordinates"]
            if geom["type"] == "Polygon":
                iso_coords = [{"polygon": [{"lng": c[0], "lat": c[1]} for c in ring]} for ring in coords]
            elif geom["type"] == "MultiPolygon":
                for poly in coords:
                    for ring in poly:
                        iso_coords.append({"polygon": [{"lng": c[0], "lat": c[1]} for c in ring]})
        except:
            pass
        return iso_coords

    with st.spinner(f"Computing {num_bands} isochrone bands up to {isochrone_minutes} min..."):
        isochrone_geoms = {}
        for mins in band_minutes:
            geom = build_isochrone(travel_mode, origin_lon, origin_lat, mins)
            if geom:
                isochrone_geoms[mins] = geom

    if not isochrone_geoms:
        st.warning("No isochrones could be computed. Check ORS service availability.")
        st.stop()

    with st.spinner("Filling isochrone bands with H3 hexagons..."):
        band_hex_sets = {}
        for mins in sorted(isochrone_geoms.keys()):
            coverage_df = get_h3_coverage(isochrone_geoms[mins], resolution)
            if not coverage_df.empty:
                band_hex_sets[mins] = set(coverage_df["H3_INDEX"].tolist())
            else:
                band_hex_sets[mins] = set()

    with st.spinner("Loading real travel times from ORS matrix..."):
        travel_df = get_travel_times_for_origin(selected_hex)

    sorted_bands = sorted(band_hex_sets.keys())
    assigned = set()
    hex_band_map = {}

    for mins in sorted_bands:
        new_hexes = band_hex_sets[mins] - assigned
        for h in new_hexes:
            hex_band_map[h] = mins
        assigned |= new_hexes

    if selected_hex in hex_band_map:
        del hex_band_map[selected_hex]

    all_hexes = list(hex_band_map.keys())
    hex_df = pd.DataFrame({"H3_INDEX": all_hexes, "BAND_MINUTES": [hex_band_map[h] for h in all_hexes]})

    if not hex_df.empty and not travel_df.empty:
        hex_df = hex_df.merge(travel_df, on="H3_INDEX", how="left")
    else:
        hex_df["TRAVEL_TIME_SECONDS"] = None
        hex_df["TRAVEL_TIME_MINS"] = None
        hex_df["DISTANCE_METERS"] = None
        hex_df["TRAVEL_DISTANCE_KM"] = None

    band_idx_map = {mins: i for i, mins in enumerate(sorted_bands)}

    def get_band_color(band_mins):
        idx = band_idx_map.get(band_mins, 0)
        c = BAND_COLORS[idx % len(BAND_COLORS)]
        return [c[0], c[1], c[2], 180]

    hex_df["color"] = hex_df["BAND_MINUTES"].apply(get_band_color)

    has_travel = hex_df["TRAVEL_TIME_MINS"].notna().sum()
    missing_travel = hex_df["TRAVEL_TIME_MINS"].isna().sum()

    st.markdown('<h1sub>Coverage Summary</h1sub>', unsafe_allow_html=True)

    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("Reachable Hexagons", f"{len(hex_df):,}")
    with col2:
        if has_travel > 0:
            avg_time = hex_df["TRAVEL_TIME_MINS"].mean()
            st.metric("Avg Travel Time", f"{avg_time:.1f} min")
        else:
            st.metric("Avg Travel Time", "N/A")
    with col3:
        if has_travel > 0:
            max_time = hex_df["TRAVEL_TIME_MINS"].max()
            st.metric("Max Travel Time", f"{max_time:.1f} min")
        else:
            st.metric("Max Travel Time", "N/A")
    with col4:
        area_per_hex = {9: 0.03, 8: 0.18, 7: 1.3}
        st.metric("Coverage Area", f"{len(hex_df) * area_per_hex.get(resolution, 0.03):.1f} km\u00b2")

    if missing_travel > 0:
        st.caption(f"Travel times from ORS matrix: {has_travel:,} hexagons matched, {missing_travel:,} outside matrix coverage (shown by band only)")

    st.divider()
    st.markdown('<h1sub>Isochrone Reachability Map</h1sub>', unsafe_allow_html=True)

    layers = []

    h3_layer = pdk.Layer(
        "H3HexagonLayer",
        hex_df,
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

    origin_df = pd.DataFrame([{
        "H3_INDEX": selected_hex,
        "TRAVEL_TIME_MINS": 0,
        "TRAVEL_DISTANCE_KM": 0,
        "BAND_MINUTES": 0,
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

    if show_isochrone_boundary:
        for mins in sorted(isochrone_geoms.keys()):
            idx = band_idx_map.get(mins, 0)
            c = BAND_COLORS[idx % len(BAND_COLORS)]
            iso_coords = parse_iso_coords(isochrone_geoms[mins])
            if iso_coords:
                iso_layer = pdk.Layer(
                    "PolygonLayer",
                    iso_coords,
                    get_polygon="polygon",
                    get_fill_color=[c[0], c[1], c[2], 15],
                    get_line_color=[c[0], c[1], c[2], 200],
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

    tooltip_html = "<b>Hex:</b> {H3_INDEX}<br/><b>Band:</b> {BAND_MINUTES} min"
    if has_travel > 0:
        tooltip_html += "<br/><b>Real Travel Time:</b> {TRAVEL_TIME_MINS} min<br/><b>Distance:</b> {TRAVEL_DISTANCE_KM} km"

    tooltip = {
        "html": tooltip_html,
        "style": {"backgroundColor": "#24323D", "color": "white"}
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
        band_stats_rows = []
        prev = 0
        for mins in sorted_bands:
            band_df = hex_df[hex_df["BAND_MINUTES"] == mins]
            row = {"Band": f"{prev}-{mins} min", "Hexagons": len(band_df)}
            if band_df["TRAVEL_TIME_MINS"].notna().any():
                row["Avg Time (min)"] = round(band_df["TRAVEL_TIME_MINS"].mean(), 1)
                row["Min Time"] = round(band_df["TRAVEL_TIME_MINS"].min(), 1)
                row["Max Time"] = round(band_df["TRAVEL_TIME_MINS"].max(), 1)
            else:
                row["Avg Time (min)"] = None
                row["Min Time"] = None
                row["Max Time"] = None
            band_stats_rows.append(row)
            prev = mins
        band_stats_df = pd.DataFrame(band_stats_rows)
        st.dataframe(band_stats_df, use_container_width=True, hide_index=True)

    with col2:
        chart_data = pd.DataFrame(band_stats_rows)
        chart = alt.Chart(chart_data).mark_bar().encode(
            x=alt.X("Band:N", sort=[f"{minutes_breakpoints(isochrone_minutes, num_bands)}" for _ in sorted_bands], title=None),
            y=alt.Y("Hexagons:Q", title="Hexagons"),
            color=alt.value("#FF6B35"),
            tooltip=["Band", "Hexagons"]
        ).properties(height=300)
        st.altair_chart(chart, use_container_width=True)

    with st.expander("View Detailed Data"):
        display_cols = ["H3_INDEX", "BAND_MINUTES"]
        if has_travel > 0:
            display_cols.extend(["TRAVEL_TIME_MINS", "TRAVEL_DISTANCE_KM"])
        st.dataframe(
            hex_df[display_cols].sort_values("BAND_MINUTES"),
            use_container_width=True,
            hide_index=True
        )
else:
    st.info("Select an origin hexagon from the sidebar to begin analysis.")

st.divider()

st.markdown(f'''
<h1grey>Bands: {num_bands} | Max: {isochrone_minutes} min | Mode: {travel_mode} | H3 Res: {resolution} | Powered by Snowflake & OpenRouteService</h1grey>
''', unsafe_allow_html=True)
