import json
import pydeck as pdk
import streamlit as st
from snowflake.snowpark.context import get_active_session

SNOWFLAKE_BLUE = [41, 181, 232]
SNOWFLAKE_CYAN = [0, 200, 240]
SNOWFLAKE_GREEN = [76, 217, 100]
SNOWFLAKE_RED = [255, 75, 75]

st.set_page_config(page_title="Fleet Explorer", page_icon="\u2744\ufe0f", layout="wide")
session = get_active_session()

st.markdown("""
<style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    html, body, [class*="css"] { font-family: 'Inter', sans-serif; }
    .block-container { padding-top: 1.5rem; padding-bottom: 1rem; }
    [data-testid="stMetricValue"] { font-size: 1.6rem; font-weight: 700; color: #29B5E8; }
    [data-testid="stMetricLabel"] { font-size: 0.85rem; font-weight: 500; }
    .stTabs [data-baseweb="tab-list"] { gap: 1.5rem; }
    .stTabs [data-baseweb="tab"] { font-size: 0.95rem; font-weight: 600; }
    [data-testid="stSidebar"] { background-color: #F4F8FB; }
    h1 { color: #1B2332; font-weight: 700; }
    .stButton > button[kind="primary"] { background-color: #29B5E8; border-color: #29B5E8; }
    .stButton > button[kind="primary"]:hover { background-color: #1E9FCD; border-color: #1E9FCD; }
    [data-baseweb="tag"] { background-color: #29B5E8 !important; }
    .stSlider [data-testid="stThumbValue"] { color: #29B5E8; }
    div[data-baseweb="slider"] div[role="slider"] { background-color: #29B5E8 !important; }
    div[data-baseweb="slider"] div[data-testid="stTickBar"] div { background-color: #29B5E8 !important; }
    .stTabs [aria-selected="true"] { color: #29B5E8 !important; border-bottom-color: #29B5E8 !important; }
    a { color: #29B5E8; }
    .stSpinner > div { border-top-color: #29B5E8 !important; }
    [data-testid="stMultiSelect"] span[data-baseweb="tag"] { background-color: #29B5E8 !important; }
</style>
""", unsafe_allow_html=True)

def check_ors_health():
    try:
        result = session.sql("SELECT OPENROUTESERVICE_APP.CORE.CHECK_HEALTH() AS healthy").collect()
        return bool(result[0]["HEALTHY"])
    except Exception as e:
        return False

@st.cache_data
def load_pois():
    return session.sql(
        "SELECT TRIM(NAME, '\"')::TEXT AS NAME, TRIM(CATEGORY, '\"')::TEXT AS CATEGORY, LNG, LAT FROM SYNTHETIC_DATASETS.UNIFIED.DIM_POIS"
    ).to_pandas()

@st.cache_data
def load_fleet():
    return session.sql(
        "SELECT * FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET"
    ).to_pandas()

ors_ready = check_ors_health()

st.title("Fleet Explorer")
st.caption("Geospatial analytics powered by OpenRouteService on Snowpark Container Services")

with st.sidebar:
    st.markdown("### Fleet Explorer")
    st.caption("Built with Snowpark Container Services & OpenRouteService")
    st.divider()
    if ors_ready:
        st.success("ORS Services: Running")
    else:
        st.warning("ORS Services: Not ready")
        st.caption("Deploy with: `Build the routing solution`")
    st.divider()
    st.button("Refresh data", on_click=load_pois.clear, type="primary", use_container_width=True)

tab1, tab2, tab3, tab4, tab5 = st.tabs(["POI Map", "Directions", "Isochrones", "Route Optimization", "Travel Matrix"])

with tab1:
    pois = load_pois()
    categories = sorted([str(c) for c in pois["CATEGORY"].unique().tolist()])

    col_filter, col_metric = st.columns([4, 1])
    with col_filter:
        selected_cats = st.multiselect("Filter categories", categories, default=categories)
    with col_metric:
        filtered = pois[pois["CATEGORY"].astype(str).isin(selected_cats)]
        st.metric("POIs", f"{len(filtered):,}")

    layer = pdk.Layer(
        "ScatterplotLayer",
        data=filtered,
        get_position="[LNG, LAT]",
        get_radius=15,
        get_fill_color=SNOWFLAKE_BLUE + [180],
        pickable=True,
    )
    view = pdk.ViewState(latitude=37.76, longitude=-122.44, zoom=12)
    st.pydeck_chart(pdk.Deck(layers=[layer], initial_view_state=view, map_style="dark",
                             tooltip={"html": "<b>{NAME}</b><br/>{CATEGORY}", "style": {"backgroundColor": "#1B2332", "color": "#FAFAFA", "fontSize": "12px"}}))

with tab2:
    if not ors_ready:
        st.info("ORS services must be running. Deploy with: `Build the routing solution`")
    else:
        pois = load_pois()
        poi_names = pois["NAME"].tolist()

        col1, col2 = st.columns(2)
        with col1:
            origin_name = st.selectbox("Origin", poi_names, index=0)
        with col2:
            dest_name = st.selectbox("Destination", poi_names, index=min(1, len(poi_names)-1))

        if st.button("Get Route", type="primary"):
            origin = pois[pois["NAME"] == origin_name].iloc[0]
            dest = pois[pois["NAME"] == dest_name].iloc[0]

            with st.spinner("Calculating route..."):
                route_df = session.sql(f"""
                    SELECT DISTANCE, DURATION, GEOJSON
                    FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
                        'driving-car',
                        ARRAY_CONSTRUCT({origin['LNG']}, {origin['LAT']}),
                        ARRAY_CONSTRUCT({dest['LNG']}, {dest['LAT']})
                    ))
                """).to_pandas()

            if len(route_df) > 0 and route_df["DISTANCE"].iloc[0] is not None and not (route_df["DISTANCE"].iloc[0] != route_df["DISTANCE"].iloc[0]):
                dist_km = route_df["DISTANCE"].iloc[0] / 1000
                dur_min = route_df["DURATION"].iloc[0] / 60

                mc1, mc2, mc3 = st.columns(3)
                mc1.metric("Distance", f"{dist_km:.1f} km")
                mc2.metric("Duration", f"{dur_min:.1f} min")
                mc3.metric("Avg Speed", f"{(dist_km / (dur_min / 60)):.0f} km/h" if dur_min > 0 else "N/A")

                geojson_str = session.sql(f"""
                    SELECT ST_ASGEOJSON(GEOJSON)::STRING AS geojson
                    FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
                        'driving-car',
                        ARRAY_CONSTRUCT({origin['LNG']}, {origin['LAT']}),
                        ARRAY_CONSTRUCT({dest['LNG']}, {dest['LAT']})
                    ))
                """).collect()[0]["GEOJSON"]

                if geojson_str is None:
                    st.error("Route geometry unavailable.")
                else:
                    geojson = json.loads(geojson_str)

                    route_layer = pdk.Layer(
                        "GeoJsonLayer",
                        data=geojson,
                        get_line_color=SNOWFLAKE_CYAN + [220],
                        get_line_width=5,
                        line_width_min_pixels=3,
                    )
                    points_layer = pdk.Layer(
                        "ScatterplotLayer",
                        data=[
                            {"position": [origin["LNG"], origin["LAT"]], "color": SNOWFLAKE_GREEN + [220], "name": origin_name, "type": "Origin"},
                            {"position": [dest["LNG"], dest["LAT"]], "color": SNOWFLAKE_RED + [220], "name": dest_name, "type": "Destination"},
                        ],
                        get_position="position",
                        get_radius=25,
                        get_fill_color="color",
                        pickable=True,
                    )
                    mid_lat = (origin["LAT"] + dest["LAT"]) / 2
                    mid_lng = (origin["LNG"] + dest["LNG"]) / 2
                    lat_diff = abs(origin["LAT"] - dest["LAT"])
                    lng_diff = abs(origin["LNG"] - dest["LNG"])
                    max_diff = max(lat_diff, lng_diff)
                    zoom = 15 if max_diff < 0.005 else 14 if max_diff < 0.01 else 13 if max_diff < 0.03 else 12 if max_diff < 0.06 else 11
                    view = pdk.ViewState(latitude=mid_lat, longitude=mid_lng, zoom=zoom)
                    st.pydeck_chart(pdk.Deck(layers=[route_layer, points_layer], initial_view_state=view, map_style="dark",
                                             tooltip={"html": "<b>{type}</b><br/>{name}", "style": {"backgroundColor": "#1B2332", "color": "#FAFAFA", "fontSize": "12px"}}))
            else:
                st.error("No route found. ORS may not be running or the region is not provisioned.")

with tab3:
    if not ors_ready:
        st.info("ORS services must be running. Deploy with: `Build the routing solution`")
    else:
        pois = load_pois()
        poi_names = pois["NAME"].tolist()

        col1, col2 = st.columns([2, 1])
        with col1:
            center_name = st.selectbox("Center location", poi_names, index=0, key="iso_center")
        with col2:
            minutes = st.slider("Travel time (min)", 1, 15, 5)

        if st.button("Generate Isochrone", type="primary"):
            center = pois[pois["NAME"] == center_name].iloc[0]

            with st.spinner("Generating isochrone..."):
                iso_df = session.sql(f"""
                    SELECT ST_ASGEOJSON(GEOJSON)::STRING AS geojson
                    FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
                        'driving-car',
                        {center['LNG']}::FLOAT,
                        {center['LAT']}::FLOAT,
                        {minutes}::NUMBER
                    ))
                """).to_pandas()

            if len(iso_df) > 0 and iso_df["GEOJSON"].iloc[0] is not None:
                geojson = json.loads(iso_df["GEOJSON"].iloc[0])

                iso_layer = pdk.Layer(
                    "GeoJsonLayer",
                    data=geojson,
                    get_fill_color=SNOWFLAKE_BLUE + [40],
                    get_line_color=SNOWFLAKE_CYAN + [200],
                    get_line_width=3,
                    line_width_min_pixels=2,
                    filled=True,
                )
                center_layer = pdk.Layer(
                    "ScatterplotLayer",
                    data=[{"position": [center["LNG"], center["LAT"]], "name": center_name}],
                    get_position="position",
                    get_radius=30,
                    get_fill_color=SNOWFLAKE_CYAN + [240],
                    pickable=True,
                )
                view = pdk.ViewState(latitude=center["LAT"], longitude=center["LNG"], zoom=13)
                st.pydeck_chart(pdk.Deck(layers=[iso_layer, center_layer], initial_view_state=view, map_style="dark",
                                         tooltip={"html": "<b>{name}</b>", "style": {"backgroundColor": "#1B2332", "color": "#FAFAFA", "fontSize": "12px"}}))
                st.caption(f"{minutes}-minute driving isochrone from {center_name}")
            else:
                st.error("No isochrone returned")

with tab4:
    if not ors_ready:
        st.info("ORS services must be running. Deploy with: `Build the routing solution`")
    else:
        st.subheader("Route Optimization (VRP)")
        st.caption("Optimally assign deliveries to vehicles using the VROOM solver")
        pois = load_pois()

        col1, col2 = st.columns(2)
        with col1:
            num_vehicles = st.number_input("Number of vehicles", min_value=1, max_value=5, value=2)
        with col2:
            num_jobs = st.number_input("Number of deliveries", min_value=2, max_value=20, value=6)

        depot_name = st.selectbox("Depot (start/end)", pois["NAME"].tolist(), index=0, key="vrp_depot")

        if st.button("Optimize Routes", type="primary"):
            depot = pois[pois["NAME"] == depot_name].iloc[0]
            job_pois = pois.sample(n=min(num_jobs, len(pois)), random_state=42)

            import math
            capacity_per_vehicle = max(1, math.ceil(num_jobs / num_vehicles))
            vehicles_arr = ", ".join([
                f'{{"id": {i+1}, "profile": "driving-car", "start": [{depot["LNG"]}, {depot["LAT"]}], "end": [{depot["LNG"]}, {depot["LAT"]}], "capacity": [{capacity_per_vehicle}]}}'
                for i in range(num_vehicles)
            ])
            jobs_arr = ", ".join([
                f'{{"id": {i+1}, "location": [{row["LNG"]}, {row["LAT"]}], "delivery": [1]}}'
                for i, (_, row) in enumerate(job_pois.iterrows())
            ])

            with st.spinner("Solving VRP..."):
                vrp_result = session.sql(f"""
                    SELECT VEHICLE, DURATION, STEPS, GEOJSON
                    FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
                        PARSE_JSON('{{"vehicles": [{vehicles_arr}], "jobs": [{jobs_arr}]}}')
                    ))
                """).to_pandas()

            if len(vrp_result) > 0 and vrp_result["VEHICLE"].iloc[0] is not None:
                colors = [[41, 181, 232], [76, 217, 100], [255, 165, 0], [200, 80, 200], [255, 75, 75]]
                layers = []

                for idx, row in vrp_result.iterrows():
                    geojson_str = session.sql(f"""
                        SELECT ST_ASGEOJSON(GEOJSON)::STRING AS geojson
                        FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(
                            PARSE_JSON('{{"vehicles": [{vehicles_arr}], "jobs": [{jobs_arr}]}}')
                        )) WHERE VEHICLE = {int(row['VEHICLE'])}
                    """).collect()
                    if geojson_str and geojson_str[0]["GEOJSON"]:
                        route_geojson = json.loads(geojson_str[0]["GEOJSON"])
                        color = colors[idx % len(colors)]
                        layers.append(pdk.Layer(
                            "GeoJsonLayer",
                            data=route_geojson,
                            get_line_color=color + [200],
                            get_line_width=4,
                            line_width_min_pixels=2,
                        ))

                depot_layer = pdk.Layer(
                    "ScatterplotLayer",
                    data=[{"position": [depot["LNG"], depot["LAT"]], "name": f"Depot: {depot_name}", "type": "Depot"}],
                    get_position="position",
                    get_radius=40,
                    get_fill_color=[255, 255, 0, 240],
                    pickable=True,
                )
                job_layer = pdk.Layer(
                    "ScatterplotLayer",
                    data=[{"position": [r["LNG"], r["LAT"]], "name": r["NAME"], "type": "Delivery"} for _, r in job_pois.iterrows()],
                    get_position="position",
                    get_radius=25,
                    get_fill_color=SNOWFLAKE_BLUE + [200],
                    pickable=True,
                )
                layers.extend([depot_layer, job_layer])

                view = pdk.ViewState(latitude=depot["LAT"], longitude=depot["LNG"], zoom=12)
                st.pydeck_chart(pdk.Deck(layers=layers, initial_view_state=view, map_style="dark",
                                         tooltip={"html": "<b>{name}</b>", "style": {"backgroundColor": "#1B2332", "color": "#FAFAFA", "fontSize": "12px"}}))

                mc1, mc2 = st.columns(2)
                mc1.metric("Vehicles Used", len(vrp_result))
                mc2.metric("Total Duration", f"{vrp_result['DURATION'].sum() / 60:.0f} min")

                with st.expander("Route Details"):
                    for _, row in vrp_result.iterrows():
                        st.markdown(f"**Vehicle {int(row['VEHICLE'])}** — {row['DURATION'] / 60:.1f} min")
            else:
                st.error("Optimization failed. Check that VROOM service is running.")

with tab5:
    if not ors_ready:
        st.info("ORS services must be running. Deploy with: `Build the routing solution`")
    else:
        st.subheader("Travel Time Matrix + H3 Heatmap")
        st.caption("Compute travel times from a center point to surrounding H3 cells")
        pois = load_pois()

        center_name = st.selectbox("Center location", pois["NAME"].tolist(), index=0, key="matrix_center")
        col1, col2, col3 = st.columns(3)
        with col1:
            profile = st.selectbox("Vehicle type", ["driving-car", "cycling-regular", "foot-walking"], index=0, key="matrix_profile")
        with col2:
            h3_res = st.slider("H3 resolution", 7, 9, 8, key="h3_res")
        with col3:
            grid_size = st.slider("Grid points", 9, 25, 16, key="grid_size")

        if st.button("Generate Matrix Heatmap", type="primary"):
            center = pois[pois["NAME"] == center_name].iloc[0]
            import math
            step = 0.005 if h3_res >= 8 else 0.01
            half = int(math.sqrt(grid_size))
            points = []
            for i in range(-half, half+1):
                for j in range(-half, half+1):
                    lng = center["LNG"] + j * step
                    lat = center["LAT"] + i * step
                    points.append([lng, lat])

            locations_str = ", ".join([f"ARRAY_CONSTRUCT({p[0]}, {p[1]})" for p in points])

            with st.spinner("Computing travel matrix..."):
                matrix_result = session.sql(f"""
                    SELECT OPENROUTESERVICE_APP.CORE.MATRIX(
                        '{profile}',
                        ARRAY_CONSTRUCT({locations_str})
                    ) AS result
                """).collect()[0]["RESULT"]

            if matrix_result:
                durations = json.loads(str(matrix_result)) if isinstance(matrix_result, str) else matrix_result
                if "durations" in durations:
                    dur_from_center = durations["durations"][0]
                    dist_from_center = durations.get("distances", [None])[0] if "distances" in durations else None
                    h3_data = []
                    for idx, point in enumerate(points):
                        if idx < len(dur_from_center) and dur_from_center[idx] is not None:
                            h3_cell = session.sql(f"""
                                SELECT H3_POINT_TO_CELL_STRING(ST_MAKEPOINT({point[0]}, {point[1]}), {h3_res}) AS h3
                            """).collect()[0]["H3"]
                            dist_km = (dist_from_center[idx] / 1000) if dist_from_center and idx < len(dist_from_center) and dist_from_center[idx] is not None else None
                            h3_data.append({
                                "h3": h3_cell,
                                "duration_min": round(dur_from_center[idx] / 60, 1),
                                "distance_km": round(dist_km, 2) if dist_km else 0,
                                "lng": point[0],
                                "lat": point[1]
                            })

                    if h3_data:
                        import pandas as pd
                        h3_df = pd.DataFrame(h3_data)
                        max_dur = h3_df["duration_min"].max()
                        h3_df["normalized"] = h3_df["duration_min"] / max_dur if max_dur > 0 else 0
                        h3_df["color_r"] = (h3_df["normalized"] * 255).astype(int)
                        h3_df["color_g"] = ((1 - h3_df["normalized"]) * 200).astype(int)
                        h3_df["color_b"] = 80

                        h3_layer = pdk.Layer(
                            "H3HexagonLayer",
                            data=h3_df,
                            get_hexagon="h3",
                            get_fill_color="[color_r, color_g, color_b, 160]",
                            get_line_color=[255, 255, 255, 50],
                            extruded=False,
                            pickable=True,
                        )
                        center_layer = pdk.Layer(
                            "ScatterplotLayer",
                            data=[{"position": [center["LNG"], center["LAT"]], "name": center_name}],
                            get_position="position",
                            get_radius=40,
                            get_fill_color=SNOWFLAKE_CYAN + [240],
                            pickable=True,
                        )
                        view = pdk.ViewState(latitude=center["LAT"], longitude=center["LNG"], zoom=13)
                        st.pydeck_chart(pdk.Deck(layers=[h3_layer, center_layer], initial_view_state=view, map_style="dark",
                                                 tooltip={"html": "<b>{h3}</b><br/>Drive time: {duration_min} min<br/>Distance: {distance_km} km", "style": {"backgroundColor": "#1B2332", "color": "#FAFAFA", "fontSize": "12px"}}))

                        mc1, mc2, mc3 = st.columns(3)
                        mc1.metric("H3 Cells", len(h3_df))
                        mc2.metric("Max Travel", f"{max_dur:.1f} min")
                        mc3.metric("Resolution", h3_res)

                        st.caption("Green = closer, Red = further from center point")
                    else:
                        st.warning("No valid travel times returned")
                else:
                    st.error("Matrix response missing durations")
                    st.json(durations)
            else:
                st.error("Matrix computation failed")
