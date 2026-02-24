import json
import math
import random
import hashlib
import streamlit as st
import streamlit.components.v1 as components
import pandas as pd
import pydeck as pdk
import branca.colormap as cm
from snowflake.snowpark.context import get_active_session

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

ORS_APP_NAME = "OPENROUTESERVICE_NATIVE_APP"

@st.cache_data(ttl=300)
def check_ors_service_status():
    try:
        test_query = f"""
            SELECT {ORS_APP_NAME}.CORE.ISOCHRONES('driving-car', -122.4194, 37.7749, 1) AS TEST_ISO
        """
        session.sql(test_query).collect()
        return True, "ORS services available"
    except Exception as e:
        error_msg = str(e)
        if "does not exist" in error_msg.lower() or "unknown function" in error_msg.lower():
            return False, f"OpenRouteService Native App '{ORS_APP_NAME}' not found or not installed."
        elif "access" in error_msg.lower() or "privilege" in error_msg.lower():
            return False, f"No access to OpenRouteService app. Please grant access to your role."
        elif "500" in error_msg or "remote service error" in error_msg.lower():
            return False, "ORS container services are not running or not responding."
        else:
            return False, f"ORS Error: {error_msg[:200]}"

ors_ok, ors_message = check_ors_service_status()

if not ors_ok:
    st.error("**OpenRouteService Not Available**")
    st.markdown(f"""
**Issue:** {ors_message}

### How to Fix

1. **Check if the app is installed:**
   ```sql
   SHOW APPLICATIONS LIKE 'OPENROUTESERVICE%';
   ```

2. **Start the services** (if installed but not running):
   - Go to **Data Products -> Apps** in Snowsight
   - Find **OpenRouteService Native App**
   - Click on the app and ensure services are **RUNNING**
   - If suspended, click **Resume** or **Activate**

3. **Install the app** (if not installed):
   - Complete the [Install OpenRouteService Native App](https://quickstarts.snowflake.com/guide/oss-install-openrouteservice-native-app/) quickstart

4. **Grant privileges** (if access denied):
   ```sql
   GRANT APPLICATION ROLE {ORS_APP_NAME}.APP_USER TO ROLE <your_role>;
   ```

Once the services are running, refresh this page.
""")
    st.stop()

RETAIL_POIS = "OPENROUTESERVICE_NATIVE_APP.RETAIL_CATCHMENT_DEMO.RETAIL_POIS"
REGIONAL_ADDRESSES = "OPENROUTESERVICE_NATIVE_APP.RETAIL_CATCHMENT_DEMO.REGIONAL_ADDRESSES"

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

BASE_COLORS = [
    [41, 181, 232],
    [125, 68, 207],
    [212, 91, 144],
    [255, 159, 54],
    [0, 53, 69],
]

SELECTED_STORE_COLOR = [255, 0, 0]
COMPETITOR_COLOR = [255, 129, 0]
RECOMMENDED_COLOR = [0, 200, 83]

def get_palette(num: int) -> list:
    if num <= len(BASE_COLORS):
        return BASE_COLORS[:num]
    return [BASE_COLORS[i % len(BASE_COLORS)] for i in range(num)]

def minutes_breakpoints(max_mins: int, n: int) -> list:
    if n <= 1:
        return [max_mins]
    step = max(1, math.floor(max_mins / n))
    values = [step * i for i in range(1, n + 1)]
    if values[-1] != max_mins:
        values[-1] = max_mins
    return values

@st.cache_data(ttl=600)
def get_stores(category: str, city: str, search: str):
    if search:
        query = f"""
            SELECT POI_ID, POI_NAME, BASIC_CATEGORY AS CATEGORY_MAIN, 
                   LATITUDE, LONGITUDE, ADDRESS, CITY
            FROM {RETAIL_POIS}
            WHERE BASIC_CATEGORY = '{category}'
            AND CITY = '{city}'
            AND LOWER(POI_NAME) LIKE LOWER('%{search}%')
            ORDER BY POI_NAME
            LIMIT 50
        """
    else:
        query = f"""
            SELECT POI_ID, POI_NAME, BASIC_CATEGORY AS CATEGORY_MAIN, 
                   LATITUDE, LONGITUDE, ADDRESS, CITY
            FROM {RETAIL_POIS}
            WHERE BASIC_CATEGORY = '{category}'
            AND CITY = '{city}'
            ORDER BY POI_NAME
            LIMIT 50
        """
    return session.sql(query).to_pandas()

def build_isochrone(ors_app: str, profile_name: str, longitude: float, latitude: float, minutes: int):
    query = f"""
        SELECT 
            ST_ASGEOJSON(TO_GEOGRAPHY(({ors_app}.CORE.ISOCHRONES('{profile_name}', {longitude}, {latitude}, {minutes}))['features'][0]['geometry'])) AS GEO_JSON,
            ST_ASWKT(TO_GEOGRAPHY(({ors_app}.CORE.ISOCHRONES('{profile_name}', {longitude}, {latitude}, {minutes}))['features'][0]['geometry'])) AS GEO_WKT
    """
    result = session.sql(query).to_pandas()
    if not result.empty and result.loc[0, 'GEO_JSON'] is not None:
        geo_json = json.loads(result.loc[0, 'GEO_JSON'])
        coords = geo_json['coordinates']
        if coords and len(coords) > 0:
            coords = coords[0]
        return {
            'minutes': minutes,
            'coordinates': coords,
            'geo_wkt': result.loc[0, 'GEO_WKT']
        }
    return None

def get_competitors(geo_wkt: str, exclude_poi_id: str, category: str):
    query = f"""
        SELECT POI_ID, POI_NAME, BASIC_CATEGORY AS CATEGORY_MAIN,
               LATITUDE, LONGITUDE, ADDRESS, POSTCODE
        FROM {RETAIL_POIS}
        WHERE ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('{geo_wkt}'))
        AND POI_ID != '{exclude_poi_id}'
        AND BASIC_CATEGORY = '{category}'
        ORDER BY POI_NAME
        LIMIT 200
    """
    return session.sql(query).to_pandas()

def get_address_density(geo_wkt: str, h3_res: int):
    query = f"""
        SELECT 
            H3_POINT_TO_CELL_STRING(GEOMETRY, {h3_res}) AS H3,
            COUNT(*) AS COUNT
        FROM {REGIONAL_ADDRESSES}
        WHERE ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('{geo_wkt}'))
        GROUP BY 1
    """
    return session.sql(query).to_pandas()

def colourise_grey(series: pd.Series) -> pd.Series:
    colors = ["#E8E8E8", "#C0C0C0", "#909090", "#606060", "#404040"]
    vmin, vmax = series.min(), series.max()
    qs = series.quantile([0, .25, .5, .75, 1])
    cmap = cm.LinearColormap(colors, vmin=vmin, vmax=vmax, index=qs)
    return series.apply(cmap.rgb_bytes_tuple)

def generate_synthetic_seed(poi_id: str, lat: float, lon: float) -> int:
    seed_str = f"{poi_id}-{lat:.4f}-{lon:.4f}"
    return int(hashlib.md5(seed_str.encode()).hexdigest()[:8], 16)

CATEGORY_FOOTFALL_RANGES = {
    'coffee_shop': (400, 1200),
    'fast_food_restaurant': (800, 2500),
    'restaurant': (200, 800),
    'casual_eatery': (300, 1000),
    'grocery_store': (1500, 4000),
    'convenience_store': (600, 1800),
    'gas_station': (800, 2000),
    'pharmacy': (300, 900),
    'clothing_store': (200, 800),
    'electronics_store': (150, 600),
    'specialty_store': (100, 500),
    'gym': (300, 1200),
    'beauty_salon': (50, 200),
    'hair_salon': (40, 180),
    'bakery': (200, 800),
    'bar': (150, 600),
    'supermarket': (2000, 6000),
}

def generate_store_footfall(poi_id: str, category: str, lat: float, lon: float) -> int:
    seed = generate_synthetic_seed(poi_id, lat, lon)
    random.seed(seed)
    low, high = CATEGORY_FOOTFALL_RANGES.get(category, (200, 1000))
    return random.randint(low, high)

def generate_population_density(lat: float, lon: float, address_count: int) -> int:
    seed = generate_synthetic_seed("pop", lat, lon)
    random.seed(seed)
    base_density = 5000 + random.randint(0, 10000)
    if address_count > 5000:
        base_density += 3000
    elif address_count > 2000:
        base_density += 1500
    return base_density

def generate_household_income(lat: float, lon: float) -> int:
    seed = generate_synthetic_seed("income", lat, lon)
    random.seed(seed)
    return random.randint(45000, 125000)

def generate_h3_demographics(h3_cell: str, address_count: int) -> dict:
    seed = int(hashlib.md5(h3_cell.encode()).hexdigest()[:8], 16)
    random.seed(seed)
    income = random.randint(45000, 145000)
    age_median = random.randint(28, 55)
    homeowner_pct = random.randint(25, 75)
    college_educated_pct = random.randint(20, 70)
    families_with_children_pct = random.randint(15, 50)
    return {
        'h3': h3_cell,
        'address_count': address_count,
        'median_income': income,
        'median_age': age_median,
        'homeowner_pct': homeowner_pct,
        'college_educated_pct': college_educated_pct,
        'families_with_children_pct': families_with_children_pct,
    }

def h3_to_lat_lon(h3_cell: str) -> tuple:
    query = f"SELECT ST_Y(H3_CELL_TO_POINT('{h3_cell}')) AS LAT, ST_X(H3_CELL_TO_POINT('{h3_cell}')) AS LON"
    result = session.sql(query).collect()
    if result:
        return float(result[0]['LAT']), float(result[0]['LON'])
    return None, None

def calculate_location_score(demographics: dict, competitor_distances: list, category: str) -> float:
    density_score = min(demographics['address_count'] / 100, 100) * 0.25
    income_score = min((demographics['median_income'] - 40000) / 100000, 1.0) * 100 * 0.20
    min_competitor_dist = min(competitor_distances) if competitor_distances else 999
    competitor_score = min(min_competitor_dist / 0.005, 100) * 0.30
    education_score = demographics['college_educated_pct'] * 0.15
    family_score = demographics['families_with_children_pct'] * 0.10
    return density_score + income_score + competitor_score + education_score + family_score

def find_optimal_location(hex_df: pd.DataFrame, competitors_df: pd.DataFrame, 
                          store_lat: float, store_lon: float, category: str) -> tuple:
    if hex_df.empty:
        return store_lat + random.uniform(-0.01, 0.01), store_lon + random.uniform(-0.01, 0.01), None
    
    best_score = -1
    best_location = (store_lat, store_lon)
    best_h3_data = None
    
    sorted_hex = hex_df.nlargest(20, 'COUNT')
    
    for _, row in sorted_hex.iterrows():
        h3_cell = row['H3']
        demographics = generate_h3_demographics(h3_cell, row['COUNT'])
        
        h3_lat, h3_lon = h3_to_lat_lon(h3_cell)
        if h3_lat is None:
            continue
        
        competitor_distances = []
        if not competitors_df.empty:
            for _, comp in competitors_df.iterrows():
                dist = ((h3_lat - comp['LATITUDE'])**2 + (h3_lon - comp['LONGITUDE'])**2)**0.5
                competitor_distances.append(dist)
        
        store_dist = ((h3_lat - store_lat)**2 + (h3_lon - store_lon)**2)**0.5
        if store_dist < 0.002:
            continue
        
        score = calculate_location_score(demographics, competitor_distances, category)
        
        if score > best_score:
            best_score = score
            best_location = (h3_lat, h3_lon)
            best_h3_data = demographics
    
    return best_location[0], best_location[1], best_h3_data

def generate_market_analysis(store_name: str, store_category: str, store_category_display: str,
                              store_poi_id: str, store_lat: float, store_lon: float,
                              competitors_df: pd.DataFrame, address_count: int, max_minutes: int,
                              hex_df: pd.DataFrame = None) -> dict:
    store_footfall = generate_store_footfall(store_poi_id, store_category, store_lat, store_lon)
    
    competitor_footfall = 0
    competitor_details = []
    if not competitors_df.empty:
        for _, row in competitors_df.iterrows():
            cf = generate_store_footfall(row['POI_ID'], store_category, row['LATITUDE'], row['LONGITUDE'])
            competitor_footfall += cf
            competitor_details.append({'name': row['POI_NAME'], 'footfall': cf})
    
    population_density = generate_population_density(store_lat, store_lon, address_count)
    household_income = generate_household_income(store_lat, store_lon)
    
    if hex_df is not None and not hex_df.empty:
        rec_lat, rec_lon, rec_h3_data = find_optimal_location(hex_df, competitors_df, store_lat, store_lon, store_category)
    else:
        seed = generate_synthetic_seed(store_poi_id, store_lat, store_lon)
        random.seed(seed)
        rec_lat = store_lat + random.uniform(-0.01, 0.01)
        rec_lon = store_lon + random.uniform(-0.01, 0.01)
        rec_h3_data = None
    
    return {
        'store_footfall': store_footfall,
        'competitor_footfall': competitor_footfall,
        'competitor_details': sorted(competitor_details, key=lambda x: x['footfall'], reverse=True)[:5],
        'population_density': population_density,
        'household_income': household_income,
        'address_count': address_count,
        'recommended_location': (rec_lat, rec_lon),
        'recommended_h3_data': rec_h3_data,
        'h3_cell_count': max(50, address_count // 25),
    }

with st.sidebar:
    st.markdown('<h1sub>Parameters</h1sub>', unsafe_allow_html=True)
    st.caption(f"Using: {ORS_APP_NAME}")

    st.markdown('<h1sub>Retail Category</h1sub>', unsafe_allow_html=True)
    category_display = [CATEGORY_DISPLAY_NAMES.get(c, c) for c in RETAIL_CATEGORIES]
    selected_display = st.selectbox('POI Category', category_display, index=0)
    selected_category = RETAIL_CATEGORIES[category_display.index(selected_display)]
    
    st.markdown('<h1sub>Store Selection</h1sub>', unsafe_allow_html=True)
    selected_city = st.selectbox('City', ['San Francisco'], index=0, help="ORS coverage: San Francisco only")
    search_term = st.text_input('Search store name', '', placeholder='Type to search...')
    
    stores_df = get_stores(selected_category, selected_city, search_term)
    
    selected_store = None
    if not stores_df.empty:
        store_options = [f"{row['POI_NAME']} ({row['CITY']})" for _, row in stores_df.iterrows()]
        selected_store_display = st.selectbox('Select Store', store_options)
        
        if selected_store_display:
            selected_idx = store_options.index(selected_store_display)
            selected_store = stores_df.iloc[selected_idx]
            st.caption(f"📍 {selected_store['ADDRESS']}")
    else:
        st.warning(f"No {selected_display} stores found" + (f" matching '{search_term}'" if search_term else ""))

    st.markdown('<h1sub>Travel Mode</h1sub>', unsafe_allow_html=True)
    profile = st.selectbox('Mode', ['driving-car', 'cycling-regular', 'foot-walking'])

    st.markdown('<h1sub>Catchment Zones</h1sub>', unsafe_allow_html=True)
    num_rings = st.slider('Number of zones', min_value=1, max_value=5, value=3)
    max_minutes = st.slider('Max travel time (minutes)', min_value=5, max_value=60, value=15)

    st.markdown('<h1sub>Display Options</h1sub>', unsafe_allow_html=True)
    show_isochrones = st.checkbox('Show catchment boundaries', value=True)
    show_competitors = st.checkbox('Show competitor POIs', value=True)
    show_density = st.checkbox('Show address density (H3)', value=False)
    
    h3_res = 8
    if show_density:
        h3_res = st.slider('H3 resolution', min_value=7, max_value=10, value=8)

    st.caption('Click button below to analyze')
    build = st.button('📊 Analyze Catchment', type='primary')

if build and selected_store is not None:
    store_lat = float(selected_store['LATITUDE'])
    store_lon = float(selected_store['LONGITUDE'])
    store_name = selected_store['POI_NAME']
    store_address = selected_store['ADDRESS']
    store_poi_id = selected_store['POI_ID']
    
    ring_minutes = minutes_breakpoints(max_minutes, num_rings)
    
    st.session_state['analysis'] = {
        'store_lat': store_lat,
        'store_lon': store_lon,
        'store_name': store_name,
        'store_address': store_address,
        'store_poi_id': store_poi_id,
        'store_category': selected_category,
        'store_category_display': selected_display,
        'ring_minutes': ring_minutes,
        'max_minutes': max_minutes,
        'profile': profile,
        'show_isochrones': show_isochrones,
        'show_competitors': show_competitors,
        'show_density': show_density,
        'h3_res': h3_res,
    }

if 'analysis' in st.session_state:
    a = st.session_state['analysis']
    ma = st.session_state.get('market_analysis', {})
    comp_df = st.session_state.get('competitors_df', pd.DataFrame())
    competitor_count = len(comp_df) if not comp_df.empty else 0
    address_count = ma.get('address_count', 0)
    
    kpi1, kpi2, kpi3, kpi4 = st.columns(4)
    with kpi1:
        st.metric("Selected Store", a['store_name'][:25] + "..." if len(a['store_name']) > 25 else a['store_name'])
    with kpi2:
        st.metric("Travel Time", f"{a['max_minutes']} min ({a['profile']})")
    with kpi3:
        st.metric("Competitors", f"{competitor_count:,}")
    with kpi4:
        st.metric("Addresses in Zone", f"{address_count:,}")
    st.markdown("---")

col_left, col_right = st.columns([3, 2])

with col_left:
    st.markdown('<h1sub>Map</h1sub>', unsafe_allow_html=True)

    if 'analysis' in st.session_state:
        a = st.session_state['analysis']
        store_lat = a['store_lat']
        store_lon = a['store_lon']
        store_name = a['store_name']
        store_address = a['store_address']
        store_poi_id = a['store_poi_id']
        ring_minutes = a['ring_minutes']
        analysis_max_minutes = a['max_minutes']
        analysis_mode = a['profile']
        analysis_profile = a['profile']
        
        with st.spinner('Building isochrones...'):
            iso_list = []
            largest_iso = None
            for mins in ring_minutes:
                iso = build_isochrone(ORS_APP_NAME, analysis_profile, store_lon, store_lat, mins)
                if iso:
                    iso_list.append(iso)
                    if largest_iso is None or mins > largest_iso['minutes']:
                        largest_iso = iso
        
        iso_pdf = pd.DataFrame(iso_list) if iso_list else pd.DataFrame()
        
        center_df = pd.DataFrame([{
            'lon': store_lon, 
            'lat': store_lat, 
            'TOOLTIP': f'<b>{store_name}</b><br/>{store_address}<br/>Selected Store'
        }])
        center_layer = pdk.Layer(
            'ScatterplotLayer',
            data=center_df,
            get_position=['lon', 'lat'],
            get_fill_color=SELECTED_STORE_COLOR,
            get_radius=200,
            pickable=True,
        )

        all_competitors_df = pd.DataFrame()
        competitor_layer = None
        store_category = a['store_category']
        store_category_display = a['store_category_display']
        
        if a['show_competitors'] and largest_iso:
            with st.spinner(f'Finding {store_category_display} competitors...'):
                all_competitors_df = get_competitors(largest_iso['geo_wkt'], store_poi_id, store_category)
            
            if not all_competitors_df.empty:
                all_competitors_df['TOOLTIP'] = all_competitors_df.apply(
                    lambda row: f"<b>{row['POI_NAME']}</b><br/>{store_category_display}<br/>{row['ADDRESS']}",
                    axis=1
                )
                all_competitors_df['lon'] = all_competitors_df['LONGITUDE']
                all_competitors_df['lat'] = all_competitors_df['LATITUDE']
                
                competitor_layer = pdk.Layer(
                    'ScatterplotLayer',
                    data=all_competitors_df,
                    get_position=['lon', 'lat'],
                    get_fill_color=COMPETITOR_COLOR,
                    get_radius=80,
                    pickable=True,
                )

        poly_layers = []
        if not iso_pdf.empty:
            sorted_df = iso_pdf.sort_values('minutes').reset_index(drop=True)
            palette = get_palette(len(sorted_df))
            
            for i, row in sorted_df.iterrows():
                color = palette[i]
                tooltip_text = f'<b>Catchment Zone {i+1}</b><br/>{row["minutes"]} minutes'
                
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
                poly_layers.append(layer)

        hex_layer = None
        hex_df = pd.DataFrame()
        
        if a['show_density'] and largest_iso:
            with st.spinner('Computing address density...'):
                hex_df = get_address_density(largest_iso['geo_wkt'], a['h3_res'])
            
            if not hex_df.empty:
                hex_df["COLOR"] = colourise_grey(hex_df['COUNT'])
                hex_df["TOOLTIP"] = hex_df.apply(
                    lambda row: f'<b>Address Density</b><br/>Count: {row["COUNT"]:,}<br/>H3: {row["H3"][:12]}...',
                    axis=1
                )
                hex_layer = pdk.Layer(
                    "H3HexagonLayer", hex_df, id="addr_hex",
                    get_hexagon="H3", get_fill_color="COLOR", get_line_color="COLOR",
                    pickable=True, auto_highlight=True,
                    extruded=False, coverage=1, opacity=0.6,
                )

        analysis_hex_df = hex_df.copy() if not hex_df.empty else pd.DataFrame()
        address_count = int(hex_df['COUNT'].sum()) if not hex_df.empty else 0
        if address_count == 0 and largest_iso:
            with st.spinner('Computing address density for optimal location...'):
                analysis_hex_df = get_address_density(largest_iso['geo_wkt'], 8)
                if not analysis_hex_df.empty:
                    address_count = int(analysis_hex_df['COUNT'].sum())
        
        st.session_state['competitors_df'] = all_competitors_df
        st.session_state['market_analysis'] = generate_market_analysis(
            store_name=store_name,
            store_category=store_category,
            store_category_display=store_category_display,
            store_poi_id=store_poi_id,
            store_lat=store_lat,
            store_lon=store_lon,
            competitors_df=all_competitors_df,
            address_count=address_count,
            max_minutes=analysis_max_minutes,
            hex_df=analysis_hex_df
        )
        
        ma = st.session_state['market_analysis']
        rec_h3 = ma.get('recommended_h3_data')
        if rec_h3:
            rec_tooltip = f"<b>Recommended New Location</b><br/>Based on address density & demographics<br/>Addresses: {rec_h3['address_count']:,}<br/>Median Income: ${rec_h3['median_income']:,}<br/>College Educated: {rec_h3['college_educated_pct']}%<br/>Families w/Children: {rec_h3['families_with_children_pct']}%"
        else:
            rec_tooltip = f'<b>Recommended New Location</b><br/>{ma["recommended_location"][0]:.4f}, {ma["recommended_location"][1]:.4f}'
        recommended_df = pd.DataFrame([{
            'lon': ma['recommended_location'][1], 
            'lat': ma['recommended_location'][0], 
            'TOOLTIP': rec_tooltip
        }])
        recommended_layer = pdk.Layer(
            'ScatterplotLayer',
            data=recommended_df,
            get_position=['lon', 'lat'],
            get_fill_color=RECOMMENDED_COLOR,
            get_radius=180,
            pickable=True,
        )

        layers_to_render = []
        if a['show_isochrones']:
            layers_to_render.extend(list(reversed(poly_layers)))
        if hex_layer is not None:
            layers_to_render.append(hex_layer)
        if a['show_competitors'] and competitor_layer is not None:
            layers_to_render.append(competitor_layer)
        layers_to_render.append(recommended_layer)
        layers_to_render.append(center_layer)

        view_state = pdk.ViewState(
            longitude=store_lon,
            latitude=store_lat,
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
            height=750,
        ))
        st.caption("*Demographic data (footfall, income, population density) is synthetically generated for demonstration purposes. Real data: POI locations (Overture Maps), address density (Overture Maps), isochrones (OpenRouteService).*")

    else:
        st.info('Select a store location and click "Analyze Catchment" to begin.')

with col_right:
    if 'analysis' in st.session_state:
        a = st.session_state['analysis']
        mins = sorted(a['ring_minutes'])
        palette = get_palette(len(mins))
        analysis_mode = a['profile']
        
        legend_html = f"""
        <div style='font-family: "Source Sans Pro", -apple-system, BlinkMacSystemFont, sans-serif; background:#f8f9fa; padding:15px 20px; border-radius:8px; border:1px solid #e9ecef;'>
            <div style='font-weight:600; color:#333; margin-bottom:12px; font-size:0.95rem;'>LEGEND</div>
            <div style='display:flex;align-items:center;margin:8px 0;'>
                <span style='display:inline-block;width:16px;height:16px;background-color:rgb({SELECTED_STORE_COLOR[0]},{SELECTED_STORE_COLOR[1]},{SELECTED_STORE_COLOR[2]});border-radius:50%;margin-right:10px;'></span>
                <span style='font-size:0.9rem;color:#333;'>Selected Store</span>
            </div>
            <div style='display:flex;align-items:center;margin:8px 0;'>
                <span style='display:inline-block;width:16px;height:16px;background-color:rgb({COMPETITOR_COLOR[0]},{COMPETITOR_COLOR[1]},{COMPETITOR_COLOR[2]});border-radius:50%;margin-right:10px;'></span>
                <span style='font-size:0.9rem;color:#333;'>Competitors</span>
            </div>
            <div style='display:flex;align-items:center;margin:8px 0;'>
                <span style='display:inline-block;width:16px;height:16px;background-color:rgb({RECOMMENDED_COLOR[0]},{RECOMMENDED_COLOR[1]},{RECOMMENDED_COLOR[2]});border-radius:50%;margin-right:10px;'></span>
                <span style='font-size:0.9rem;color:#333;'>Recommended Location</span>
            </div>
        """
        
        for m, (red, green, blue) in zip(mins, palette):
            legend_html += f"""
            <div style='display:flex;align-items:center;margin:8px 0;'>
                <span style='display:inline-block;width:16px;height:16px;background-color:rgb({red},{green},{blue});border-radius:3px;margin-right:10px;opacity:0.7;'></span>
                <span style='font-size:0.9rem;color:#333;'>{m} min ({analysis_mode})</span>
            </div>
            """
        
        if a['show_density']:
            legend_html += """
            <div style='display:flex;align-items:center;margin:8px 0;'>
                <span style='display:inline-block;width:16px;height:16px;background:linear-gradient(90deg, #E8E8E8, #404040);border-radius:3px;margin-right:10px;'></span>
                <span style='font-size:0.9rem;color:#333;'>Address Density (H3)</span>
            </div>
            """
        
        legend_html += "</div>"
        components.html(legend_html, height=min(280, 80 + 36 * (len(mins) + 4)))
        
    else:
        st.caption('Legend appears after analysis')
    
    if 'analysis' in st.session_state and 'market_analysis' in st.session_state:
        st.markdown('<div style="font-size:1.1rem; font-weight:600; margin:10px 0;"><span style="color:#333;">AI-POWERED</span><span style="color:#29B5E8;"> | MARKET ANALYSIS</span></div>', unsafe_allow_html=True)
        
        ma = st.session_state['market_analysis']
        a = st.session_state['analysis']
        
        st.markdown(f"""
        <div style='background:linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding:12px 16px; border-radius:8px; margin:8px 0; border-left:4px solid rgb({SELECTED_STORE_COLOR[0]},{SELECTED_STORE_COLOR[1]},{SELECTED_STORE_COLOR[2]});'>
            <div style='color:rgb({SELECTED_STORE_COLOR[0]},{SELECTED_STORE_COLOR[1]},{SELECTED_STORE_COLOR[2]}); font-weight:600; font-size:0.85rem;'>STORE PERFORMANCE ANALYSIS</div>
            <div style='color:#333; font-size:0.8rem; margin-top:6px; line-height:1.5;'>
                <b>{a['store_name']}</b> shows daily footfall of <b style='color:rgb({SELECTED_STORE_COLOR[0]},{SELECTED_STORE_COLOR[1]},{SELECTED_STORE_COLOR[2]});'>{ma['store_footfall']:,} VISITORS</b> in prime San Francisco district with good visibility and access.
            </div>
        </div>
        """, unsafe_allow_html=True)
        
        st.markdown(f"""
        <div style='background:linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding:12px 16px; border-radius:8px; margin:8px 0; border-left:4px solid #7D44CF;'>
            <div style='color:#7D44CF; font-weight:600; font-size:0.85rem;'>CATCHMENT AREA INSIGHTS</div>
            <div style='color:#333; font-size:0.8rem; margin-top:6px; line-height:1.5;'>
                Analysis covers <b>{len(a['ring_minutes'])} catchment zones</b> within {a['max_minutes']}-minute {a['profile']} radius with <b style='color:#7D44CF;'>{ma['address_count']:,} RESIDENTIAL ADDRESSES</b> and {ma['h3_cell_count']} H3 cells.
            </div>
        </div>
        """, unsafe_allow_html=True)
        
        competitor_names = ", ".join([f"<b style='color:rgb({COMPETITOR_COLOR[0]},{COMPETITOR_COLOR[1]},{COMPETITOR_COLOR[2]});'>{c['name']}</b>" for c in ma['competitor_details'][:3]]) if ma['competitor_details'] else "None identified"
        competitor_count = len(st.session_state.get('competitors_df', [])) if 'competitors_df' in st.session_state else 0
        st.markdown(f"""
        <div style='background:linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding:12px 16px; border-radius:8px; margin:8px 0; border-left:4px solid rgb({COMPETITOR_COLOR[0]},{COMPETITOR_COLOR[1]},{COMPETITOR_COLOR[2]});'>
            <div style='color:rgb({COMPETITOR_COLOR[0]},{COMPETITOR_COLOR[1]},{COMPETITOR_COLOR[2]}); font-weight:600; font-size:0.85rem;'>COMPETITIVE LANDSCAPE</div>
            <div style='color:#333; font-size:0.8rem; margin-top:6px; line-height:1.5;'>
                <b>{competitor_count} competitors</b> in trade area: {competitor_names}. Combined footfall of <b style='color:rgb({COMPETITOR_COLOR[0]},{COMPETITOR_COLOR[1]},{COMPETITOR_COLOR[2]});'>{ma['competitor_footfall']:,} DAILY VISITORS</b>.
            </div>
        </div>
        """, unsafe_allow_html=True)
        
        st.markdown(f"""
        <div style='background:linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding:12px 16px; border-radius:8px; margin:8px 0; border-left:4px solid #D45B90;'>
            <div style='color:#D45B90; font-weight:600; font-size:0.85rem;'>DEMOGRAPHIC PROFILE</div>
            <div style='color:#333; font-size:0.8rem; margin-top:6px; line-height:1.5;'>
                Population density of <b style='color:#D45B90;'>{ma['population_density']:,}</b> per sq mile. Average household income <b style='color:#D45B90;'>${ma['household_income']:,}</b>. Strong alignment with {a['store_category_display'].lower()} customer profile.
            </div>
        </div>
        """, unsafe_allow_html=True)
        
        st.markdown(f"""
        <div style='background:linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding:12px 16px; border-radius:8px; margin:8px 0; border-left:4px solid rgb({RECOMMENDED_COLOR[0]},{RECOMMENDED_COLOR[1]},{RECOMMENDED_COLOR[2]});'>
            <div style='color:rgb({RECOMMENDED_COLOR[0]},{RECOMMENDED_COLOR[1]},{RECOMMENDED_COLOR[2]}); font-weight:600; font-size:0.85rem;'>RECOMMENDED NEW STORE LOCATION</div>
            <div style='color:#333; font-size:0.8rem; margin-top:6px; line-height:1.5;'>
                <b>COORDINATES:</b> {ma['recommended_location'][0]:.4f}, {ma['recommended_location'][1]:.4f}
            </div>
        </div>
        """, unsafe_allow_html=True)

if 'analysis' in st.session_state and 'competitors_df' in st.session_state:
    all_competitors_df = st.session_state['competitors_df']
    if not all_competitors_df.empty:
        a = st.session_state['analysis']
        ma = st.session_state['market_analysis']
        store_category_display = a['store_category_display']
        
        st.markdown(f'<div style="font-size:1.1rem; font-weight:600; margin:15px 0 10px 0;"><span style="color:#333;">{store_category_display.upper()}</span><span style="color:#29B5E8;"> | COMPETITORS ({len(all_competitors_df)})</span></div>', unsafe_allow_html=True)
        
        display_df = all_competitors_df[['POI_ID', 'POI_NAME', 'ADDRESS', 'POSTCODE', 'LATITUDE', 'LONGITUDE']].copy()
        
        display_df['Est. Daily Footfall'] = display_df.apply(
            lambda row: generate_store_footfall(row['POI_ID'], a['store_category'], row['LATITUDE'], row['LONGITUDE']),
            axis=1
        )
        
        display_df = display_df[['POI_NAME', 'ADDRESS', 'POSTCODE', 'Est. Daily Footfall']]
        display_df.columns = ['Competitor Name', 'Address', 'ZIP', 'Est. Daily Footfall']
        display_df = display_df.sort_values('Est. Daily Footfall', ascending=False)
        
        table_html = f"""
        <div style='font-family: "Source Sans Pro", -apple-system, BlinkMacSystemFont, sans-serif; background:#f8f9fa; border-radius:8px; border:1px solid #e9ecef; overflow:hidden;'>
            <table style='width:100%; border-collapse:collapse; font-size:0.85rem;'>
                <thead>
                    <tr style='background:linear-gradient(135deg, #29B5E8 0%, #1a8ab8 100%); color:white;'>
                        <th style='padding:12px 15px; text-align:left; font-weight:600;'>Competitor Name</th>
                        <th style='padding:12px 15px; text-align:left; font-weight:600;'>Address</th>
                        <th style='padding:12px 15px; text-align:center; font-weight:600;'>ZIP</th>
                        <th style='padding:12px 15px; text-align:right; font-weight:600;'>Est. Footfall</th>
                    </tr>
                </thead>
                <tbody>
        """
        
        for idx, row in display_df.head(15).iterrows():
            bg_color = '#ffffff' if idx % 2 == 0 else '#f8f9fa'
            table_html += f"""
                <tr style='background:{bg_color}; border-bottom:1px solid #e9ecef;'>
                    <td style='padding:10px 15px; color:#333;'><b style='color:rgb({COMPETITOR_COLOR[0]},{COMPETITOR_COLOR[1]},{COMPETITOR_COLOR[2]});'>{row['Competitor Name']}</b></td>
                    <td style='padding:10px 15px; color:#666;'>{row['Address']}</td>
                    <td style='padding:10px 15px; text-align:center; color:#666;'>{row['ZIP']}</td>
                    <td style='padding:10px 15px; text-align:right; color:#29B5E8; font-weight:600;'>{row['Est. Daily Footfall']:,}</td>
                </tr>
            """
        
        table_html += """
                </tbody>
            </table>
        </div>
        """
        
        if len(display_df) > 15:
            table_html += f"<div style='text-align:center; padding:10px; color:#666; font-size:0.8rem;'>Showing 15 of {len(display_df)} competitors</div>"
        
        components.html(table_html, height=min(550, 60 + 45 * min(len(display_df), 15) + 30))
