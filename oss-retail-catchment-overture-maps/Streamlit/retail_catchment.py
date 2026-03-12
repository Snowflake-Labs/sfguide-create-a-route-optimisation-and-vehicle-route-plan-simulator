import json
import math
import streamlit as st
import streamlit.components.v1 as components
import pandas as pd
import pydeck as pdk
import branca.colormap as cm
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.functions import col, lit, call_function, object_construct, to_geography
from snowflake.snowpark.types import StringType

st.set_page_config(
    page_title="Retail Catchment Analysis - Overture Maps",
    page_icon="🏪",
    layout="wide",
    initial_sidebar_state="expanded",
)

try:
    with open('extra.css') as f:
        st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)
except Exception:
    pass

try:
    st.logo('logo.svg')
except Exception:
    pass

st.markdown('''
<h0black>RETAIL |</h0black><h0blue> CATCHMENT ANALYSIS</h0blue><BR>
<h1grey>Powered by Carto Overture Maps Data</h1grey>
''', unsafe_allow_html=True)

session = get_active_session()

RETAIL_POIS = "RETAIL_CATCHMENT_DEMO.PUBLIC.RETAIL_POIS"
CITIES_TABLE = "RETAIL_CATCHMENT_DEMO.PUBLIC.CITIES_BY_STATE"
REGIONAL_ADDRESSES = "RETAIL_CATCHMENT_DEMO.PUBLIC.REGIONAL_ADDRESSES"

RETAIL_CATEGORIES = [
    'coffee_shop', 'fast_food_restaurant', 'restaurant', 'casual_eatery',
    'grocery_store', 'convenience_store', 'gas_station', 'pharmacy',
    'clothing_store', 'electronics_store', 'specialty_store', 'gym',
    'beauty_salon', 'hair_salon', 'bakery', 'bar', 'supermarket'
]

CATEGORY_DISPLAY_NAMES = {
    'coffee_shop': 'Coffee Shop',
    'fast_food_restaurant': 'Fast Food Restaurant',
    'restaurant': 'Restaurant',
    'casual_eatery': 'Casual Eatery',
    'grocery_store': 'Grocery Store',
    'convenience_store': 'Convenience Store',
    'gas_station': 'Gas Station',
    'pharmacy': 'Pharmacy',
    'clothing_store': 'Clothing Store',
    'electronics_store': 'Electronics Store',
    'specialty_store': 'Specialty Store',
    'gym': 'Gym / Fitness',
    'beauty_salon': 'Beauty Salon',
    'hair_salon': 'Hair Salon',
    'bakery': 'Bakery',
    'bar': 'Bar',
    'supermarket': 'Supermarket'
}

with st.sidebar:
    st.markdown('<h1sub>Parameters</h1sub>', unsafe_allow_html=True)

    route_functions_option = st.selectbox(
        'OpenRouteService App',
        ['OPEN_ROUTE_SERVICE_SAN_FRANCISCO', 'OPENROUTESERVICE_NATIVE_APP'],
        index=0,
        help="SF Bay Area regional app (faster) or Global native app"
    )

    st.markdown('<h1sub>Retail Category</h1sub>', unsafe_allow_html=True)
    category_display = [CATEGORY_DISPLAY_NAMES.get(c, c) for c in RETAIL_CATEGORIES]
    selected_display = st.selectbox('POI Category', category_display, index=0)
    selected_category = RETAIL_CATEGORIES[category_display.index(selected_display)]
    
    st.markdown('<h1sub>Store Selection</h1sub>', unsafe_allow_html=True)
    search_term = st.text_input('Search store name', '', placeholder='Type to search...')
    
    if search_term:
        stores_query = f"""
            SELECT POI_ID, POI_NAME, BASIC_CATEGORY AS CATEGORY_MAIN, 
                   LATITUDE, LONGITUDE, ADDRESS, CITY
            FROM {RETAIL_POIS}
            WHERE BASIC_CATEGORY = '{selected_category}'
            AND LOWER(POI_NAME) LIKE LOWER('%{search_term}%')
            ORDER BY POI_NAME
            LIMIT 50
        """
    else:
        stores_query = f"""
            SELECT POI_ID, POI_NAME, BASIC_CATEGORY AS CATEGORY_MAIN, 
                   LATITUDE, LONGITUDE, ADDRESS, CITY
            FROM {RETAIL_POIS}
            WHERE BASIC_CATEGORY = '{selected_category}'
            ORDER BY POI_NAME
            LIMIT 50
        """
    stores_df = session.sql(stores_query).to_pandas()
    
    center_lat = 37.7749
    center_lon = -122.4194
    selected_store_name = "Default Location"
    selected_store = None
    
    if not stores_df.empty:
        store_options = [f"{row['POI_NAME']} ({row['CITY']})" for _, row in stores_df.iterrows()]
        selected_store_display = st.selectbox('Select Store', store_options)
        
        if selected_store_display:
            selected_idx = store_options.index(selected_store_display)
            selected_store = stores_df.iloc[selected_idx]
            center_lat = float(selected_store['LATITUDE'])
            center_lon = float(selected_store['LONGITUDE'])
            selected_store_name = selected_store['POI_NAME']
            st.caption(f"📍 {selected_store['ADDRESS']} | Coords: {center_lat:.5f}, {center_lon:.5f}")
    else:
        st.warning(f"No {selected_display} stores found" + (f" matching '{search_term}'" if search_term else ""))

    st.markdown('<h1sub>Travel Mode</h1sub>', unsafe_allow_html=True)
    mode_label = st.selectbox('Mode', ['Walking', 'Driving'])
    profile = 'foot-walking' if mode_label.lower().startswith('walk') else 'driving-car'

    st.markdown('<h1sub>Catchment Zones</h1sub>', unsafe_allow_html=True)
    num_rings = st.slider('Number of zones', min_value=1, max_value=5, value=3)
    max_minutes = st.slider('Max travel time (minutes)', min_value=5, max_value=60, value=15)

    st.markdown('<h1sub>Display Options</h1sub>', unsafe_allow_html=True)
    show_isochrones = st.checkbox('Show catchment boundaries', value=True)
    show_competitors = st.checkbox('Show competitor POIs', value=True)
    show_density = st.checkbox('Show address density (H3)', value=False)
    
    if show_density:
        h3_res = st.slider('H3 resolution', min_value=7, max_value=10, value=8)

    st.caption('Click button below to analyze')
    build = st.button('📊 Analyze Catchment', type='primary')


def minutes_breakpoints(max_mins: int, n: int) -> list:
    if n <= 1:
        return [max_mins]
    step = max(1, math.floor(max_mins / n))
    values = [step * i for i in range(1, n + 1)]
    if values[-1] != max_mins:
        values[-1] = max_mins
    return values


BASE_COLORS = [
    [41, 181, 232],
    [125, 68, 207],
    [212, 91, 144],
    [255, 159, 54],
    [0, 53, 69],
]


def get_palette(num: int) -> list:
    if num <= len(BASE_COLORS):
        return BASE_COLORS[:num]
    return [BASE_COLORS[i % len(BASE_COLORS)] for i in range(num)]


def build_isochrone_single(ors_app: str, profile_name: str, longitude: float, latitude: float, minutes: int) -> dict:
    query = f"""
        SELECT 
            TO_GEOGRAPHY(({ors_app}.CORE.ISOCHRONES('{profile_name}', {longitude}, {latitude}, {minutes}))['features'][0]['geometry']) AS GEO
    """
    result = session.sql(query).to_pandas()
    if not result.empty and result.loc[0, 'GEO'] is not None:
        geo_json = json.loads(result.loc[0, 'GEO'])
        return {
            'minutes': minutes,
            'coordinates': geo_json['coordinates'],
            'geo_wkt': result.loc[0, 'GEO']
        }
    return None


def make_polygon_layers(iso_df: pd.DataFrame):
    if iso_df.empty:
        return []

    sorted_df = iso_df.sort_values('minutes').reset_index(drop=True)
    palette = get_palette(len(sorted_df))

    layers = []
    for i, row in sorted_df.iterrows():
        color = palette[i]
        tooltip_text = f'<b>Catchment Zone {i+1}</b><br/>≤{row["minutes"]} minutes'
        
        layer = pdk.Layer(
            'PolygonLayer',
            data=pd.DataFrame([{
                'coordinates': row['coordinates'], 
                'minutes': row['minutes'],
                'TOOLTIP': tooltip_text
            }]),
            get_polygon='coordinates',
            filled=True,
            opacity=0.35,
            get_fill_color=[color[0], color[1], color[2], 140],
            get_line_color=[color[0], color[1], color[2]],
            line_width_min_pixels=2,
            pickable=True,
        )
        layers.append(layer)
    return layers


def colourise(series: pd.Series, palette: list, vmin, vmax, stops) -> pd.Series:
    cmap = cm.LinearColormap(palette, vmin=vmin, vmax=vmax, index=stops)
    return series.apply(cmap.rgb_bytes_tuple)


col_left, col_right = st.columns([3, 2])

with col_left:
    st.markdown('<h1sub>Map</h1sub>', unsafe_allow_html=True)

    if build and selected_store is not None:
        with st.spinner('Calculating catchment zones...'):
            ring_minutes = minutes_breakpoints(max_minutes, num_rings)
            max_ring = max(ring_minutes)
            
            largest_iso = build_isochrone_single(route_functions_option, profile, center_lon, center_lat, max_ring)
            
            iso_list = [largest_iso] if largest_iso else []
            
            if len(ring_minutes) > 1:
                for mins in ring_minutes[:-1]:
                    iso = build_isochrone_single(route_functions_option, profile, center_lon, center_lat, mins)
                    if iso:
                        iso_list.append(iso)
            
            iso_pdf = pd.DataFrame(iso_list)

        center_df = pd.DataFrame([{
            'lon': center_lon, 
            'lat': center_lat, 
            'TOOLTIP': f'<b>{selected_store_name}</b><br/>{selected_store["ADDRESS"]}<br/>📍 {center_lat:.4f}, {center_lon:.4f}'
        }])
        center_layer = pdk.Layer(
            'ScatterplotLayer',
            data=center_df,
            get_position=['lon', 'lat'],
            get_fill_color=[255, 0, 0],
            get_radius=200,
            pickable=True,
        )

        competitor_layers = []
        all_competitors_df = pd.DataFrame()
        
        if show_competitors and largest_iso:
            categories_str = ','.join([f"'{c}'" for c in RETAIL_CATEGORIES])
            
            with st.spinner(f'Finding competitors within {max_ring} min...'):
                competitors_sql = f"""
                    SELECT POI_ID, POI_NAME, BASIC_CATEGORY AS CATEGORY_MAIN,
                           LATITUDE, LONGITUDE, ADDRESS
                    FROM {RETAIL_POIS}
                    WHERE ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('{largest_iso["geo_wkt"]}'))
                    AND POI_ID != '{selected_store["POI_ID"]}'
                    LIMIT 200
                """
                all_competitors_df = session.sql(competitors_sql).to_pandas()
            
            if not all_competitors_df.empty:
                category_colors = {
                    'coffee_shop': [139, 69, 19],
                    'fast_food_restaurant': [255, 165, 0],
                    'restaurant': [220, 20, 60],
                    'convenience_store': [34, 139, 34],
                    'gas_station': [70, 130, 180],
                    'clothing_store': [186, 85, 211],
                    'grocery_store': [50, 205, 50],
                    'pharmacy': [255, 20, 147],
                }
                
                for category in all_competitors_df['CATEGORY_MAIN'].unique():
                    cat_df = all_competitors_df[all_competitors_df['CATEGORY_MAIN'] == category].copy()
                    display_name = CATEGORY_DISPLAY_NAMES.get(category, category)
                    cat_df['TOOLTIP'] = cat_df.apply(
                        lambda r: f"<b>{r['POI_NAME']}</b><br/>{display_name}<br/>{r['ADDRESS']}",
                        axis=1
                    )
                    cat_df['lon'] = cat_df['LONGITUDE']
                    cat_df['lat'] = cat_df['LATITUDE']
                    
                    layer = pdk.Layer(
                        'ScatterplotLayer',
                        data=cat_df,
                        get_position=['lon', 'lat'],
                        get_fill_color=category_colors.get(category, [128, 128, 128]),
                        get_radius=100,
                        pickable=True,
                    )
                    competitor_layers.append(layer)

        poly_layers = make_polygon_layers(iso_pdf)
        hex_layer = None
        hex_df = pd.DataFrame()

        if show_density and largest_iso:
            with st.spinner(f'Computing address density at H3 res {h3_res}...'):
                density_sql = f"""
                    SELECT 
                        H3_POINT_TO_CELL_STRING(GEOMETRY, {h3_res}) AS H3,
                        COUNT(*) AS COUNT
                    FROM {REGIONAL_ADDRESSES}
                    WHERE ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('{largest_iso["geo_wkt"]}'))
                    GROUP BY 1
                """
                hex_df = session.sql(density_sql).to_pandas()
            
            if not hex_df.empty:
                colors = ["#E3F2FD", "#90CAF9", "#42A5F5", "#1E88E5", "#0D47A1"]
                qs = hex_df['COUNT'].quantile([0, .25, .5, .75, 1])
                hex_df["COLOR"] = colourise(hex_df['COUNT'], colors, qs.min(), qs.max(), qs)
                hex_df["TOOLTIP"] = hex_df.apply(
                    lambda row: f'<b>Address Density</b><br/>Count: {row["COUNT"]:,}<br/>H3: {row["H3"][:12]}...',
                    axis=1
                )
                hex_layer = pdk.Layer(
                    "H3HexagonLayer", hex_df, id="addr_hex",
                    get_hexagon="H3", get_fill_color="COLOR", get_line_color="COLOR",
                    pickable=True, auto_highlight=True,
                    extruded=False, coverage=1, opacity=0.5,
                )

        layers_to_render = []
        if show_isochrones:
            layers_to_render.extend(list(reversed(poly_layers)))
        if hex_layer is not None:
            layers_to_render.append(hex_layer)
        if show_competitors:
            layers_to_render.extend(competitor_layers)
        layers_to_render.append(center_layer)

        view_state = pdk.ViewState(
            longitude=center_lon,
            latitude=center_lat,
            zoom=13,
            pitch=0
        )

        tooltip = {
            'html': '{TOOLTIP}',
            'style': {
                'backgroundColor': '#29B5E8',
                'color': 'white',
                'fontSize': '12px',
                'padding': '8px',
                'borderRadius': '4px'
            }
        }

        st.pydeck_chart(pdk.Deck(
            layers=layers_to_render,
            map_style=None,
            initial_view_state=view_state,
            tooltip=tooltip,
            height=600,
        ))

        st.markdown("---")
        competitor_count = len(all_competitors_df) if not all_competitors_df.empty else 0
        address_count = hex_df['COUNT'].sum() if not hex_df.empty else 0
        
        stats_html = f"""
        <div style='display:flex; gap:20px; margin:15px 0;'>
            <div style='flex:1; background:linear-gradient(135deg, #29B5E8 0%, #1a8ab8 100%); padding:15px 20px; border-radius:8px; color:white;'>
                <div style='font-size:0.85rem; opacity:0.9;'>Selected Store</div>
                <div style='font-size:1.1rem; font-weight:600; margin-top:4px;'>{selected_store_name}</div>
            </div>
            <div style='flex:1; background:linear-gradient(135deg, #29B5E8 0%, #1a8ab8 100%); padding:15px 20px; border-radius:8px; color:white;'>
                <div style='font-size:0.85rem; opacity:0.9;'>Travel Time</div>
                <div style='font-size:1.4rem; font-weight:600; margin-top:4px;'>{max_minutes} min</div>
            </div>
            <div style='flex:1; background:linear-gradient(135deg, #29B5E8 0%, #1a8ab8 100%); padding:15px 20px; border-radius:8px; color:white;'>
                <div style='font-size:0.85rem; opacity:0.9;'>Competitors</div>
                <div style='font-size:1.4rem; font-weight:600; margin-top:4px;'>{competitor_count:,}</div>
            </div>
            <div style='flex:1; background:linear-gradient(135deg, #29B5E8 0%, #1a8ab8 100%); padding:15px 20px; border-radius:8px; color:white;'>
                <div style='font-size:0.85rem; opacity:0.9;'>Addresses in Zone</div>
                <div style='font-size:1.4rem; font-weight:600; margin-top:4px;'>{int(address_count):,}</div>
            </div>
        </div>
        """
        components.html(stats_html, height=90)

        if not all_competitors_df.empty:
            st.markdown('<h1sub>COMPETITOR |</h1sub><h1blue> BREAKDOWN</h1blue>', unsafe_allow_html=True)
            breakdown = all_competitors_df.groupby('CATEGORY_MAIN').size().reset_index(name='Count')
            breakdown['Category'] = breakdown['CATEGORY_MAIN'].map(CATEGORY_DISPLAY_NAMES)
            breakdown = breakdown[['Category', 'Count']].sort_values('Count', ascending=False).reset_index(drop=True)
            
            col_table, col_empty = st.columns([2, 1])
            with col_table:
                st.dataframe(breakdown, use_container_width=True, hide_index=True)

    else:
        st.info('Select a store location and click "Analyze Catchment" to begin.')

with col_right:
    st.markdown('<h1sub>Legend</h1sub>', unsafe_allow_html=True)
    
    if build and selected_store is not None:
        mins = sorted(minutes_breakpoints(max_minutes, num_rings))
        palette = get_palette(len(mins))

        rows = []
        rows.append("""
            <div style='display:flex;align-items:center;margin:6px 0;'>
              <span style='display:inline-block;width:14px;height:14px;background-color: rgb(255,0,0);border-radius:50%;margin-right:8px;'></span>
              <span style='font-size:0.95rem;'>Selected Store</span>
            </div>
        """)
        
        for m, (r, g, b) in zip(mins, palette):
            rows.append(f"""
                <div style='display:flex;align-items:center;margin:6px 0;'>
                  <span style='display:inline-block;width:14px;height:14px;background-color: rgb({r},{g},{b});border-radius:3px;margin-right:8px;opacity:0.7;'></span>
                  <span style='font-size:0.95rem;'>≤ {m} min ({mode_label})</span>
                </div>
            """)
        
        html = f"<div style='padding:4px 2px;'>{''.join(rows)}</div>"
        components.html(html, height=min(300, 36 * len(rows) + 20))
        
    else:
        st.caption('Legend appears after analysis')
