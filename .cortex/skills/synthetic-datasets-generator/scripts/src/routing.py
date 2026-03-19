"""
Routing Module - ORS integration with caching and alternative routes.

Supports:
- Calling ORS via Snowflake native app
- Route caching (SQLite) to avoid repeated API calls
- Alternative route selection for detours
- Speed limit estimation by road class
"""

import os
import json
import hashlib
import sqlite3
import logging
from dataclasses import dataclass
from typing import Optional, List, Tuple, Dict, Any
from pathlib import Path
import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class RouteResult:
    """Container for a computed route."""
    origin_id: str
    dest_id: str
    origin_coords: Tuple[float, float]  # (lng, lat)
    dest_coords: Tuple[float, float]
    distance_km: float
    duration_min: float
    coordinates: List[Tuple[float, float]]  # List of (lng, lat)
    num_points: int
    route_index: int = 0  # 0=optimal, 1+=alternatives
    raw_response: Optional[Dict] = None
    
    @property
    def is_alternative(self) -> bool:
        return self.route_index > 0


class RouteCache:
    """
    SQLite-based route cache for avoiding repeated ORS calls.
    
    Cache key: hash of (origin_lng, origin_lat, dest_lng, dest_lat, profile)
    """
    
    def __init__(self, cache_path: str = "cache/routes.db"):
        self.cache_path = Path(cache_path)
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()
    
    def _init_db(self):
        """Initialize the cache database."""
        conn = sqlite3.connect(self.cache_path)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS route_cache (
                cache_key TEXT PRIMARY KEY,
                origin_id TEXT,
                dest_id TEXT,
                origin_lng REAL,
                origin_lat REAL,
                dest_lng REAL,
                dest_lat REAL,
                distance_km REAL,
                duration_min REAL,
                num_points INTEGER,
                coordinates TEXT,
                route_index INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_origin_dest ON route_cache(origin_id, dest_id)")
        conn.commit()
        conn.close()
    
    def _make_key(
        self,
        origin_lng: float,
        origin_lat: float,
        dest_lng: float,
        dest_lat: float,
        route_index: int = 0
    ) -> str:
        """Generate cache key from coordinates."""
        key_str = f"{origin_lng:.6f},{origin_lat:.6f},{dest_lng:.6f},{dest_lat:.6f},{route_index}"
        return hashlib.md5(key_str.encode()).hexdigest()
    
    def get(
        self,
        origin_lng: float,
        origin_lat: float,
        dest_lng: float,
        dest_lat: float,
        route_index: int = 0
    ) -> Optional[RouteResult]:
        """Retrieve a route from cache."""
        key = self._make_key(origin_lng, origin_lat, dest_lng, dest_lat, route_index)
        
        conn = sqlite3.connect(self.cache_path)
        cursor = conn.execute(
            "SELECT * FROM route_cache WHERE cache_key = ?",
            (key,)
        )
        row = cursor.fetchone()
        conn.close()
        
        if row is None:
            return None
        
        coords = json.loads(row[10])
        return RouteResult(
            origin_id=row[1],
            dest_id=row[2],
            origin_coords=(row[3], row[4]),
            dest_coords=(row[5], row[6]),
            distance_km=row[7],
            duration_min=row[8],
            coordinates=coords,
            num_points=row[9],
            route_index=row[11]
        )
    
    def put(self, route: RouteResult):
        """Store a route in cache."""
        key = self._make_key(
            route.origin_coords[0],
            route.origin_coords[1],
            route.dest_coords[0],
            route.dest_coords[1],
            route.route_index
        )
        
        conn = sqlite3.connect(self.cache_path)
        conn.execute("""
            INSERT OR REPLACE INTO route_cache 
            (cache_key, origin_id, dest_id, origin_lng, origin_lat, dest_lng, dest_lat,
             distance_km, duration_min, num_points, coordinates, route_index)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            key,
            route.origin_id,
            route.dest_id,
            route.origin_coords[0],
            route.origin_coords[1],
            route.dest_coords[0],
            route.dest_coords[1],
            route.distance_km,
            route.duration_min,
            route.num_points,
            json.dumps(route.coordinates),
            route.route_index
        ))
        conn.commit()
        conn.close()
    
    def get_stats(self) -> Dict[str, int]:
        """Get cache statistics."""
        conn = sqlite3.connect(self.cache_path)
        cursor = conn.execute("SELECT COUNT(*) FROM route_cache")
        count = cursor.fetchone()[0]
        conn.close()
        return {"cached_routes": count}


class ORSRouter:
    """
    OpenRouteService router via Snowflake native app.
    
    Calls OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS for HGV routing.
    """
    
    def __init__(self, config: dict, connection=None):
        self.config = config
        self.routing_config = config.get('routing', {})
        self.ors_config = self.routing_config.get('ors', {})
        self.cache = RouteCache() if self.ors_config.get('cache_enabled', True) else None
        self._conn = connection
    
    def _get_connection(self):
        """Get or create Snowflake connection."""
        if self._conn is None:
            from .overture import get_snowflake_connection
            sf_config = self.config.get('snowflake', {})
            self._conn = get_snowflake_connection(sf_config.get('connection_name'))
        return self._conn
    
    def get_route(
        self,
        origin_id: str,
        dest_id: str,
        origin_lng: float,
        origin_lat: float,
        dest_lng: float,
        dest_lat: float,
        route_index: int = 0,
        use_cache: bool = True
    ) -> Optional[RouteResult]:
        """
        Get a route between two points.
        
        Args:
            origin_id: Origin location ID
            dest_id: Destination location ID
            origin_lng, origin_lat: Origin coordinates
            dest_lng, dest_lat: Destination coordinates
            route_index: 0 for optimal, 1+ for alternatives
            use_cache: Whether to check cache first
            
        Returns:
            RouteResult or None if routing fails
        """
        # Check cache first
        if use_cache and self.cache:
            cached = self.cache.get(origin_lng, origin_lat, dest_lng, dest_lat, route_index)
            if cached:
                logger.debug(f"Cache hit for route {origin_id} -> {dest_id}")
                return cached
        
        # Call ORS
        try:
            conn = self._get_connection()
            cursor = conn.cursor()
            
            service = self.ors_config.get('service', 'OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS')
            profile = self.ors_config.get('profile', 'driving-hgv')
            
            query = f"""
            SELECT TO_JSON({service}(
                '{profile}',
                OBJECT_CONSTRUCT(
                    'coordinates', ARRAY_CONSTRUCT(
                        ARRAY_CONSTRUCT({origin_lng}, {origin_lat}),
                        ARRAY_CONSTRUCT({dest_lng}, {dest_lat})
                    )
                )
            ))::VARCHAR as route_response
            """
            
            cursor.execute(query)
            row = cursor.fetchone()
            
            if row is None:
                logger.warning(f"No route returned for {origin_id} -> {dest_id}")
                return None
            
            response = row[0]
            
            if isinstance(response, str):
                response = json.loads(response)
            
            if 'error' in response:
                logger.warning(f"ORS error for {origin_id} -> {dest_id}: {response['error'].get('message', 'Unknown error')}")
                return None
            
            route = self._parse_ors_response(
                response,
                origin_id,
                dest_id,
                origin_lng,
                origin_lat,
                dest_lng,
                dest_lat,
                route_index
            )
            
            # Cache result
            if route and self.cache:
                self.cache.put(route)
            
            return route
            
        except Exception as e:
            logger.error(f"ORS routing failed: {e}")
            return None
    
    def _parse_ors_response(
        self,
        response: Dict,
        origin_id: str,
        dest_id: str,
        origin_lng: float,
        origin_lat: float,
        dest_lng: float,
        dest_lat: float,
        route_index: int
    ) -> Optional[RouteResult]:
        """Parse ORS GeoJSON response into RouteResult."""
        try:
            features = response.get('features', [])
            if not features or route_index >= len(features):
                return None
            
            feature = features[route_index]
            props = feature.get('properties', {})
            summary = props.get('summary', {})
            geometry = feature.get('geometry', {})
            
            coordinates = geometry.get('coordinates', [])
            
            # Coordinates come as nested arrays [[lng, lat], ...]
            # Convert to list of tuples
            coords_list = []
            for coord in coordinates:
                if isinstance(coord, (list, tuple)) and len(coord) >= 2:
                    coords_list.append((float(coord[0]), float(coord[1])))
            
            return RouteResult(
                origin_id=origin_id,
                dest_id=dest_id,
                origin_coords=(origin_lng, origin_lat),
                dest_coords=(dest_lng, dest_lat),
                distance_km=summary.get('distance', 0) / 1000,
                duration_min=summary.get('duration', 0) / 60,
                coordinates=coords_list,
                num_points=len(coords_list),
                route_index=route_index,
                raw_response=response
            )
        except Exception as e:
            logger.error(f"Failed to parse ORS response: {e}")
            return None
    
    def get_route_from_cache_table(
        self,
        conn,
        origin_id: str,
        dest_id: str,
        schema: str = "FLEET_INTELLIGENCE.ROUTE_CACHE",
        table: str = "ORS_ROUTE_CACHE"
    ) -> Optional[RouteResult]:
        """
        Load a pre-computed route from Snowflake cache table.
        
        This is faster than calling ORS for routes that were already computed.
        """
        query = f"""
        SELECT 
            ORIGIN_ID, DEST_ID,
            ORIGIN_LNG, ORIGIN_LAT,
            DEST_LNG, DEST_LAT,
            ROAD_DISTANCE_KM,
            ROAD_DURATION_MIN,
            ROUTE_COORDINATES,
            NUM_ROAD_POINTS
        FROM {schema}.{table}
        WHERE ORIGIN_ID = %s AND DEST_ID = %s
        LIMIT 1
        """
        
        cursor = conn.cursor()
        try:
            cursor.execute(query, (origin_id, dest_id))
            row = cursor.fetchone()
            
            if row is None:
                return None
            
            # Parse coordinates array
            coords = row[8]
            coords_list = []
            if coords:
                for coord in coords:
                    if isinstance(coord, str):
                        # Handle "lng,lat" string format
                        parts = coord.split(',')
                        if len(parts) >= 2:
                            coords_list.append((float(parts[0]), float(parts[1])))
                    elif isinstance(coord, (list, tuple)) and len(coord) >= 2:
                        coords_list.append((float(coord[0]), float(coord[1])))
            
            return RouteResult(
                origin_id=row[0],
                dest_id=row[1],
                origin_coords=(row[2], row[3]),
                dest_coords=(row[4], row[5]),
                distance_km=row[6] or 0,
                duration_min=row[7] or 0,
                coordinates=coords_list,
                num_points=row[9] or len(coords_list),
                route_index=0
            )
        finally:
            cursor.close()


def estimate_posted_speed(
    segment_distance_km: float,
    segment_duration_min: float,
    config: dict,
    road_class: Optional[str] = None,
    route_progress: float = 0.5,
    route_distance_km: float = 0
) -> float:
    """
    Estimate posted speed limit for a route segment.
    
    Uses route position to infer road type:
    - Near origin/destination (first/last 10%): likely urban, lower speed
    - Middle of route: likely motorway for long routes, higher speed
    
    Args:
        segment_distance_km: Segment distance
        segment_duration_min: Segment duration
        config: Configuration with posted_speeds
        road_class: Optional road classification (if known)
        route_progress: Position along route (0.0 to 1.0)
        route_distance_km: Total route distance (used to infer road type)
        
    Returns:
        Estimated posted speed in km/h
    """
    posted_speeds = config.get('routing', {}).get('posted_speeds', {})
    
    if road_class and road_class in posted_speeds:
        return posted_speeds[road_class]
    
    # Position-based estimation
    is_near_endpoints = route_progress < 0.1 or route_progress > 0.9
    is_long_route = route_distance_km > 100
    
    if is_near_endpoints:
        # Near origin/destination - likely urban/suburban roads
        if route_distance_km < 50:
            return posted_speeds.get('secondary', 60)
        else:
            return posted_speeds.get('primary', 70)
    
    if is_long_route:
        # Middle of long route - likely motorway
        return posted_speeds.get('motorway', 80)
    elif route_distance_km > 50:
        # Medium route - mix of trunk/primary
        return posted_speeds.get('trunk', 80)
    else:
        # Short route - primary/secondary roads
        return posted_speeds.get('primary', 70)


def estimate_posted_speed_simple(
    segment_distance_km: float,
    segment_duration_min: float,
    config: dict,
    road_class: Optional[str] = None
) -> float:
    """
    Simple posted speed estimation (backward compatible).
    
    Use estimate_posted_speed() for position-aware estimation.
    """
    posted_speeds = config.get('routing', {}).get('posted_speeds', {})
    
    if road_class and road_class in posted_speeds:
        return posted_speeds[road_class]
    
    if segment_duration_min > 0:
        avg_speed = segment_distance_km / (segment_duration_min / 60)
        return min(avg_speed * 1.15, posted_speeds.get('default', 60))
    
    return posted_speeds.get('default', 60)


def interpolate_route(
    route: RouteResult,
    interval_seconds: int = 30
) -> List[Tuple[float, float, float]]:
    """
    Interpolate GPS points along a route at regular time intervals.
    
    Returns list of (lng, lat, cumulative_seconds) tuples.
    """
    if not route.coordinates or route.duration_min <= 0:
        return []
    
    total_seconds = route.duration_min * 60
    num_points = len(route.coordinates)
    
    # Calculate cumulative distances for interpolation
    distances = [0.0]
    for i in range(1, num_points):
        prev = route.coordinates[i-1]
        curr = route.coordinates[i]
        # Simple Euclidean approximation (good enough for short segments)
        dist = np.sqrt((curr[0] - prev[0])**2 + (curr[1] - prev[1])**2)
        distances.append(distances[-1] + dist)
    
    total_distance = distances[-1]
    if total_distance == 0:
        return [(route.coordinates[0][0], route.coordinates[0][1], 0)]
    
    # Interpolate at time intervals
    result = []
    num_intervals = int(total_seconds / interval_seconds) + 1
    
    for i in range(num_intervals):
        t = i * interval_seconds
        progress = t / total_seconds
        target_dist = progress * total_distance
        
        # Find the segment containing this distance
        seg_idx = 0
        for j in range(1, num_points):
            if distances[j] >= target_dist:
                seg_idx = j - 1
                break
        else:
            seg_idx = num_points - 2
        
        # Interpolate within segment
        seg_start_dist = distances[seg_idx]
        seg_end_dist = distances[seg_idx + 1] if seg_idx + 1 < num_points else distances[-1]
        seg_length = seg_end_dist - seg_start_dist
        
        if seg_length > 0:
            seg_progress = (target_dist - seg_start_dist) / seg_length
        else:
            seg_progress = 0
        
        start_coord = route.coordinates[seg_idx]
        end_coord = route.coordinates[min(seg_idx + 1, num_points - 1)]
        
        lng = start_coord[0] + seg_progress * (end_coord[0] - start_coord[0])
        lat = start_coord[1] + seg_progress * (end_coord[1] - start_coord[1])
        
        result.append((lng, lat, t))
    
    return result
