import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
from snowflake.snowpark.context import get_active_session
from city_config import get_company, get_california_cities, get_city, CALIFORNIA_CENTER

COMPANY = get_company()

st.set_page_config(
    page_title=f"{COMPANY['name']} - Retail Supply Chain",
    layout="wide",
    initial_sidebar_state="expanded",
)

with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

st.logo('logo.svg')

session = get_active_session()

STORES_TABLE = "OPENROUTESERVICE_SETUP.PUBLIC.RETAIL_STORES"
CATCHMENT_TABLE = "OPENROUTESERVICE_SETUP.PUBLIC.RETAIL_CATCHMENT_RES8"
COMPETITIVE_TABLE = "OPENROUTESERVICE_SETUP.PUBLIC.RETAIL_COMPETITIVE_VIEW"

RETAILERS = ["WALMART", "SMART_AND_FINAL", "COSTCO", "TARGET", "SAMS_CLUB", "RESTAURANT_DEPOT"]

RETAILER_DISPLAY = {
    "WALMART": "Walmart",
    "SMART_AND_FINAL": "Smart & Final",
    "COSTCO": "Costco",
    "TARGET": "Target",
    "SAMS_CLUB": "Sam's Club",
    "RESTAURANT_DEPOT": "Restaurant Depot",
}

RETAILER_COLORS = {
    "WALMART": [0, 120, 215, 200],
    "SMART_AND_FINAL": [230, 57, 70, 200],
    "COSTCO": [230, 0, 0, 200],
    "TARGET": [204, 0, 0, 200],
    "SAMS_CLUB": [0, 83, 159, 200],
    "RESTAURANT_DEPOT": [34, 139, 34, 200],
}

RETAILER_HEX_COLORS = {
    "WALMART": "#0078D7",
    "SMART_AND_FINAL": "#E63946",
    "COSTCO": "#E60000",
    "TARGET": "#CC0000",
    "SAMS_CLUB": "#00539F",
    "RESTAURANT_DEPOT": "#228B22",
}

TIME_BAND_COLORS = {
    "0-15 min": [46, 204, 113, 180],
    "15-30 min": [243, 156, 18, 180],
    "30-45 min": [255, 107, 53, 180],
    "45-60 min": [230, 57, 70, 180],
}

st.markdown(f'''
<h0orange>{COMPANY["name"]}</h0orange><h0black> |</h0black><h0blue> Wholesale Supply Chain</h0blue><BR>
<h1grey>Which supplier can reach your restaurant fastest? Multi-retailer coverage across California.</h1grey>
''', unsafe_allow_html=True)

st.divider()

st.markdown('''
> **The Supply Chain Story:** *Your restaurant group sources bulk goods from wholesale suppliers
> (Costco, Walmart, Smart & Final, Sam's Club, Restaurant Depot, Target). This page analyses
> the first mile — which supplier can deliver to each location fastest, and where are the gaps?*
''')


@st.cache_data(ttl=600)
def load_stores():
    return session.sql(f"""
        SELECT STORE_ID, RETAILER, NAME, CITY, LON, LAT, H3_RES8
        FROM {STORES_TABLE}
        ORDER BY RETAILER, CITY
    """).to_pandas()


@st.cache_data(ttl=600)
def load_competitive_summary():
    return session.sql(f"""
        SELECT NEAREST_RETAILER, COUNT(*) AS HEX_COUNT,
               ROUND(AVG(NEAREST_MINS), 1) AS AVG_MINS
        FROM {COMPETITIVE_TABLE}
        GROUP BY NEAREST_RETAILER
        ORDER BY HEX_COUNT DESC
    """).to_pandas()


@st.cache_data(ttl=600)
def load_catchment_for_store(store_id):
    return session.sql(f"""
        SELECT HEX_ID, TRAVEL_TIME_SECONDS,
               ROUND(TRAVEL_TIME_SECONDS / 60, 1) AS TRAVEL_MINS,
               ROUND(TRAVEL_DISTANCE_METERS / 1000, 2) AS DISTANCE_KM,
               TIME_BAND
        FROM {CATCHMENT_TABLE}
        WHERE STORE_ID = {store_id}
    """).to_pandas()


@st.cache_data(ttl=600)
def load_competitive_hexagons(city=None):
    where = ""
    if city:
        where = f"WHERE NEAREST_CITY = '{city}'"
    return session.sql(f"""
        SELECT HEX_ID, NEAREST_RETAILER, NEAREST_CITY,
               NEAREST_MINS, SECOND_RETAILER, SECOND_MINS,
               ADVANTAGE_MINS, SUPPLIER_COUNT
        FROM {COMPETITIVE_TABLE}
        {where}
    """).to_pandas()


@st.cache_data(ttl=600)
def load_catchment_by_retailer(retailer, city=None):
    where = f"WHERE RETAILER = '{retailer}'"
    if city:
        where += f" AND STORE_CITY = '{city}'"
    return session.sql(f"""
        SELECT HEX_ID, TIME_BAND,
               ROUND(TRAVEL_TIME_SECONDS / 60, 1) AS TRAVEL_MINS,
               STORE_ID, STORE_CITY
        FROM {CATCHMENT_TABLE}
        {where}
    """).to_pandas()


stores_df = load_stores()

with st.sidebar:
    view_mode = st.radio(
        "View Mode",
        ["Competitive Map", "Store Catchment", "Store Explorer"],
        index=0,
    )

    city_options = ["All California"] + sorted(stores_df["CITY"].unique().tolist())
    selected_city = st.selectbox("Filter by City", city_options, index=0)

    st.divider()
    st.subheader("Legend")

    if view_mode == "Competitive Map":
        legend_items = [(RETAILER_COLORS[r], RETAILER_DISPLAY[r]) for r in RETAILERS]
    elif view_mode == "Store Catchment":
        legend_items = [
            (TIME_BAND_COLORS["0-15 min"], "0-15 min"),
            (TIME_BAND_COLORS["15-30 min"], "15-30 min"),
            (TIME_BAND_COLORS["30-45 min"], "30-45 min"),
            (TIME_BAND_COLORS["45-60 min"], "45-60 min"),
        ]
    else:
        legend_items = [(RETAILER_COLORS[r], RETAILER_DISPLAY[r]) for r in RETAILERS]

    legend_html = ""
    for color, label in legend_items:
        legend_html += f'<div style="display:flex;align-items:center;margin-bottom:4px;"><div style="width:16px;height:16px;background-color:rgba({color[0]},{color[1]},{color[2]},{color[3]/255});margin-right:8px;border-radius:3px;"></div><span style="font-size:0.85rem;color:#6b7b86;">{label}</span></div>'
    st.markdown(legend_html, unsafe_allow_html=True)


if selected_city != "All California":
    filtered_stores = stores_df[stores_df["CITY"] == selected_city]
    city_cfg = get_city(selected_city) if selected_city in get_california_cities() else None
    center_lat = city_cfg["latitude"] if city_cfg else filtered_stores["LAT"].mean()
    center_lon = city_cfg["longitude"] if city_cfg else filtered_stores["LON"].mean()
    map_zoom = 10
else:
    filtered_stores = stores_df
    center_lat = CALIFORNIA_CENTER["latitude"]
    center_lon = CALIFORNIA_CENTER["longitude"]
    map_zoom = 6

cols = st.columns(len(RETAILERS) + 1)
for i, r in enumerate(RETAILERS):
    cnt = len(filtered_stores[filtered_stores["RETAILER"] == r])
    with cols[i]:
        st.metric(RETAILER_DISPLAY[r], f"{cnt}")
with cols[-1]:
    st.metric("Total Stores", f"{len(filtered_stores)}")

st.divider()

if view_mode == "Competitive Map":
    st.markdown('<h1sub>Competitive Coverage — Who Delivers Fastest?</h1sub>', unsafe_allow_html=True)

    with st.spinner("Loading competitive analysis..."):
        comp_df = load_competitive_hexagons(selected_city if selected_city != "All California" else None)

    if not comp_df.empty:
        comp_df.columns = [c.upper() for c in comp_df.columns]
        comp_df["color_r"] = comp_df["NEAREST_RETAILER"].map(lambda r: RETAILER_COLORS.get(r, [150, 150, 150, 120])[0])
        comp_df["color_g"] = comp_df["NEAREST_RETAILER"].map(lambda r: RETAILER_COLORS.get(r, [150, 150, 150, 120])[1])
        comp_df["color_b"] = comp_df["NEAREST_RETAILER"].map(lambda r: RETAILER_COLORS.get(r, [150, 150, 150, 120])[2])
        comp_df["color_a"] = comp_df["NEAREST_RETAILER"].map(lambda r: RETAILER_COLORS.get(r, [150, 150, 150, 120])[3])

        layers = []

        h3_layer = pdk.Layer(
            "H3HexagonLayer",
            comp_df,
            pickable=True,
            stroked=False,
            filled=True,
            extruded=False,
            get_hexagon="HEX_ID",
            get_fill_color="[color_r, color_g, color_b, color_a]",
            opacity=0.7,
        )
        layers.append(h3_layer)

        for r in RETAILERS:
            r_stores = filtered_stores[filtered_stores["RETAILER"] == r].copy()
            if not r_stores.empty:
                r_stores["TOOLTIP_TYPE"] = "store"
                r_stores["DISPLAY_NAME"] = r_stores["NAME"]
                r_stores["DISPLAY_RETAILER"] = r_stores["RETAILER"].map(RETAILER_DISPLAY)
                r_stores["DISPLAY_CITY"] = r_stores["CITY"]
                layers.append(pdk.Layer(
                    "ScatterplotLayer",
                    r_stores,
                    get_position=["LON", "LAT"],
                    get_fill_color=RETAILER_COLORS[r][:3] + [255],
                    get_line_color=[0, 0, 0, 200],
                    get_radius=3000 if map_zoom < 8 else 800,
                    pickable=True,
                    stroked=True,
                    line_width_min_pixels=2,
                ))

        comp_df["DISPLAY_NAME"] = ""
        comp_df["DISPLAY_RETAILER"] = comp_df["NEAREST_RETAILER"].map(RETAILER_DISPLAY)
        comp_df["DISPLAY_CITY"] = comp_df.get("NEAREST_CITY", "")
        comp_df["TOOLTIP_TYPE"] = "hex"

        tooltip = {
            "html": "<b>{DISPLAY_RETAILER}</b><br/>{DISPLAY_NAME}{DISPLAY_CITY}<br/><b>Time:</b> {NEAREST_MINS} min<br/><b>2nd:</b> {SECOND_RETAILER} ({SECOND_MINS} min)<br/><b>Advantage:</b> {ADVANTAGE_MINS} min<br/><b>Suppliers:</b> {SUPPLIER_COUNT}",
            "style": {"backgroundColor": "#24323D", "color": "white"},
        }

        deck = pdk.Deck(
            map_provider="carto",
            map_style="light",
            layers=layers,
            initial_view_state=pdk.ViewState(
                latitude=center_lat, longitude=center_lon, zoom=map_zoom, pitch=0
            ),
            tooltip=tooltip,
        )
        st.pydeck_chart(deck, use_container_width=True)

        st.divider()
        st.markdown('<h1sub>Coverage Breakdown</h1sub>', unsafe_allow_html=True)

        col1, col2 = st.columns(2)
        with col1:
            breakdown = comp_df["NEAREST_RETAILER"].value_counts().reset_index()
            breakdown.columns = ["Retailer", "Hexagons"]
            breakdown["Pct"] = (breakdown["Hexagons"] / breakdown["Hexagons"].sum() * 100).round(1)
            breakdown["Display"] = breakdown["Retailer"].map(RETAILER_DISPLAY)
            st.dataframe(breakdown[["Display", "Hexagons", "Pct"]], use_container_width=True, hide_index=True)

        with col2:
            chart = alt.Chart(breakdown).mark_bar().encode(
                x=alt.X("Retailer:N", sort="-y", title=None),
                y=alt.Y("Hexagons:Q"),
                color=alt.Color("Retailer:N", scale=alt.Scale(
                    domain=list(RETAILER_HEX_COLORS.keys()),
                    range=list(RETAILER_HEX_COLORS.values()),
                ), legend=None),
                tooltip=["Retailer", "Hexagons", "Pct"],
            ).properties(height=300)
            st.altair_chart(chart, use_container_width=True)

        st.divider()
        st.markdown('<h1sub>Supplier Density</h1sub>', unsafe_allow_html=True)
        density = comp_df["SUPPLIER_COUNT"].value_counts().sort_index().reset_index()
        density.columns = ["Suppliers Available", "Hexagons"]
        st.bar_chart(density, x="Suppliers Available", y="Hexagons")
    else:
        st.info("No competitive data found for this city.")


elif view_mode == "Store Catchment":
    st.markdown('<h1sub>Delivery Zone Catchment by Retailer</h1sub>', unsafe_allow_html=True)

    retailer = st.radio(
        "Retailer", RETAILERS, horizontal=True,
        format_func=lambda x: RETAILER_DISPLAY.get(x, x),
    )

    with st.spinner(f"Loading {RETAILER_DISPLAY[retailer]} catchment zones..."):
        catch_df = load_catchment_by_retailer(
            retailer,
            selected_city if selected_city != "All California" else None,
        )

    if not catch_df.empty:
        catch_df.columns = [c.upper() for c in catch_df.columns]
        catch_df["color_r"] = catch_df["TIME_BAND"].map(lambda b: TIME_BAND_COLORS.get(b, [150, 150, 150, 120])[0])
        catch_df["color_g"] = catch_df["TIME_BAND"].map(lambda b: TIME_BAND_COLORS.get(b, [150, 150, 150, 120])[1])
        catch_df["color_b"] = catch_df["TIME_BAND"].map(lambda b: TIME_BAND_COLORS.get(b, [150, 150, 150, 120])[2])
        catch_df["color_a"] = catch_df["TIME_BAND"].map(lambda b: TIME_BAND_COLORS.get(b, [150, 150, 150, 120])[3])
        catch_df["DISPLAY_NAME"] = ""
        catch_df["DISPLAY_CITY"] = ""

        layers = []

        layers.append(pdk.Layer(
            "H3HexagonLayer",
            catch_df,
            pickable=True,
            stroked=False,
            filled=True,
            extruded=False,
            get_hexagon="HEX_ID",
            get_fill_color="[color_r, color_g, color_b, color_a]",
            opacity=0.7,
        ))

        retailer_stores = filtered_stores[filtered_stores["RETAILER"] == retailer].copy()
        if not retailer_stores.empty:
            retailer_stores["DISPLAY_NAME"] = retailer_stores["NAME"]
            retailer_stores["DISPLAY_RETAILER"] = retailer_stores["RETAILER"].map(RETAILER_DISPLAY)
            retailer_stores["DISPLAY_CITY"] = retailer_stores["CITY"]
            layers.append(pdk.Layer(
                "ScatterplotLayer",
                retailer_stores,
                get_position=["LON", "LAT"],
                get_fill_color=RETAILER_COLORS[retailer][:3] + [255],
                get_line_color=[0, 0, 0, 200],
                get_radius=3000 if map_zoom < 8 else 800,
                pickable=True,
                stroked=True,
                line_width_min_pixels=2,
            ))

        tooltip = {
            "html": "<b>{TIME_BAND}</b><br/>{DISPLAY_NAME}<br/><b>Travel:</b> {TRAVEL_MINS} min<br/><b>Store:</b> {STORE_ID}<br/>{DISPLAY_CITY}",
            "style": {"backgroundColor": "#24323D", "color": "white"},
        }

        deck = pdk.Deck(
            map_provider="carto",
            map_style="light",
            layers=layers,
            initial_view_state=pdk.ViewState(
                latitude=center_lat, longitude=center_lon, zoom=map_zoom, pitch=0
            ),
            tooltip=tooltip,
        )
        st.pydeck_chart(deck, use_container_width=True)

        st.divider()
        band_summary = catch_df["TIME_BAND"].value_counts().reset_index()
        band_summary.columns = ["Time Band", "Hexagons"]
        band_summary = band_summary.sort_values("Time Band")

        col1, col2 = st.columns(2)
        with col1:
            st.dataframe(band_summary, use_container_width=True, hide_index=True)
        with col2:
            chart = alt.Chart(band_summary).mark_bar().encode(
                x=alt.X("Time Band:N", sort=["0-15 min", "15-30 min", "30-45 min", "45-60 min"]),
                y=alt.Y("Hexagons:Q"),
                color=alt.value(RETAILER_HEX_COLORS.get(retailer, "#E63946")),
                tooltip=["Time Band", "Hexagons"],
            ).properties(height=300)
            st.altair_chart(chart, use_container_width=True)
    else:
        st.info(f"No catchment data for {RETAILER_DISPLAY[retailer]} in this area.")


elif view_mode == "Store Explorer":
    st.markdown('<h1sub>Individual Store Delivery Zone</h1sub>', unsafe_allow_html=True)

    retailer_filter = st.radio(
        "Retailer", RETAILERS, horizontal=True, key="explorer_retailer",
        format_func=lambda x: RETAILER_DISPLAY.get(x, x),
    )
    retailer_stores = filtered_stores[filtered_stores["RETAILER"] == retailer_filter]

    if not retailer_stores.empty:
        store_options = retailer_stores.apply(
            lambda r: f"{r['NAME']} — {r['CITY']}", axis=1
        ).tolist()
        store_ids = retailer_stores["STORE_ID"].tolist()

        selected_idx = st.selectbox("Select Store", range(len(store_options)),
                                     format_func=lambda i: store_options[i])

        selected_store_id = store_ids[selected_idx]
        store_row = retailer_stores.iloc[selected_idx]

        with st.spinner(f"Loading delivery zone for {store_row['NAME']}..."):
            zone_df = load_catchment_for_store(selected_store_id)

        if not zone_df.empty:
            zone_df.columns = [c.upper() for c in zone_df.columns]
            zone_df["color_r"] = zone_df["TIME_BAND"].map(lambda b: TIME_BAND_COLORS.get(b, [150, 150, 150, 120])[0])
            zone_df["color_g"] = zone_df["TIME_BAND"].map(lambda b: TIME_BAND_COLORS.get(b, [150, 150, 150, 120])[1])
            zone_df["color_b"] = zone_df["TIME_BAND"].map(lambda b: TIME_BAND_COLORS.get(b, [150, 150, 150, 120])[2])
            zone_df["color_a"] = zone_df["TIME_BAND"].map(lambda b: TIME_BAND_COLORS.get(b, [150, 150, 150, 120])[3])
            zone_df["DISPLAY_NAME"] = ""
            zone_df["DISPLAY_CITY"] = ""

            col1, col2, col3, col4 = st.columns(4)
            with col1:
                st.metric("Reachable Hexagons", f"{len(zone_df):,}")
            with col2:
                st.metric("Avg Delivery Time", f"{zone_df['TRAVEL_MINS'].mean():.1f} min")
            with col3:
                st.metric("Max Reach", f"{zone_df['DISTANCE_KM'].max():.0f} km")
            with col4:
                area_km2 = len(zone_df) * 0.74
                st.metric("Coverage Area", f"{area_km2:.0f} km²")

            layers = []

            layers.append(pdk.Layer(
                "H3HexagonLayer",
                zone_df,
                pickable=True,
                stroked=False,
                filled=True,
                extruded=False,
                get_hexagon="HEX_ID",
                get_fill_color="[color_r, color_g, color_b, color_a]",
                opacity=0.7,
            ))

            store_point = pd.DataFrame([{
                "LON": store_row["LON"],
                "LAT": store_row["LAT"],
                "NAME": store_row["NAME"],
            }])

            store_point["DISPLAY_NAME"] = store_row["NAME"]
            store_point["DISPLAY_RETAILER"] = RETAILER_DISPLAY.get(retailer_filter, retailer_filter)
            store_point["DISPLAY_CITY"] = store_row.get("CITY", "")

            layers.append(pdk.Layer(
                "ScatterplotLayer",
                store_point,
                get_position=["LON", "LAT"],
                get_fill_color=RETAILER_COLORS[retailer_filter][:3] + [255],
                get_line_color=[0, 0, 0, 255],
                get_radius=1000,
                pickable=True,
                stroked=True,
                line_width_min_pixels=3,
            ))

            tooltip = {
                "html": "<b>{TIME_BAND}</b><br/>{DISPLAY_NAME}<br/><b>Travel:</b> {TRAVEL_MINS} min<br/><b>Distance:</b> {DISTANCE_KM} km<br/>{DISPLAY_CITY}",
                "style": {"backgroundColor": "#24323D", "color": "white"},
            }

            deck = pdk.Deck(
                map_provider="carto",
                map_style="light",
                layers=layers,
                initial_view_state=pdk.ViewState(
                    latitude=float(store_row["LAT"]),
                    longitude=float(store_row["LON"]),
                    zoom=10,
                    pitch=0,
                ),
                tooltip=tooltip,
            )
            st.pydeck_chart(deck, use_container_width=True)

            st.divider()
            with st.expander("View Detailed Data"):
                st.dataframe(
                    zone_df[["HEX_ID", "TIME_BAND", "TRAVEL_MINS", "DISTANCE_KM"]].sort_values("TRAVEL_MINS"),
                    use_container_width=True,
                    hide_index=True,
                )
        else:
            st.warning("No catchment data found for this store.")
    else:
        st.info("No stores found for this retailer in the selected area.")

st.divider()
st.markdown(f'''
<h1grey>Wholesale Supply Chain Analysis | H3 RES8 (~4.6km) | Powered by Snowflake, Overture Maps & OpenRouteService</h1grey>
''', unsafe_allow_html=True)
