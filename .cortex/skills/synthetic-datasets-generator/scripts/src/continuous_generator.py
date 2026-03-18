"""
Continuous Telemetry Generator - Generates continuous truck paths with seamless trip transitions.

Key features:
- 30-second average ping intervals (configurable)
- Continuous truck positions (only trip_id changes between trips)
- Realistic dwell periods at warehouses and rest stops
- Overnight stays at home or rest stops based on trip distance
- EU HOS compliance with mandatory breaks
"""

import uuid
import logging
import time as time_module
from datetime import datetime, timedelta, date, time
from typing import List, Dict, Optional, Tuple, Iterator, Generator
from dataclasses import dataclass, field
from enum import Enum
import numpy as np
import pandas as pd

from .driver_profiles import (
    DriverProfile, ProfileType, BehaviorSimulator,
    calculate_heading, simulate_acceleration
)
from .routing import RouteResult, ORSRouter, estimate_posted_speed
from .simulate import TelemetryPoint, Trip, TruckAssignment, haversine_distance

logger = logging.getLogger(__name__)


class TruckState(Enum):
    DWELL_WAREHOUSE = "DWELL_WAREHOUSE"
    DWELL_REST_STOP = "DWELL_REST_STOP"
    DWELL_DESTINATION = "DWELL_DESTINATION"
    DRIVING = "DRIVING"
    OVERNIGHT_HOME = "OVERNIGHT_HOME"
    OVERNIGHT_REST_STOP = "OVERNIGHT_REST_STOP"
    OVERNIGHT_WAREHOUSE = "OVERNIGHT_WAREHOUSE"
    OVERNIGHT_RETAIL = "OVERNIGHT_RETAIL"


@dataclass
class TruckLifecycle:
    """Tracks continuous state of a truck across the simulation period."""
    truck_id: str
    driver_id: str
    profile: DriverProfile
    home_base_id: str
    home_coords: Tuple[float, float]
    truck_type: str
    base_speed_kmh: float
    
    current_lat: float = field(init=False)
    current_lng: float = field(init=False)
    current_time: datetime = field(default=None)
    current_location_id: Optional[str] = None
    current_location_type: str = "WAREHOUSE"
    current_state: TruckState = TruckState.DWELL_WAREHOUSE
    
    daily_driving_minutes: float = 0.0
    minutes_since_last_break: float = 0.0
    current_trip_id: Optional[str] = None
    trip_sequence: int = 0
    total_points_generated: int = 0
    
    def __post_init__(self):
        self.current_lat = self.home_coords[1]
        self.current_lng = self.home_coords[0]
        self.current_location_id = self.home_base_id
    
    def start_new_day(self, day: date, start_hour: int = 6):
        """Reset daily counters, keep position."""
        self.daily_driving_minutes = 0.0
        self.minutes_since_last_break = 0.0
        wakeup_map = {
            TruckState.OVERNIGHT_HOME: TruckState.DWELL_WAREHOUSE,
            TruckState.OVERNIGHT_REST_STOP: TruckState.DWELL_REST_STOP,
            TruckState.OVERNIGHT_WAREHOUSE: TruckState.DWELL_WAREHOUSE,
            TruckState.OVERNIGHT_RETAIL: TruckState.DWELL_DESTINATION,
        }
        if self.current_state in wakeup_map:
            self.current_state = wakeup_map[self.current_state]
        self.current_time = datetime.combine(day, time(start_hour, 0))
    
    def can_start_trip(self, trip_duration_min: float, max_daily_hours: float = 9.0) -> bool:
        """Check if driver has enough hours for this trip."""
        max_daily_min = max_daily_hours * 60
        return (self.daily_driving_minutes + trip_duration_min) <= max_daily_min
    
    def needs_break(self, break_threshold_hours: float = 4.5) -> bool:
        """Check if driver needs a mandatory break."""
        return self.minutes_since_last_break >= (break_threshold_hours * 60)
    
    def take_break(self, duration_min: float):
        """Record a break taken."""
        self.minutes_since_last_break = 0.0
    
    def add_driving_time(self, minutes: float):
        """Add driving time to daily and break counters."""
        self.daily_driving_minutes += minutes
        self.minutes_since_last_break += minutes
    
    def update_position(self, lat: float, lng: float):
        """Update current position."""
        self.current_lat = lat
        self.current_lng = lng
    
    def advance_time(self, seconds: float):
        """Advance current time by seconds."""
        self.current_time += timedelta(seconds=int(seconds))
    
    def start_trip(self, trip_id: str):
        """Start a new trip."""
        self.current_trip_id = trip_id
        self.trip_sequence += 1
        self.current_state = TruckState.DRIVING
    
    def end_trip(self):
        """End current trip."""
        self.current_trip_id = None
    
    def distance_to_home(self) -> float:
        """Calculate distance to home base in km."""
        return haversine_distance(
            self.current_lat, self.current_lng,
            self.home_coords[1], self.home_coords[0]
        )


class ContinuousTelemetryGenerator:
    """
    Generates continuous telemetry for trucks with seamless trip transitions.
    
    Each truck maintains position continuity - only trip_id changes between trips.
    Telemetry is emitted at ~30 second intervals while moving, lower frequency when stationary.
    
    When trip_schedule is provided, uses scheduled OD pairs instead of random destinations,
    ensuring GPS traces match the expected routes.
    """
    
    def __init__(
        self,
        config: dict,
        trucks: List[TruckAssignment],
        router: ORSRouter,
        behavior: BehaviorSimulator,
        warehouses: pd.DataFrame,
        destinations: pd.DataFrame,
        rest_stops: pd.DataFrame,
        trip_schedule: Optional[pd.DataFrame] = None,
        locations: Optional[pd.DataFrame] = None
    ):
        self.config = config
        self.trucks = {t.truck_id: t for t in trucks}
        self.router = router
        self.behavior = behavior
        
        self.warehouses = warehouses.copy()
        self.warehouses.columns = self.warehouses.columns.str.lower()
        self.destinations = destinations.copy()
        self.destinations.columns = self.destinations.columns.str.lower()
        self.rest_stops = rest_stops.copy()
        self.rest_stops.columns = self.rest_stops.columns.str.lower()
        self.rng = np.random.default_rng(config.get('seed', 42))
        
        self._destination_distances: Dict[str, pd.DataFrame] = {}
        
        self._schedule_lookup: Dict[Tuple[str, date], List[Dict]] = {}
        if trip_schedule is not None and not trip_schedule.empty:
            sched = trip_schedule.copy()
            sched.columns = sched.columns.str.lower()
            for _, row in sched.iterrows():
                truck_id = row['truck_id']
                trip_date = row['trip_date']
                if isinstance(trip_date, str):
                    trip_date = datetime.strptime(trip_date, '%Y-%m-%d').date()
                elif hasattr(trip_date, 'date'):
                    trip_date = trip_date.date() if callable(getattr(trip_date, 'date')) else trip_date
                key = (truck_id, trip_date)
                if key not in self._schedule_lookup:
                    self._schedule_lookup[key] = []
                self._schedule_lookup[key].append({
                    'origin_id': row['origin_id'],
                    'dest_id': row['dest_id'],
                    'trip_type': row.get('trip_type', 'WAREHOUSE_TO_WAREHOUSE'),
                    'route_variation': row.get('route_variation', 'OPTIMAL'),
                    'route_deviation_factor': row.get('route_deviation_factor', 1.0),
                    'shift_start_time': row.get('shift_start_time', None),
                })
            logger.info(f"Loaded schedule for {len(self._schedule_lookup)} truck-day combinations")
        
        self._location_coords: Dict[str, Tuple[float, float]] = {}
        self._location_types: Dict[str, str] = {}
        if locations is not None and not locations.empty:
            loc = locations.copy()
            loc.columns = loc.columns.str.lower()
            id_col = next((c for c in ['id', 'warehouse_id', 'destination_id'] if c in loc.columns), None)
            if id_col:
                for _, row in loc.iterrows():
                    self._location_coords[row[id_col]] = (row['longitude'], row['latitude'])
                    if 'location_type' in row.index:
                        self._location_types[row[id_col]] = row.get('location_type', 'WAREHOUSE')
                logger.info(f"Loaded coordinates for {len(self._location_coords)} locations")
        
        self.lifecycles: Dict[str, TruckLifecycle] = {}
        for truck in trucks:
            self.lifecycles[truck.truck_id] = TruckLifecycle(
                truck_id=truck.truck_id,
                driver_id=truck.driver_id,
                profile=truck.profile,
                home_base_id=truck.home_base_id,
                home_coords=truck.home_coords,
                truck_type=truck.truck_type,
                base_speed_kmh=truck.base_speed_kmh
            )
        
        self.generated_trips: List[Trip] = []
        
        self.ping_config = config.get('telemetry', {}).get('ping_interval', {})
        self.moving_interval_sec = self.ping_config.get('moving', {}).get('target_sec', 30)
        self.moving_variance_sec = self.ping_config.get('moving', {}).get('variance_sec', 10)
        self.dwell_interval_sec = self.ping_config.get('dwell', {}).get('min_sec', 300)
        self.overnight_interval_sec = self.ping_config.get('dwell', {}).get('max_sec', 1200)
    
    def generate_continuous(
        self,
        start_date: date,
        end_date: date
    ) -> Generator[TelemetryPoint, None, None]:
        """
        Generate continuous telemetry for all trucks across the full period.
        
        Yields TelemetryPoint objects one at a time for memory efficiency.
        """
        for truck_id, lifecycle in self.lifecycles.items():
            lifecycle.current_time = datetime.combine(start_date, time(6, 0))
            lifecycle.current_lat = lifecycle.home_coords[1]
            lifecycle.current_lng = lifecycle.home_coords[0]
            lifecycle.current_state = TruckState.DWELL_WAREHOUSE
            lifecycle.current_location_id = lifecycle.home_base_id
        
        current_day = start_date
        total_days = (end_date - start_date).days + 1
        
        while current_day <= end_date:
            day_num = (current_day - start_date).days + 1
            logger.info(f"Generating day {day_num}/{total_days}: {current_day}")
            
            for truck_id in self.lifecycles:
                yield from self._simulate_truck_day(truck_id, current_day)
            
            current_day += timedelta(days=1)
    
    def _simulate_truck_day(
        self,
        truck_id: str,
        day: date
    ) -> Iterator[TelemetryPoint]:
        """Simulate a full day for a single truck with continuous position."""
        lifecycle = self.lifecycles[truck_id]
        truck = self.trucks[truck_id]
        
        schedule_key = (truck_id, day)
        has_schedule = schedule_key in self._schedule_lookup
        
        if has_schedule:
            is_operating = True
        else:
            is_weekend = day.weekday() >= 5
            operating_rate = (
                self.config['fleet']['weekend_operating_rate']
                if is_weekend else
                self.config['fleet']['weekday_operating_rate']
            )
            is_operating = self.rng.random() < operating_rate
        
        start_hour = self.rng.integers(5, 8)
        lifecycle.start_new_day(day, start_hour)
        
        if lifecycle.current_state == TruckState.OVERNIGHT_REST_STOP:
            yield from self._emit_overnight_wakeup(lifecycle, day)
        elif lifecycle.current_state in (TruckState.OVERNIGHT_WAREHOUSE, TruckState.OVERNIGHT_RETAIL):
            yield from self._emit_overnight_wakeup(lifecycle, day)
        
        if not is_operating:
            yield from self._emit_idle_day(lifecycle, day)
            return
        
        if has_schedule:
            num_trips = len(self._schedule_lookup[schedule_key])
        else:
            num_trips = self._get_trips_for_day(truck)
        
        for trip_num in range(num_trips):
            if lifecycle.current_time.hour >= 20:
                break
            
            trip = self._plan_trip(lifecycle, day, trip_num)
            if not trip or not trip.route:
                continue
            
            if not lifecycle.can_start_trip(trip.route.duration_min):
                logger.debug(f"Truck {truck_id} out of hours, ending day")
                break
            
            yield from self._emit_reposition_to(
                lifecycle, day, trip_num,
                trip.origin_coords[0], trip.origin_coords[1],
                trip.origin_id
            )
            
            self.generated_trips.append(trip)
            
            yield from self._emit_pre_trip_dwell(lifecycle, trip)
            yield from self._emit_trip_driving(lifecycle, trip)
            yield from self._emit_post_trip_dwell(lifecycle, trip)
        
        yield from self._emit_end_of_day(lifecycle, day)
    
    def _get_trips_for_day(self, truck: TruckAssignment) -> int:
        """Determine number of trips for a truck today."""
        cfg = self.config['fleet']['trips_per_day']
        return self.rng.integers(cfg['min'], cfg['max'] + 1)
    
    def _plan_trip(
        self,
        lifecycle: TruckLifecycle,
        day: date,
        trip_num: int
    ) -> Optional[Trip]:
        """Plan a trip from current position, using schedule if available."""
        schedule_key = (lifecycle.truck_id, day)
        scheduled = self._schedule_lookup.get(schedule_key)
        
        if scheduled and trip_num < len(scheduled):
            return self._plan_trip_from_schedule(lifecycle, day, trip_num, scheduled[trip_num])
        
        return self._plan_trip_random(lifecycle, day, trip_num)
    
    def _plan_trip_from_schedule(
        self,
        lifecycle: TruckLifecycle,
        day: date,
        trip_num: int,
        sched_entry: Dict
    ) -> Optional[Trip]:
        """Plan a trip using a scheduled OD pair."""
        origin_id = sched_entry['origin_id']
        dest_id = sched_entry['dest_id']
        
        origin_coords = self._location_coords.get(origin_id)
        dest_coords = self._location_coords.get(dest_id)
        
        if origin_coords is None or dest_coords is None:
            logger.warning(f"Missing coordinates for OD pair {origin_id} -> {dest_id}, falling back to random")
            return self._plan_trip_random(lifecycle, day, trip_num)
        
        route_variation = sched_entry.get('route_variation', 'OPTIMAL')
        is_detour = route_variation in ('MINOR_DEVIATION', 'MEDIUM_DEVIATION', 'MAJOR_DEVIATION', 'DETOUR')
        
        route = self.router.get_route(
            origin_id=origin_id,
            dest_id=dest_id,
            origin_lng=origin_coords[0],
            origin_lat=origin_coords[1],
            dest_lng=dest_coords[0],
            dest_lat=dest_coords[1],
            route_variation=route_variation,
            deviation_factor=sched_entry.get('route_deviation_factor', 1.0),
            rng=self.rng
        )
        
        if route is None:
            logger.warning(f"No route for truck {lifecycle.truck_id} scheduled trip {origin_id} -> {dest_id}")
            return None
        
        trip_id = f"{day.strftime('%Y%m%d')}-{lifecycle.truck_id}-{trip_num:02d}"
        
        origin_loc_type = self._location_types.get(origin_id, 'WAREHOUSE')
        dest_loc_type = self._location_types.get(dest_id, 'WAREHOUSE')
        
        return Trip(
            trip_id=trip_id,
            truck_id=lifecycle.truck_id,
            driver_id=lifecycle.driver_id,
            origin_id=origin_id,
            dest_id=dest_id,
            origin_coords=origin_coords,
            dest_coords=dest_coords,
            scheduled_start=lifecycle.current_time,
            trip_type=sched_entry.get('trip_type', 'WAREHOUSE_TO_WAREHOUSE'),
            route_variation=route_variation,
            route=route,
            is_detour=is_detour,
            origin_location_type=origin_loc_type,
            dest_location_type=dest_loc_type
        )
    
    def _plan_trip_random(
        self,
        lifecycle: TruckLifecycle,
        day: date,
        trip_num: int
    ) -> Optional[Trip]:
        """Plan a trip with random destination (fallback when no schedule)."""
        origin_coords = (lifecycle.current_lng, lifecycle.current_lat)
        origin_id = lifecycle.current_location_id or lifecycle.home_base_id
        
        dest_row, trip_type = self._select_destination(lifecycle)
        if dest_row is None:
            return None
        
        dest_id = dest_row.get('destination_id') or dest_row.get('warehouse_id') or dest_row.get('id')
        dest_coords = (dest_row['longitude'], dest_row['latitude'])
        
        is_detour = self.behavior.should_take_detour(lifecycle.profile)
        if is_detour:
            route_variation = "DETOUR"
            route_index = self.rng.integers(1, 3)
        elif self.rng.random() < self.config['routing']['alternative_route_probability']:
            route_variation = "ALTERNATIVE"
            route_index = 1
        else:
            route_variation = "OPTIMAL"
            route_index = 0
        
        route = self.router.get_route(
            origin_id=origin_id,
            dest_id=dest_id,
            origin_lng=origin_coords[0],
            origin_lat=origin_coords[1],
            dest_lng=dest_coords[0],
            dest_lat=dest_coords[1],
            route_index=route_index
        )
        
        if route is None:
            logger.warning(f"No route for truck {lifecycle.truck_id} trip {trip_num}")
            return None
        
        trip_id = f"{day.strftime('%Y%m%d')}-{lifecycle.truck_id}-{trip_num:02d}"
        
        origin_loc_type = self._location_types.get(origin_id, 'WAREHOUSE')
        dest_loc_type = self._location_types.get(dest_id, 'WAREHOUSE')
        
        return Trip(
            trip_id=trip_id,
            truck_id=lifecycle.truck_id,
            driver_id=lifecycle.driver_id,
            origin_id=origin_id,
            dest_id=dest_id,
            origin_coords=origin_coords,
            dest_coords=dest_coords,
            scheduled_start=lifecycle.current_time,
            trip_type=trip_type,
            route_variation=route_variation,
            route=route,
            is_detour=is_detour,
            origin_location_type=origin_loc_type,
            dest_location_type=dest_loc_type
        )
    
    def _select_destination(
        self,
        lifecycle: TruckLifecycle
    ) -> Tuple[Optional[pd.Series], str]:
        """Select destination with distance-weighted probability."""
        dist_config = self.config.get('distance_distribution', {
            'short_pct': 0.60, 'short_max_km': 100,
            'medium_pct': 0.30, 'medium_max_km': 300,
            'long_pct': 0.10
        })
        
        if lifecycle.home_base_id not in self._destination_distances:
            dests = self.destinations.copy()
            dests['distance_km'] = dests.apply(
                lambda row: haversine_distance(
                    lifecycle.home_coords[1], lifecycle.home_coords[0],
                    row['latitude'], row['longitude']
                ),
                axis=1
            )
            self._destination_distances[lifecycle.home_base_id] = dests
        
        dests = self._destination_distances[lifecycle.home_base_id]
        
        short_max = dist_config.get('short_max_km', 100)
        medium_max = dist_config.get('medium_max_km', 300)
        
        short = dests[dests['distance_km'] < short_max]
        medium = dests[(dests['distance_km'] >= short_max) & (dests['distance_km'] < medium_max)]
        long_haul = dests[dests['distance_km'] >= medium_max]
        
        roll = self.rng.random()
        short_pct = dist_config.get('short_pct', 0.60)
        medium_pct = dist_config.get('medium_pct', 0.30)
        
        if roll < short_pct and not short.empty:
            selected = short
        elif roll < short_pct + medium_pct and not medium.empty:
            selected = medium
        elif not long_haul.empty:
            selected = long_haul
        else:
            selected = dests
        
        if selected.empty:
            return None, ""
        
        dest_row = selected.sample(n=1, random_state=int(self.rng.integers(1e9))).iloc[0]
        
        if 'location_type' in dest_row and dest_row['location_type'] == 'RETAIL':
            trip_type = "WAREHOUSE_TO_RETAIL"
        else:
            trip_type = "WAREHOUSE_TO_WAREHOUSE"
        
        return dest_row, trip_type
    
    def _emit_reposition_to(
        self,
        lifecycle: TruckLifecycle,
        day: date,
        trip_num: int,
        dest_lng: float,
        dest_lat: float,
        dest_location_id: str
    ) -> Iterator[TelemetryPoint]:
        dist_km = haversine_distance(
            lifecycle.current_lat, lifecycle.current_lng,
            dest_lat, dest_lng
        )
        if dist_km < 0.5:
            lifecycle.update_position(dest_lat, dest_lng)
            lifecycle.current_location_id = dest_location_id
            return

        reposition_route = self.router.route_between_points(
            lifecycle.current_lng, lifecycle.current_lat,
            dest_lng, dest_lat
        )
        if reposition_route:
            repo_trip_id = f"{day.strftime('%Y%m%d')}-{lifecycle.truck_id}-REPO-{trip_num:02d}"
            lifecycle.start_trip(repo_trip_id)
            lifecycle.current_state = TruckState.DRIVING
            yield from self._emit_driving_along_route(lifecycle, reposition_route)
            lifecycle.end_trip()

        lifecycle.update_position(dest_lat, dest_lng)
        lifecycle.current_location_id = dest_location_id

    def _emit_pre_trip_dwell(
        self,
        lifecycle: TruckLifecycle,
        trip: Trip
    ) -> Iterator[TelemetryPoint]:
        """Emit dwell telemetry before trip starts (loading/pickup)."""
        if trip.origin_location_type == 'RETAIL':
            dwell_min = self.rng.uniform(15, 45)
            dwell_status = "DWELL_STORE"
        else:
            dwell_min = self.behavior.get_dwell_duration('warehouse')
            if self.rng.random() < 0.05:
                dwell_min = self.behavior.get_dwell_duration('warehouse', is_long_dwell=True)
            dwell_status = "DWELL_WAREHOUSE"
        
        lifecycle.start_trip(trip.trip_id)
        lifecycle.current_state = TruckState.DWELL_WAREHOUSE
        
        yield from self._emit_dwell_points(
            lifecycle=lifecycle,
            duration_min=dwell_min,
            location_type=dwell_status,
            interval_sec=self.dwell_interval_sec
        )
    
    def _emit_trip_driving(
        self,
        lifecycle: TruckLifecycle,
        trip: Trip
    ) -> Iterator[TelemetryPoint]:
        """Emit driving telemetry along route with 30-sec intervals."""
        route = trip.route
        lifecycle.current_state = TruckState.DRIVING
        
        route_points = self._interpolate_route_by_time(route)
        
        total_duration_sec = route.duration_min * 60
        breaks_config = self.config.get('breaks', {})
        break_threshold_min = breaks_config.get('driving_hours_between_breaks', 4.5) * 60
        
        detour_dwells = getattr(route, 'detour_dwells', []) or []
        pending_dwells = list(detour_dwells)
        
        prev_lng, prev_lat = lifecycle.current_lng, lifecycle.current_lat
        
        for point_data in route_points:
            lng, lat, elapsed_sec, segment_speed = point_data
            
            if lifecycle.needs_break(break_threshold_min / 60):
                rest_stop = self._find_nearby_rest_stop(lat, lng)
                if rest_stop:
                    rest_stop_id, rs_lng, rs_lat, rs_type = rest_stop
                    route_to_stop = self.router.route_between_points(lng, lat, rs_lng, rs_lat)
                    if route_to_stop:
                        lifecycle.current_state = TruckState.DRIVING
                        yield from self._emit_driving_along_route(lifecycle, route_to_stop)

                    lifecycle.update_position(rs_lat, rs_lng)
                    lifecycle.current_location_id = rest_stop_id
                    lifecycle.current_state = TruckState.DWELL_REST_STOP
                    
                    break_min = breaks_config.get('mandatory_break_duration_min', 45)
                    yield from self._emit_dwell_points(
                        lifecycle=lifecycle,
                        duration_min=break_min,
                        location_type="DWELL_REST_STOP",
                        interval_sec=self.dwell_interval_sec
                    )
                    lifecycle.take_break(break_min)

                    route_back = self.router.route_between_points(rs_lng, rs_lat, lng, lat)
                    if route_back:
                        lifecycle.current_state = TruckState.DRIVING
                        yield from self._emit_driving_along_route(lifecycle, route_back)

                    lifecycle.update_position(lat, lng)
                    lifecycle.current_state = TruckState.DRIVING
            
            if pending_dwells:
                remaining = []
                for dwell_info in pending_dwells:
                    wp_lng, wp_lat = dwell_info['coords']
                    dist = haversine_distance(lat, lng, wp_lat, wp_lng)
                    if dist < 2.0:
                        lifecycle.update_position(lat, lng)
                        lifecycle.current_state = TruckState.DWELL_REST_STOP
                        yield from self._emit_dwell_points(
                            lifecycle=lifecycle,
                            duration_min=dwell_info['dwell_min'],
                            location_type="DWELL_DETOUR",
                            interval_sec=self.dwell_interval_sec
                        )
                        lifecycle.current_state = TruckState.DRIVING
                    else:
                        remaining.append(dwell_info)
                pending_dwells = remaining
            
            jittered_lat, jittered_lng = self.behavior.add_gps_jitter(lat, lng)
            
            is_speeding = self.behavior.should_speed(lifecycle.profile)
            speed_factor = self.behavior.get_speed_factor(lifecycle.profile, is_speeding)
            
            is_start = elapsed_sec < 120
            is_end = (total_duration_sec - elapsed_sec) < 120
            speed = simulate_acceleration(
                segment_speed * speed_factor,
                elapsed_sec,
                total_duration_sec,
                is_start, is_end
            )
            
            route_progress = elapsed_sec / total_duration_sec if total_duration_sec > 0 else 0.5
            posted_speed = estimate_posted_speed(
                route.distance_km, route.duration_min, self.config,
                route_progress=route_progress,
                route_distance_km=route.distance_km
            )
            
            threshold = self.config['speeding']['threshold_factor']
            actual_speeding = speed > posted_speed * threshold
            
            heading = calculate_heading(prev_lng, prev_lat, lng, lat)
            
            interval_sec = self.moving_interval_sec + self.rng.integers(
                -self.moving_variance_sec, self.moving_variance_sec + 1
            )
            interval_sec = max(15, interval_sec)
            driving_min = interval_sec / 60
            lifecycle.add_driving_time(driving_min)
            
            yield TelemetryPoint(
                telemetry_id=str(uuid.uuid4()),
                truck_id=lifecycle.truck_id,
                driver_id=lifecycle.driver_id,
                trip_id=lifecycle.current_trip_id,
                timestamp=lifecycle.current_time,
                latitude=jittered_lat,
                longitude=jittered_lng,
                speed_kmh=max(0, speed),
                heading_deg=heading,
                posted_speed_kmh=posted_speed,
                status='MOVING',
                is_speeding=actual_speeding,
                is_hos_violation=lifecycle.daily_driving_minutes > 9 * 60,
                is_detour=trip.is_detour,
                gps_accuracy_m=self.rng.uniform(5, 20)
            )
            
            lifecycle.total_points_generated += 1
            lifecycle.update_position(lat, lng)
            lifecycle.advance_time(interval_sec)
            prev_lng, prev_lat = lng, lat
        
        lifecycle.update_position(trip.dest_coords[1], trip.dest_coords[0])
        lifecycle.current_location_id = trip.dest_id
    
    def _emit_post_trip_dwell(
        self,
        lifecycle: TruckLifecycle,
        trip: Trip
    ) -> Iterator[TelemetryPoint]:
        """Emit dwell telemetry after trip ends (unloading/delivery)."""
        if trip.dest_location_type == 'RETAIL':
            dwell_min = self.rng.uniform(15, 45)
            dwell_status = "DWELL_STORE"
        else:
            dwell_min = float(self.rng.lognormal(np.log(45), 0.5))
            dwell_min = max(20, min(dwell_min, 180))
            if self.rng.random() < 0.05:
                dwell_min = self.rng.uniform(480, 1440)
            dwell_status = "DWELL_DESTINATION"
        
        lifecycle.current_state = TruckState.DWELL_DESTINATION
        
        yield from self._emit_dwell_points(
            lifecycle=lifecycle,
            duration_min=dwell_min,
            location_type=dwell_status,
            interval_sec=self.dwell_interval_sec
        )
        
        lifecycle.end_trip()
    
    def _emit_driving_along_route(
        self,
        lifecycle: TruckLifecycle,
        route: RouteResult,
        is_detour: bool = False
    ) -> Iterator[TelemetryPoint]:
        route_points = self._interpolate_route_by_time(route)
        total_duration_sec = route.duration_min * 60
        prev_lng, prev_lat = lifecycle.current_lng, lifecycle.current_lat

        for lng, lat, elapsed_sec, segment_speed in route_points:
            jittered_lat, jittered_lng = self.behavior.add_gps_jitter(lat, lng)
            is_speeding = self.behavior.should_speed(lifecycle.profile)
            speed_factor = self.behavior.get_speed_factor(lifecycle.profile, is_speeding)

            speed = simulate_acceleration(
                segment_speed * speed_factor,
                elapsed_sec,
                total_duration_sec,
                elapsed_sec < 120,
                (total_duration_sec - elapsed_sec) < 120
            )

            route_progress = elapsed_sec / total_duration_sec if total_duration_sec > 0 else 0.5
            posted_speed = estimate_posted_speed(
                route.distance_km, route.duration_min, self.config,
                route_progress=route_progress,
                route_distance_km=route.distance_km
            )
            threshold = self.config['speeding']['threshold_factor']
            actual_speeding = speed > posted_speed * threshold
            heading = calculate_heading(prev_lng, prev_lat, lng, lat)

            interval_sec = self.moving_interval_sec + self.rng.integers(
                -self.moving_variance_sec, self.moving_variance_sec + 1
            )
            interval_sec = max(15, interval_sec)

            yield TelemetryPoint(
                telemetry_id=str(uuid.uuid4()),
                truck_id=lifecycle.truck_id,
                driver_id=lifecycle.driver_id,
                trip_id=lifecycle.current_trip_id or f"TRANSIT-{lifecycle.truck_id}",
                timestamp=lifecycle.current_time,
                latitude=jittered_lat,
                longitude=jittered_lng,
                speed_kmh=speed,
                heading_deg=heading,
                posted_speed_kmh=posted_speed,
                status="MOVING",
                is_speeding=actual_speeding,
                is_hos_violation=False,
                is_detour=is_detour,
                gps_accuracy_m=self.rng.uniform(5, 20)
            )

            lifecycle.total_points_generated += 1
            lifecycle.update_position(lat, lng)
            lifecycle.advance_time(interval_sec)
            prev_lng, prev_lat = lng, lat

    def _emit_dwell_points(
        self,
        lifecycle: TruckLifecycle,
        duration_min: float,
        location_type: str,
        interval_sec: int
    ) -> Iterator[TelemetryPoint]:
        """Emit pings during stationary periods at max 60-second intervals."""
        elapsed_sec = 0.0
        total_sec = duration_min * 60
        
        while elapsed_sec < total_sec:
            jittered_lat = lifecycle.current_lat + self.rng.normal(0, 0.00002)
            jittered_lng = lifecycle.current_lng + self.rng.normal(0, 0.00002)
            
            yield TelemetryPoint(
                telemetry_id=str(uuid.uuid4()),
                truck_id=lifecycle.truck_id,
                driver_id=lifecycle.driver_id,
                trip_id=lifecycle.current_trip_id or f"DWELL-{lifecycle.truck_id}",
                timestamp=lifecycle.current_time,
                latitude=jittered_lat,
                longitude=jittered_lng,
                speed_kmh=self.rng.uniform(0, 3),
                heading_deg=self.rng.uniform(0, 360),
                posted_speed_kmh=10,
                status=location_type,
                is_speeding=False,
                is_hos_violation=False,
                is_detour=False,
                gps_accuracy_m=self.rng.uniform(5, 15),
                location_id=lifecycle.current_location_id,
                location_type=location_type
            )
            
            lifecycle.total_points_generated += 1
            actual_interval = int(min(interval_sec, 60) + self.rng.integers(-10, 11))
            actual_interval = max(30, min(actual_interval, 60))
            lifecycle.advance_time(actual_interval)
            elapsed_sec += actual_interval
    
    def _emit_end_of_day(
        self,
        lifecycle: TruckLifecycle,
        day: date
    ) -> Iterator[TelemetryPoint]:
        """Emit overnight telemetry and position truck for next day."""
        current_hour = lifecycle.current_time.hour
        
        if current_hour < 18:
            yield from self._emit_dwell_points(
                lifecycle=lifecycle,
                duration_min=(18 - current_hour) * 60,
                location_type="IDLE",
                interval_sec=60
            )
        
        dist_to_home = lifecycle.distance_to_home()
        time_to_home_min = (dist_to_home / 60) * 60
        
        loc_type = self._location_types.get(lifecycle.current_location_id, 'WAREHOUSE')
        stay_at_dest = self.rng.random() < 0.35

        if stay_at_dest and lifecycle.current_location_id:
            if loc_type == 'RETAIL':
                lifecycle.current_state = TruckState.OVERNIGHT_RETAIL
            else:
                lifecycle.current_state = TruckState.OVERNIGHT_WAREHOUSE
        elif dist_to_home < 50 or time_to_home_min < 90:
            route_home = self.router.get_route(
                origin_id=lifecycle.current_location_id or "current",
                dest_id=lifecycle.home_base_id,
                origin_lng=lifecycle.current_lng,
                origin_lat=lifecycle.current_lat,
                dest_lng=lifecycle.home_coords[0],
                dest_lat=lifecycle.home_coords[1]
            )
            
            if route_home and lifecycle.can_start_trip(route_home.duration_min):
                return_trip_id = f"{day.strftime('%Y%m%d')}-{lifecycle.truck_id}-RETURN"
                lifecycle.start_trip(return_trip_id)
                
                return_trip = Trip(
                    trip_id=return_trip_id,
                    truck_id=lifecycle.truck_id,
                    driver_id=lifecycle.driver_id,
                    origin_id=lifecycle.current_location_id or "current",
                    dest_id=lifecycle.home_base_id,
                    origin_coords=(lifecycle.current_lng, lifecycle.current_lat),
                    dest_coords=lifecycle.home_coords,
                    scheduled_start=lifecycle.current_time,
                    trip_type="RETURN_HOME",
                    route_variation="OPTIMAL",
                    route=route_home
                )
                
                yield from self._emit_trip_driving(lifecycle, return_trip)
                
                lifecycle.current_location_id = lifecycle.home_base_id
                lifecycle.current_state = TruckState.OVERNIGHT_HOME
                lifecycle.end_trip()
            else:
                if loc_type == 'RETAIL':
                    lifecycle.current_state = TruckState.OVERNIGHT_RETAIL
                elif loc_type == 'WAREHOUSE':
                    lifecycle.current_state = TruckState.OVERNIGHT_WAREHOUSE
                else:
                    lifecycle.current_state = TruckState.OVERNIGHT_REST_STOP
        else:
            if loc_type == 'RETAIL':
                lifecycle.current_state = TruckState.OVERNIGHT_RETAIL
            elif loc_type == 'WAREHOUSE':
                lifecycle.current_state = TruckState.OVERNIGHT_WAREHOUSE
            else:
                lifecycle.current_state = TruckState.OVERNIGHT_REST_STOP
        
        yield from self._emit_overnight(lifecycle, day)
    
    def _emit_overnight(
        self,
        lifecycle: TruckLifecycle,
        day: date
    ) -> Iterator[TelemetryPoint]:
        """Emit overnight telemetry with duration variety."""
        overnight_hours = self._pick_overnight_hours(day)
        wake_time = lifecycle.current_time + timedelta(hours=overnight_hours)
        next_day = day + timedelta(days=1)
        next_start = datetime.combine(next_day, time(self.rng.integers(5, 8), 0))
        end_time = min(wake_time, next_start)
        
        overnight_id = f"{day.strftime('%Y%m%d')}-{lifecycle.truck_id}-OVERNIGHT"
        
        state_to_status = {
            TruckState.OVERNIGHT_HOME: "OVERNIGHT_HOME",
            TruckState.OVERNIGHT_REST_STOP: "OVERNIGHT_REST_STOP",
            TruckState.OVERNIGHT_WAREHOUSE: "OVERNIGHT_WAREHOUSE",
            TruckState.OVERNIGHT_RETAIL: "OVERNIGHT_RETAIL",
        }
        location_type = state_to_status.get(lifecycle.current_state, "OVERNIGHT_REST_STOP")
        
        while lifecycle.current_time < end_time:
            jittered_lat = lifecycle.current_lat + self.rng.normal(0, 0.00001)
            jittered_lng = lifecycle.current_lng + self.rng.normal(0, 0.00001)
            
            yield TelemetryPoint(
                telemetry_id=str(uuid.uuid4()),
                truck_id=lifecycle.truck_id,
                driver_id=lifecycle.driver_id,
                trip_id=overnight_id,
                timestamp=lifecycle.current_time,
                latitude=jittered_lat,
                longitude=jittered_lng,
                speed_kmh=0,
                heading_deg=0,
                posted_speed_kmh=0,
                status=location_type,
                is_speeding=False,
                is_hos_violation=False,
                is_detour=False,
                gps_accuracy_m=self.rng.uniform(5, 15),
                location_id=lifecycle.current_location_id,
                location_type=location_type
            )
            
            lifecycle.total_points_generated += 1
            interval = self.rng.integers(30, 61)
            lifecycle.advance_time(interval)
    
    def _pick_overnight_hours(self, day: date) -> float:
        is_weekend = day.weekday() >= 4
        if is_weekend:
            return float(self.rng.uniform(10, 14))
        roll = self.rng.random()
        if roll < 0.15:
            return float(self.rng.uniform(5, 7))
        elif roll < 0.80:
            return float(self.rng.uniform(8, 11))
        else:
            return float(self.rng.uniform(11, 14))
    
    def _emit_idle_day(
        self,
        lifecycle: TruckLifecycle,
        day: date
    ) -> Iterator[TelemetryPoint]:
        """Emit telemetry for a non-operating day at max 60-second intervals."""
        next_day = day + timedelta(days=1)
        next_start = datetime.combine(next_day, time(6, 0))
        
        idle_id = f"{day.strftime('%Y%m%d')}-{lifecycle.truck_id}-IDLE"
        
        while lifecycle.current_time < next_start:
            jittered_lat = lifecycle.current_lat + self.rng.normal(0, 0.00001)
            jittered_lng = lifecycle.current_lng + self.rng.normal(0, 0.00001)
            
            yield TelemetryPoint(
                telemetry_id=str(uuid.uuid4()),
                truck_id=lifecycle.truck_id,
                driver_id=lifecycle.driver_id,
                trip_id=idle_id,
                timestamp=lifecycle.current_time,
                latitude=jittered_lat,
                longitude=jittered_lng,
                speed_kmh=0,
                heading_deg=0,
                posted_speed_kmh=0,
                status="IDLE",
                is_speeding=False,
                is_hos_violation=False,
                is_detour=False,
                gps_accuracy_m=self.rng.uniform(5, 15),
                location_id=lifecycle.current_location_id,
                location_type="IDLE"
            )
            
            lifecycle.total_points_generated += 1
            interval = self.rng.integers(30, 61)
            lifecycle.advance_time(interval)
    
    def _emit_overnight_wakeup(
        self,
        lifecycle: TruckLifecycle,
        day: date
    ) -> Iterator[TelemetryPoint]:
        """Handle truck that stayed overnight at rest stop - may need to continue home."""
        pass
    
    def _interpolate_route_by_time(
        self,
        route: RouteResult
    ) -> List[Tuple[float, float, float, float]]:
        """
        Interpolate route points at time-based intervals (~30 seconds).
        
        Returns: List of (lng, lat, elapsed_sec, segment_speed_kmh)
        """
        if not route.coordinates or len(route.coordinates) < 2:
            return []
        
        coords = route.coordinates
        total_duration_sec = route.duration_min * 60
        total_distance_km = route.distance_km
        
        if total_duration_sec <= 0:
            return [(coords[0][0], coords[0][1], 0, 60)]
        
        distances = [0.0]
        for i in range(1, len(coords)):
            d = haversine_distance(
                coords[i-1][1], coords[i-1][0],
                coords[i][1], coords[i][0]
            )
            distances.append(distances[-1] + d)
        
        total_distance_actual = distances[-1] if distances[-1] > 0 else total_distance_km
        
        points = []
        elapsed = 0.0
        
        while elapsed < total_duration_sec:
            progress = elapsed / total_duration_sec
            target_distance = progress * total_distance_actual
            
            seg_idx = 0
            for i in range(1, len(distances)):
                if distances[i] >= target_distance:
                    seg_idx = i - 1
                    break
                seg_idx = i - 1
            
            if seg_idx < len(coords) - 1:
                seg_start_dist = distances[seg_idx]
                seg_end_dist = distances[seg_idx + 1]
                seg_length = seg_end_dist - seg_start_dist
                
                if seg_length > 0:
                    t = (target_distance - seg_start_dist) / seg_length
                    t = max(0, min(1, t))
                else:
                    t = 0
                
                lng = coords[seg_idx][0] + t * (coords[seg_idx + 1][0] - coords[seg_idx][0])
                lat = coords[seg_idx][1] + t * (coords[seg_idx + 1][1] - coords[seg_idx][1])
            else:
                lng, lat = coords[-1][0], coords[-1][1]
            
            avg_speed = (total_distance_km / route.duration_min) * 60 if route.duration_min > 0 else 60
            
            if progress < 0.1 or progress > 0.9:
                segment_speed = avg_speed * 0.7
            elif total_distance_km > 100:
                segment_speed = avg_speed * 1.1
            else:
                segment_speed = avg_speed
            
            points.append((lng, lat, elapsed, segment_speed))
            
            interval = self.moving_interval_sec + self.rng.integers(
                -self.moving_variance_sec, self.moving_variance_sec + 1
            )
            interval = max(15, interval)
            elapsed += interval
        
        return points
    
    def _find_nearby_rest_stop(
        self,
        lat: float,
        lng: float,
        max_distance_km: float = 30
    ) -> Optional[Tuple[str, float, float, str]]:
        """Find nearest rest stop within distance."""
        if self.rest_stops.empty:
            return None
        
        self.rest_stops['_dist'] = self.rest_stops.apply(
            lambda row: haversine_distance(lat, lng, row['latitude'], row['longitude']),
            axis=1
        )
        
        nearby = self.rest_stops[self.rest_stops['_dist'] <= max_distance_km]
        
        if nearby.empty:
            return None
        
        nearest = nearby.loc[nearby['_dist'].idxmin()]
        
        return (
            nearest.get('rest_stop_id', str(uuid.uuid4())),
            nearest['longitude'],
            nearest['latitude'],
            nearest.get('rest_type', 'REST_STOP')
        )


def generate_continuous_telemetry(
    config: dict,
    trucks: List[TruckAssignment],
    router: ORSRouter,
    warehouses: pd.DataFrame,
    destinations: pd.DataFrame,
    rest_stops: pd.DataFrame,
    start_date: date,
    end_date: date,
    chunk_size_days: int = 7,
    trip_schedule: Optional[pd.DataFrame] = None,
    locations: Optional[pd.DataFrame] = None
) -> Generator[pd.DataFrame, None, None]:
    """
    Generate continuous telemetry in chunked DataFrames for memory efficiency.
    
    Yields DataFrames of telemetry points per chunk.
    """
    behavior = BehaviorSimulator(config, config.get('seed', 42))
    
    generator = ContinuousTelemetryGenerator(
        config=config,
        trucks=trucks,
        router=router,
        behavior=behavior,
        warehouses=warehouses,
        destinations=destinations,
        rest_stops=rest_stops,
        trip_schedule=trip_schedule,
        locations=locations
    )
    
    current_chunk_start = start_date
    
    while current_chunk_start <= end_date:
        chunk_end = min(current_chunk_start + timedelta(days=chunk_size_days - 1), end_date)
        
        logger.info(f"Generating chunk: {current_chunk_start} to {chunk_end}")
        
        points = []
        
        for point in generator.generate_continuous(current_chunk_start, chunk_end):
            points.append({
                'telemetry_id': point.telemetry_id,
                'truck_id': point.truck_id,
                'driver_id': point.driver_id,
                'trip_id': point.trip_id,
                'timestamp': point.timestamp,
                'latitude': point.latitude,
                'longitude': point.longitude,
                'speed_kmh': point.speed_kmh,
                'heading_deg': point.heading_deg,
                'posted_speed_kmh': point.posted_speed_kmh,
                'status': point.status,
                'is_speeding': point.is_speeding,
                'is_hos_violation': point.is_hos_violation,
                'is_detour': point.is_detour,
                'gps_accuracy_m': point.gps_accuracy_m,
                'location_id': point.location_id,
                'location_type': point.location_type
            })
        
        if points:
            yield pd.DataFrame(points)
        
        for lifecycle in generator.lifecycles.values():
            lifecycle.current_time = datetime.combine(
                chunk_end + timedelta(days=1),
                time(6, 0)
            )
        
        current_chunk_start = chunk_end + timedelta(days=1)
