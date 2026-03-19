"""
POI Loader - Load location data from Snowflake.

Supports:
- Trucking mode: warehouses, destinations, rest stops from Overture Maps
- Food delivery mode: restaurants/stores and delivery addresses
- Fallback to synthetic generation if tables don't exist
"""

import os
import logging
from dataclasses import dataclass
from typing import Optional, List, Tuple
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


@dataclass
class POIData:
    """Container for trucking POI datasets."""
    warehouses: pd.DataFrame
    destinations: pd.DataFrame
    rest_stops: pd.DataFrame


@dataclass
class DeliveryPOIData:
    """Container for food delivery POI datasets."""
    stores: pd.DataFrame
    delivery_addresses: pd.DataFrame


def get_snowflake_connection(connection_name: Optional[str] = None):
    """Get Snowflake connection by name."""
    import snowflake.connector
    conn_name = connection_name or os.getenv("SNOWFLAKE_CONNECTION_NAME") or "default"
    return snowflake.connector.connect(connection_name=conn_name)


def load_warehouses(
    conn,
    schema: str,
    table: str = "GERMANY_WAREHOUSES",
    limit: Optional[int] = None
) -> pd.DataFrame:
    """
    Load warehouse locations from Snowflake.
    
    Args:
        conn: Snowflake connection
        schema: Database.schema prefix
        table: Table name
        limit: Optional row limit for testing
        
    Returns:
        DataFrame with warehouse data
    """
    limit_clause = f"LIMIT {limit}" if limit else ""
    query = f"""
    SELECT 
        ID as WAREHOUSE_ID,
        NAME,
        BASIC_CATEGORY as CATEGORY,
        'WAREHOUSE' as LOCATION_TYPE,
        LNG as LONGITUDE,
        LAT as LATITUDE,
        CITY,
        ADDRESS
    FROM {schema}.{table}
    WHERE LAT IS NOT NULL AND LNG IS NOT NULL
    {limit_clause}
    """
    cursor = conn.cursor()
    try:
        cursor.execute(query)
        df = cursor.fetch_pandas_all()
        df.columns = [c.lower() for c in df.columns]
        logger.info(f"Loaded {len(df)} warehouses from {schema}.{table}")
        return df
    except Exception as e:
        logger.warning(f"Failed to load warehouses: {e}")
        return pd.DataFrame()
    finally:
        cursor.close()


def load_destinations(
    conn,
    schema: str,
    table: str = "GERMANY_DESTINATIONS",
    limit: Optional[int] = None
) -> pd.DataFrame:
    """Load all destination POIs (warehouses + retail stores)."""
    limit_clause = f"LIMIT {limit}" if limit else ""
    query = f"""
    SELECT 
        ID as DESTINATION_ID,
        NAME,
        BASIC_CATEGORY as CATEGORY,
        LOCATION_TYPE,
        LNG as LONGITUDE,
        LAT as LATITUDE,
        CITY,
        ADDRESS
    FROM {schema}.{table}
    WHERE LAT IS NOT NULL AND LNG IS NOT NULL
    {limit_clause}
    """
    cursor = conn.cursor()
    try:
        cursor.execute(query)
        df = cursor.fetch_pandas_all()
        df.columns = [c.lower() for c in df.columns]
        logger.info(f"Loaded {len(df)} destinations from {schema}.{table}")
        return df
    except Exception as e:
        logger.warning(f"Failed to load destinations: {e}")
        return pd.DataFrame()
    finally:
        cursor.close()


def load_rest_stops(
    conn,
    schema: str,
    table: str = "GERMANY_REST_STOPS",
    limit: Optional[int] = None
) -> pd.DataFrame:
    """
    Load rest stop locations (truck stops, HGV parkings, fuel stations).
    
    Includes both official EU truck parkings and HGV polygon parking areas.
    """
    limit_clause = f"LIMIT {limit}" if limit else ""
    query = f"""
    SELECT 
        REST_STOP_ID,
        NAME,
        REST_TYPE,
        LNG as LONGITUDE,
        LAT as LATITUDE,
        HAS_EV_CHARGING,
        AREA_M2,
        CAPACITY_RATING
    FROM {schema}.{table}
    WHERE LAT IS NOT NULL AND LNG IS NOT NULL
    {limit_clause}
    """
    cursor = conn.cursor()
    try:
        cursor.execute(query)
        df = cursor.fetch_pandas_all()
        df.columns = [c.lower() for c in df.columns]
        logger.info(f"Loaded {len(df)} rest stops from {schema}.{table}")
        return df
    except Exception as e:
        logger.warning(f"Failed to load rest stops: {e}")
        return pd.DataFrame()
    finally:
        cursor.close()


def load_truck_fleet(
    conn,
    schema: str,
    table: str = "TRUCK_FLEET",
    limit: Optional[int] = None
) -> pd.DataFrame:
    """Load truck fleet with driver profiles."""
    limit_clause = f"LIMIT {limit}" if limit else ""
    query = f"""
    SELECT 
        TRUCK_ID,
        HOME_BASE_ID,
        HOME_BASE_NAME,
        HOME_LNG,
        HOME_LAT,
        TRUCK_TYPE,
        DRIVER_PROFILE,
        BASE_SPEED_KMH,
        SHIFT_TYPE
    FROM {schema}.{table}
    {limit_clause}
    """
    cursor = conn.cursor()
    try:
        cursor.execute(query)
        df = cursor.fetch_pandas_all()
        df.columns = [c.lower() for c in df.columns]
        logger.info(f"Loaded {len(df)} trucks from {schema}.{table}")
        return df
    except Exception as e:
        logger.warning(f"Failed to load truck fleet: {e}")
        return pd.DataFrame()
    finally:
        cursor.close()


def load_trip_schedule(
    conn,
    schema: str,
    table: str = "TRIP_SCHEDULE",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: Optional[int] = None
) -> pd.DataFrame:
    """Load trip schedule with date filtering."""
    where_clauses = []
    if start_date:
        where_clauses.append(f"TRIP_DATE >= '{start_date}'")
    if end_date:
        where_clauses.append(f"TRIP_DATE <= '{end_date}'")
    
    where_clause = "WHERE " + " AND ".join(where_clauses) if where_clauses else ""
    limit_clause = f"LIMIT {limit}" if limit else ""
    
    query = f"""
    SELECT 
        TRUCK_ID,
        TRIP_DATE,
        TRIP_TYPE,
        ROUTE_VARIATION,
        ORIGIN_ID,
        DEST_ID,
        SHIFT_START_TIME,
        ROUTE_DEVIATION_FACTOR,
        DRIVER_PROFILE
    FROM {schema}.{table}
    {where_clause}
    ORDER BY TRIP_DATE, TRUCK_ID
    {limit_clause}
    """
    cursor = conn.cursor()
    try:
        cursor.execute(query)
        df = cursor.fetch_pandas_all()
        df.columns = [c.lower() for c in df.columns]
        logger.info(f"Loaded {len(df)} trips from {schema}.{table}")
        return df
    except Exception as e:
        logger.warning(f"Failed to load trip schedule: {e}")
        return pd.DataFrame()
    finally:
        cursor.close()


# ============================================================================
# FALLBACK GENERATORS (if Overture tables don't exist)
# ============================================================================

def generate_fallback_warehouses(
    bbox: dict,
    count: int = 500,
    seed: int = 42
) -> pd.DataFrame:
    """
    Generate synthetic warehouse locations within bounding box.
    
    Used as fallback when Overture Maps data is unavailable.
    """
    rng = np.random.default_rng(seed)
    
    lats = rng.uniform(bbox['min_lat'], bbox['max_lat'], count)
    lngs = rng.uniform(bbox['min_lng'], bbox['max_lng'], count)
    
    warehouses = pd.DataFrame({
        'warehouse_id': [f'WH-{i:05d}' for i in range(count)],
        'name': [f'Warehouse {i}' for i in range(count)],
        'category': rng.choice(
            ['distribution_center', 'logistics_hub', 'warehouse', 'fulfillment_center'],
            count
        ),
        'location_type': 'WAREHOUSE',
        'longitude': lngs,
        'latitude': lats,
        'city': [f'City_{i % 50}' for i in range(count)],
        'address': None
    })
    
    logger.info(f"Generated {count} fallback warehouses")
    return warehouses


def generate_fallback_rest_stops(
    bbox: dict,
    count: int = 1000,
    seed: int = 42
) -> pd.DataFrame:
    """Generate synthetic rest stop locations."""
    rng = np.random.default_rng(seed + 1)
    
    lats = rng.uniform(bbox['min_lat'], bbox['max_lat'], count)
    lngs = rng.uniform(bbox['min_lng'], bbox['max_lng'], count)
    
    stops = pd.DataFrame({
        'rest_stop_id': [f'RS-{i:05d}' for i in range(count)],
        'name': [f'Rest Stop {i}' for i in range(count)],
        'rest_type': rng.choice(
            ['OFFICIAL', 'HGV_POLYGON', 'FUEL_STATION'],
            count,
            p=[0.4, 0.5, 0.1]
        ),
        'longitude': lngs,
        'latitude': lats,
        'has_ev_charging': rng.choice([True, False], count, p=[0.2, 0.8]),
        'area_m2': rng.lognormal(8, 1, count),
        'capacity_rating': rng.choice(['Low', 'Medium', 'High'], count)
    })
    
    logger.info(f"Generated {count} fallback rest stops")
    return stops


def load_all_poi_data(
    config: dict,
    connection_name: Optional[str] = None
) -> POIData:
    """
    Load all POI data from Snowflake with fallback generation.
    
    Args:
        config: Configuration dictionary with schema and bbox settings
        connection_name: Optional Snowflake connection name
        
    Returns:
        POIData container with all datasets
    """
    schema = f"{config['snowflake']['database']}.{config['snowflake']['schema']}"
    bbox = config['region']['bbox']
    seed = config.get('seed', 42)
    
    conn = get_snowflake_connection(connection_name)
    
    try:
        # Load warehouses
        warehouses = load_warehouses(conn, schema)
        if warehouses.empty:
            logger.warning("Using fallback warehouse generator")
            warehouses = generate_fallback_warehouses(bbox, 500, seed)
        
        # Load destinations
        destinations = load_destinations(conn, schema)
        if destinations.empty:
            logger.warning("Using warehouses as destinations (no separate table)")
            destinations = warehouses.copy()
            destinations = destinations.rename(columns={'warehouse_id': 'destination_id'})
        
        # Load rest stops
        rest_stops = load_rest_stops(conn, schema)
        if rest_stops.empty:
            logger.warning("Using fallback rest stop generator")
            rest_stops = generate_fallback_rest_stops(bbox, 1000, seed)
        
        return POIData(
            warehouses=warehouses,
            destinations=destinations,
            rest_stops=rest_stops
        )
    finally:
        conn.close()


def sample_warehouse(
    warehouses: pd.DataFrame,
    exclude_ids: Optional[List[str]] = None,
    rng: Optional[np.random.Generator] = None
) -> Tuple[str, float, float, str]:
    """
    Sample a random warehouse, optionally excluding certain IDs.
    
    Returns:
        Tuple of (warehouse_id, longitude, latitude, name)
    """
    if rng is None:
        rng = np.random.default_rng()
    
    available = warehouses
    if exclude_ids:
        id_col = 'warehouse_id' if 'warehouse_id' in warehouses.columns else 'destination_id'
        available = warehouses[~warehouses[id_col].isin(exclude_ids)]
    
    if available.empty:
        available = warehouses
    
    row = available.sample(n=1, random_state=int(rng.integers(1e9))).iloc[0]
    id_col = 'warehouse_id' if 'warehouse_id' in row else 'destination_id'
    
    return (
        row[id_col],
        row['longitude'],
        row['latitude'],
        row.get('name', 'Unknown')
    )


def find_nearest_rest_stop(
    lat: float,
    lng: float,
    rest_stops: pd.DataFrame,
    max_distance_km: float = 50.0
) -> Optional[Tuple[str, float, float, str]]:
    """
    Find the nearest rest stop to a given location.
    
    Uses Haversine approximation for speed.
    
    Returns:
        Tuple of (rest_stop_id, longitude, latitude, rest_type) or None
    """
    if rest_stops.empty:
        return None
    
    # Approximate distance using Haversine
    lat_rad = np.radians(lat)
    lng_rad = np.radians(lng)
    stop_lat_rad = np.radians(rest_stops['latitude'].values)
    stop_lng_rad = np.radians(rest_stops['longitude'].values)
    
    dlat = stop_lat_rad - lat_rad
    dlng = stop_lng_rad - lng_rad
    
    a = np.sin(dlat/2)**2 + np.cos(lat_rad) * np.cos(stop_lat_rad) * np.sin(dlng/2)**2
    c = 2 * np.arcsin(np.sqrt(a))
    distances_km = 6371 * c  # Earth radius in km
    
    min_idx = np.argmin(distances_km)
    if distances_km[min_idx] > max_distance_km:
        return None
    
    row = rest_stops.iloc[min_idx]
    return (
        row['rest_stop_id'],
        row['longitude'],
        row['latitude'],
        row['rest_type']
    )


def find_stops_along_route(
    route_coords: List[Tuple[float, float]],
    rest_stops: pd.DataFrame,
    buffer_km: float = 30.0,
    max_stops: int = 5
) -> pd.DataFrame:
    """
    Find rest stops along a route corridor.
    
    Args:
        route_coords: List of (lng, lat) tuples
        rest_stops: DataFrame of available rest stops
        buffer_km: Search buffer around route
        max_stops: Maximum number of stops to return
        
    Returns:
        DataFrame of candidate rest stops sorted by route distance
    """
    if rest_stops.empty or not route_coords:
        return pd.DataFrame()
    
    # Sample route points for efficiency
    sample_indices = np.linspace(0, len(route_coords)-1, min(20, len(route_coords)), dtype=int)
    sample_points = [route_coords[i] for i in sample_indices]
    
    # Find stops near any sampled point
    candidates = []
    for lng, lat in sample_points:
        result = find_nearest_rest_stop(lat, lng, rest_stops, buffer_km)
        if result:
            candidates.append({
                'rest_stop_id': result[0],
                'longitude': result[1],
                'latitude': result[2],
                'rest_type': result[3]
            })
    
    if not candidates:
        return pd.DataFrame()
    
    # Deduplicate and return
    df = pd.DataFrame(candidates).drop_duplicates(subset='rest_stop_id')
    return df.head(max_stops)


# ============================================================================
# FOOD DELIVERY POI LOADING
# ============================================================================

SF_NEIGHBORHOODS = {
    'Mission':       (37.7599, -122.4148, 0.008),
    'SoMa':          (37.7785, -122.3950, 0.009),
    'Castro':        (37.7609, -122.4350, 0.005),
    'Marina':        (37.8005, -122.4370, 0.006),
    'Sunset':        (37.7535, -122.4940, 0.015),
    'Richmond':      (37.7800, -122.4770, 0.012),
    'NoeValley':     (37.7502, -122.4331, 0.005),
    'Hayes':         (37.7760, -122.4240, 0.005),
    'NorthBeach':    (37.8060, -122.4100, 0.004),
    'Chinatown':     (37.7941, -122.4078, 0.003),
    'Tenderloin':    (37.7847, -122.4130, 0.004),
    'Haight':        (37.7700, -122.4470, 0.006),
    'PacificHeights': (37.7925, -122.4350, 0.006),
    'Excelsior':     (37.7250, -122.4300, 0.008),
    'Bayview':       (37.7340, -122.3900, 0.008),
    'VisitacionValley': (37.7130, -122.4050, 0.006),
    'Portola':       (37.7280, -122.4060, 0.005),
    'GlenPark':      (37.7340, -122.4330, 0.005),
}


def load_restaurants(
    conn,
    schema: str,
    bbox: dict,
    limit: Optional[int] = 1000
) -> pd.DataFrame:
    query = f"""
    SELECT
        ID as STORE_ID,
        NAMES['primary'] as NAME,
        CATEGORIES['primary']::VARCHAR as CUISINE_TYPE,
        'RESTAURANT' as STORE_TYPE,
        ST_X(GEOMETRY)::FLOAT as LONGITUDE,
        ST_Y(GEOMETRY)::FLOAT as LATITUDE,
        ADDRESSES['list'][0]['freeform']::VARCHAR as ADDRESS
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
    WHERE ST_Y(GEOMETRY) BETWEEN {bbox['min_lat']} AND {bbox['max_lat']}
      AND ST_X(GEOMETRY) BETWEEN {bbox['min_lng']} AND {bbox['max_lng']}
      AND (
          CATEGORIES['primary']::VARCHAR ILIKE '%restaurant%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%fast_food%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%cafe%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%bakery%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%pizza%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%sushi%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%thai%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%chinese%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%mexican%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%indian%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%burger%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%sandwich%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%deli%'
          OR CATEGORIES['primary']::VARCHAR ILIKE '%food%'
      )
    LIMIT {limit}
    """
    cursor = conn.cursor()
    try:
        cursor.execute(query)
        df = cursor.fetch_pandas_all()
        df.columns = [c.lower() for c in df.columns]
        logger.info(f"Loaded {len(df)} restaurants from Overture Maps")
        return df
    except Exception as e:
        logger.warning(f"Failed to load restaurants from Overture: {e}")
        return pd.DataFrame()
    finally:
        cursor.close()


def generate_fallback_stores(
    bbox: dict,
    count: int = 800,
    seed: int = 42
) -> pd.DataFrame:
    rng = np.random.default_rng(seed)

    cuisine_types = [
        'restaurant', 'fast_food', 'cafe', 'bakery', 'pizza',
        'sushi', 'thai', 'chinese_restaurant', 'mexican_restaurant',
        'indian_restaurant', 'burger_joint', 'sandwich_shop', 'deli'
    ]
    store_names = [
        'Golden Gate Eats', 'Bay Bites', 'Fog City Grill', 'Mission Taqueria',
        'Sunset Sushi', 'Richmond Noodles', 'Castro Coffee', 'Marina Pizza',
        'SoMa Sandwiches', 'Haight Bakery', 'North Beach Pasta', 'Chinatown Dim Sum'
    ]

    neighborhoods = list(SF_NEIGHBORHOODS.values())
    lats = []
    lngs = []
    for _ in range(count):
        nb = neighborhoods[rng.integers(0, len(neighborhoods))]
        lat = rng.normal(nb[0], nb[2] * 0.4)
        lng = rng.normal(nb[1], nb[2] * 0.4)
        lat = np.clip(lat, bbox['min_lat'], bbox['max_lat'])
        lng = np.clip(lng, bbox['min_lng'], bbox['max_lng'])
        lats.append(lat)
        lngs.append(lng)

    stores = pd.DataFrame({
        'store_id': [f'STORE-{i:05d}' for i in range(count)],
        'name': rng.choice(store_names, count),
        'cuisine_type': rng.choice(cuisine_types, count),
        'store_type': 'RESTAURANT',
        'longitude': lngs,
        'latitude': lats,
        'address': [f'{rng.integers(100, 9999)} {rng.choice(["Market St", "Mission St", "Valencia St", "Geary Blvd", "Irving St", "Clement St", "Polk St", "Columbus Ave", "Haight St", "Divisadero St"])}' for _ in range(count)]
    })

    logger.info(f"Generated {count} fallback store locations")
    return stores


def generate_delivery_addresses(
    bbox: dict,
    count: int = 5000,
    seed: int = 42
) -> pd.DataFrame:
    rng = np.random.default_rng(seed + 100)

    neighborhoods = list(SF_NEIGHBORHOODS.items())
    nb_weights = np.array([v[2] for _, v in neighborhoods])
    nb_weights = nb_weights / nb_weights.sum()

    lats = []
    lngs = []
    nb_names = []
    for _ in range(count):
        idx = rng.choice(len(neighborhoods), p=nb_weights)
        nb_name, (center_lat, center_lng, spread) = neighborhoods[idx]
        lat = rng.normal(center_lat, spread)
        lng = rng.normal(center_lng, spread)
        lat = np.clip(lat, bbox['min_lat'], bbox['max_lat'])
        lng = np.clip(lng, bbox['min_lng'], bbox['max_lng'])
        lats.append(lat)
        lngs.append(lng)
        nb_names.append(nb_name)

    street_names = [
        'Oak St', 'Pine St', 'Bush St', 'Sutter St', 'Post St',
        'Geary St', 'Turk St', 'Golden Gate Ave', 'McAllister St',
        'Fulton St', 'Hayes St', 'Fell St', 'Page St', 'Haight St',
        '24th St', '22nd St', '18th St', '16th St', '14th St',
        'Guerrero St', 'Dolores St', 'Church St', 'Sanchez St',
        'Noe St', 'Castro St', 'Masonic Ave', 'Ashbury St'
    ]

    addresses = pd.DataFrame({
        'address_id': [f'ADDR-{i:06d}' for i in range(count)],
        'address': [f'{rng.integers(100, 9999)} {rng.choice(street_names)}' for _ in range(count)],
        'neighborhood': nb_names,
        'longitude': lngs,
        'latitude': lats,
        'address_type': 'RESIDENTIAL'
    })

    logger.info(f"Generated {count} delivery addresses across {len(SF_NEIGHBORHOODS)} neighborhoods")
    return addresses


def load_delivery_poi_data(
    config: dict,
    connection_name: Optional[str] = None
) -> DeliveryPOIData:
    bbox = config['region']['bbox']
    seed = config.get('seed', 42)
    sf_config = config.get('snowflake', {})
    schema = f"{sf_config['database']}.{sf_config['schema']}"

    conn = get_snowflake_connection(connection_name or sf_config.get('connection_name'))

    try:
        stores = load_restaurants(conn, schema, bbox)
        if stores.empty:
            logger.warning("Using fallback store generator")
            stores = generate_fallback_stores(bbox, 800, seed)

        delivery_addresses = generate_delivery_addresses(bbox, 5000, seed)

        return DeliveryPOIData(
            stores=stores,
            delivery_addresses=delivery_addresses
        )
    finally:
        conn.close()
