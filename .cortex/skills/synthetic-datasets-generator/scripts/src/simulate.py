"""
Simulation Module - Trip and telemetry generation in daily chunks.

Implements:
- Trucking mode: warehouse-to-warehouse with HOS breaks
- Food delivery mode: store-to-address round-trip e-bike deliveries
- Memory-efficient chunked processing by day/week
- Telemetry emission along route geometries
- Anomaly injection (speeding, HOS, detours, late deliveries)
"""

import uuid
import logging
from datetime import datetime, timedelta, date
from typing import List, Dict, Optional, Tuple, Generator, Iterator
from dataclasses import dataclass, field
import numpy as np
import pandas as pd

from .driver_profiles import (
    DriverProfile, DriverState, BehaviorSimulator,
    calculate_heading, simulate_acceleration
)
from .routing import RouteResult, ORSRouter, interpolate_route, estimate_posted_speed

logger = logging.getLogger(__name__)


@dataclass
class TelemetryPoint:
    """Single telemetry ping."""
    telemetry_id: str
    truck_id: str
    driver_id: str
    trip_id: str
    timestamp: datetime
    latitude: float
    longitude: float
    speed_kmh: float
    heading_deg: float
    posted_speed_kmh: float
    status: str  # MOVING, STOPPED, DWELL_WAREHOUSE, DWELL_STOP
    is_speeding: bool = False
    is_hos_violation: bool = False
    is_detour: bool = False
    gps_accuracy_m: float = 10.0
    location_id: Optional[str] = None
    location_type: Optional[str] = None


@dataclass
class Trip:
    """Trip metadata."""
    trip_id: str
    truck_id: str
    driver_id: str
    origin_id: str
    dest_id: str
    origin_coords: Tuple[float, float]
    dest_coords: Tuple[float, float]
    scheduled_start: datetime
    trip_type: str  # WAREHOUSE_TO_WAREHOUSE, WAREHOUSE_TO_RETAIL
    route_variation: str  # OPTIMAL, ALTERNATIVE, DETOUR
    route: Optional[RouteResult] = None
    is_detour: bool = False
    origin_location_type: str = "WAREHOUSE"
    dest_location_type: str = "WAREHOUSE"


@dataclass 
class TruckAssignment:
    truck_id: str
    driver_id: str
    profile: DriverProfile
    home_base_id: str
    home_coords: Tuple[float, float]
    truck_type: str
    base_speed_kmh: float


@dataclass
class VehicleAssignment:
    vehicle_id: str
    rider_id: str
    profile: DriverProfile
    home_store_id: str
    home_coords: Tuple[float, float]
    vehicle_type: str
    base_speed_kmh: float
    battery_range_km: float = 60.0


@dataclass
class DeliveryTrip:
    trip_id: str
    vehicle_id: str
    rider_id: str
    store_id: str
    address_id: str
    store_coords: Tuple[float, float]
    address_coords: Tuple[float, float]
    scheduled_start: datetime
    trip_type: str  # STORE_TO_ADDRESS
    route_variation: str
    outbound_route: Optional[RouteResult] = None
    return_route: Optional[RouteResult] = None
    is_detour: bool = False
    pickup_duration_min: float = 7.0
    dropoff_duration_min: float = 3.0
    sla_target_min: float = 30.0
    actual_delivery_min: float = 0.0
    sla_met: bool = True
    battery_start_pct: float = 100.0
    battery_end_pct: float = 100.0


def haversine_distance(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Calculate Haversine distance in km between two points."""
    lat1_rad, lat2_rad = np.radians(lat1), np.radians(lat2)
    dlat = np.radians(lat2 - lat1)
    dlng = np.radians(lng2 - lng1)
    a = np.sin(dlat/2)**2 + np.cos(lat1_rad) * np.cos(lat2_rad) * np.sin(dlng/2)**2
    return 6371 * 2 * np.arcsin(np.sqrt(a))


class TelemetryGenerator:
    """
    Generates synthetic telemetry in memory-efficient chunks.
    """
    
    def __init__(
        self,
        config: dict,
        trucks: List[TruckAssignment],
        router: ORSRouter,
        behavior: BehaviorSimulator,
        warehouses: pd.DataFrame,
        destinations: pd.DataFrame,
        rest_stops: pd.DataFrame
    ):
        self.config = config
        self.trucks = {t.truck_id: t for t in trucks}
        self.router = router
        self.behavior = behavior
        self.warehouses = warehouses
        self.destinations = destinations
        self.rest_stops = rest_stops
        self.rng = np.random.default_rng(config.get('seed', 42))
        
        # Pre-compute destination distances for each truck home base
        self._destination_distances: Dict[str, pd.DataFrame] = {}
        
        # Driver states for HOS tracking
        self.driver_states: Dict[str, DriverState] = {}
        for truck in trucks:
            self.driver_states[truck.driver_id] = DriverState(
                driver_id=truck.driver_id,
                profile=truck.profile
            )
    
    def _get_destinations_with_distances(
        self,
        home_coords: Tuple[float, float],
        home_base_id: str
    ) -> pd.DataFrame:
        """Get destinations with pre-computed distances from home base."""
        if home_base_id not in self._destination_distances:
            dests = self.destinations.copy()
            dests['distance_km'] = dests.apply(
                lambda row: haversine_distance(
                    home_coords[1], home_coords[0],
                    row['latitude'], row['longitude']
                ),
                axis=1
            )
            self._destination_distances[home_base_id] = dests
        return self._destination_distances[home_base_id]
    
    def _select_destination_by_distance(
        self,
        truck: 'TruckAssignment'
    ) -> Tuple[pd.Series, str]:
        """
        Select destination with distance-weighted probability.
        
        Distribution: 60% short (<100km), 30% medium (100-300km), 10% long-haul (>300km)
        """
        dist_config = self.config.get('distance_distribution', {
            'short_pct': 0.60, 'short_max_km': 100,
            'medium_pct': 0.30, 'medium_max_km': 300,
            'long_pct': 0.10
        })
        
        dests = self._get_destinations_with_distances(truck.home_coords, truck.home_base_id)
        
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
        
        dest_row = selected.sample(n=1, random_state=int(self.rng.integers(1e9))).iloc[0]
        
        if 'location_type' in dest_row and dest_row['location_type'] == 'RETAIL':
            trip_type = "WAREHOUSE_TO_RETAIL"
        else:
            trip_type = "WAREHOUSE_TO_WAREHOUSE"
        
        return dest_row, trip_type
    
    def generate_day(
        self,
        day: date,
        trips_per_truck: Optional[Dict[str, int]] = None
    ) -> Iterator[TelemetryPoint]:
        """
        Generate telemetry for a single day.
        
        Yields telemetry points one at a time for memory efficiency.
        Also stores generated trips in self.generated_trips for later retrieval.
        """
        # Reset daily driver states
        for state in self.driver_states.values():
            state.reset_daily(str(day))
        
        # Track generated trips
        if not hasattr(self, 'generated_trips'):
            self.generated_trips = []
        
        # Determine which trucks operate today
        is_weekend = day.weekday() >= 5
        operating_rate = (
            self.config['fleet']['weekend_operating_rate']
            if is_weekend else
            self.config['fleet']['weekday_operating_rate']
        )
        
        operating_trucks = [
            t for t in self.trucks.values()
            if self.rng.random() < operating_rate
        ]
        
        logger.debug(f"Day {day}: {len(operating_trucks)} trucks operating")
        
        # Generate trips for each truck
        for truck in operating_trucks:
            num_trips = self._get_trips_for_day(truck)
            
            for trip_num in range(num_trips):
                trip = self._create_trip(truck, day, trip_num)
                if trip and trip.route:
                    self.generated_trips.append(trip)
                    yield from self._emit_trip_telemetry(trip)
    
    def _get_trips_for_day(self, truck: TruckAssignment) -> int:
        """Determine number of trips for a truck today."""
        cfg = self.config['fleet']['trips_per_day']
        return self.rng.integers(cfg['min'], cfg['max'] + 1)
    
    def _create_trip(
        self,
        truck: TruckAssignment,
        day: date,
        trip_num: int
    ) -> Optional[Trip]:
        """Create a trip with route using distance-weighted destination selection."""
        dest_row, trip_type = self._select_destination_by_distance(truck)
        
        dest_id = dest_row.get('destination_id') or dest_row.get('warehouse_id')
        dest_coords = (dest_row['longitude'], dest_row['latitude'])
        
        # Determine route variation
        profile = truck.profile
        is_detour = self.behavior.should_take_detour(profile)
        
        if is_detour:
            route_variation = "DETOUR"
            route_index = self.rng.integers(1, 3)  # Alternative routes 1-2
        elif self.rng.random() < self.config['routing']['alternative_route_probability']:
            route_variation = "ALTERNATIVE"
            route_index = 1
        else:
            route_variation = "OPTIMAL"
            route_index = 0
        
        # Get route
        route = self.router.get_route(
            origin_id=truck.home_base_id,
            dest_id=dest_id,
            origin_lng=truck.home_coords[0],
            origin_lat=truck.home_coords[1],
            dest_lng=dest_coords[0],
            dest_lat=dest_coords[1],
            route_index=route_index
        )
        
        if route is None:
            logger.warning(f"No route for truck {truck.truck_id} on {day}")
            return None
        
        # Calculate start time
        base_hour = 5 + trip_num * 4 + int(self.rng.integers(0, 2))
        start_time = datetime.combine(day, datetime.min.time()) + timedelta(
            hours=base_hour,
            minutes=int(self.rng.integers(0, 60))
        )
        
        trip_id = f"{day}-{truck.truck_id}-{trip_num}"
        
        return Trip(
            trip_id=trip_id,
            truck_id=truck.truck_id,
            driver_id=truck.driver_id,
            origin_id=truck.home_base_id,
            dest_id=dest_id,
            origin_coords=truck.home_coords,
            dest_coords=dest_coords,
            scheduled_start=start_time,
            trip_type=trip_type,
            route_variation=route_variation,
            route=route,
            is_detour=is_detour
        )
    
    def _emit_trip_telemetry(self, trip: Trip) -> Iterator[TelemetryPoint]:
        """Emit telemetry points for a trip."""
        truck = self.trucks[trip.truck_id]
        driver_state = self.driver_states[trip.driver_id]
        route = trip.route
        
        # Check if driver will exceed HOS today
        will_exceed_hos = self.behavior.should_exceed_hos(truck.profile)
        
        # Pre-compute corridor stops for this route
        corridor_stops = self._get_corridor_stops(route)
        used_stop_ids = set()
        
        # Emit origin dwell
        dwell_duration = self.behavior.get_dwell_duration('warehouse')
        yield from self._emit_dwell(
            trip, trip.scheduled_start, dwell_duration,
            trip.origin_coords, trip.origin_id, 'DWELL_WAREHOUSE'
        )
        
        # Start driving
        current_time = trip.scheduled_start + timedelta(minutes=dwell_duration)
        
        # Get interpolated route points
        interval_sec = int(self.behavior.get_ping_interval(is_moving=True))
        route_points = interpolate_route(route, interval_sec)
        
        prev_lng, prev_lat = route.origin_coords
        total_driving_minutes = 0
        last_break_minutes = 0
        
        for lng, lat, elapsed_sec in route_points:
            # Check for telemetry gap
            has_gap, gap_duration = self.behavior.should_have_gap()
            if has_gap:
                current_time += timedelta(seconds=gap_duration)
                continue
            
            # Add GPS jitter
            jittered_lat, jittered_lng = self.behavior.add_gps_jitter(lat, lng)
            
            # Calculate speed
            is_speeding = self.behavior.should_speed(truck.profile)
            speed_factor = self.behavior.get_speed_factor(truck.profile, is_speeding)
            
            # Base speed from route average
            if route.duration_min > 0:
                base_speed = (route.distance_km / route.duration_min) * 60
            else:
                base_speed = truck.base_speed_kmh
            
            # Apply acceleration near start/end
            is_start = elapsed_sec < 120
            is_end = (route.duration_min * 60 - elapsed_sec) < 120
            speed = simulate_acceleration(
                base_speed * speed_factor,
                elapsed_sec,
                route.duration_min * 60,
                is_start, is_end
            )
            
            # Estimate posted speed using route progress for better accuracy
            route_progress = elapsed_sec / (route.duration_min * 60) if route.duration_min > 0 else 0.5
            posted_speed = estimate_posted_speed(
                route.distance_km, route.duration_min, self.config,
                route_progress=route_progress,
                route_distance_km=route.distance_km
            )
            
            threshold = self.config['speeding']['threshold_factor']
            actual_speeding = speed > posted_speed * threshold
            
            # Calculate heading
            heading = calculate_heading(prev_lng, prev_lat, lng, lat)
            
            # Update driver state
            driving_minutes = interval_sec / 60
            driver_state.add_driving_time(driving_minutes)
            total_driving_minutes += driving_minutes
            last_break_minutes += driving_minutes
            
            # Check if break needed
            breaks_config = self.config.get('breaks', {})
            break_threshold = breaks_config.get('driving_hours_between_breaks', 4.5) * 60
            
            if last_break_minutes > break_threshold and not will_exceed_hos:
                # Select from corridor stops if available, else fall back to nearest
                rest_stop = self._select_corridor_stop(lat, lng, corridor_stops, used_stop_ids)
                if rest_stop:
                    used_stop_ids.add(rest_stop[0])
                    break_duration = self.behavior.get_dwell_duration('rest_stop')
                    yield from self._emit_dwell(
                        trip, current_time, break_duration,
                        (rest_stop[1], rest_stop[2]), rest_stop[0], 'DWELL_STOP'
                    )
                    current_time += timedelta(minutes=break_duration)
                    driver_state.take_break(break_duration)
                    last_break_minutes = 0
            
            # Emit telemetry point
            yield TelemetryPoint(
                telemetry_id=str(uuid.uuid4()),
                truck_id=trip.truck_id,
                driver_id=trip.driver_id,
                trip_id=trip.trip_id,
                timestamp=current_time,
                latitude=jittered_lat,
                longitude=jittered_lng,
                speed_kmh=max(0, speed),
                heading_deg=heading,
                posted_speed_kmh=posted_speed,
                status='MOVING',
                is_speeding=actual_speeding,
                is_hos_violation=driver_state.is_hos_violation,
                is_detour=trip.is_detour,
                gps_accuracy_m=self.behavior.telemetry_config.get('gps_jitter', {}).get('typical_m', 10)
            )
            
            prev_lng, prev_lat = lng, lat
            current_time += timedelta(seconds=interval_sec)
        
        # Emit destination dwell
        dest_dwell = self.behavior.get_dwell_duration('warehouse')
        yield from self._emit_dwell(
            trip, current_time, dest_dwell,
            trip.dest_coords, trip.dest_id, 'DWELL_WAREHOUSE'
        )
    
    def _emit_dwell(
        self,
        trip: Trip,
        start_time: datetime,
        duration_minutes: float,
        coords: Tuple[float, float],
        location_id: str,
        status: str
    ) -> Iterator[TelemetryPoint]:
        """Emit telemetry points during dwell."""
        truck = self.trucks[trip.truck_id]
        interval_sec = int(self.behavior.get_ping_interval(is_moving=False))
        num_points = max(1, int(duration_minutes * 60 / interval_sec))
        
        for i in range(num_points):
            # Small movement within location
            jittered_lat, jittered_lng = self.behavior.add_gps_jitter(
                coords[1], coords[0]
            )
            
            yield TelemetryPoint(
                telemetry_id=str(uuid.uuid4()),
                truck_id=trip.truck_id,
                driver_id=trip.driver_id,
                trip_id=trip.trip_id,
                timestamp=start_time + timedelta(seconds=i * interval_sec),
                latitude=jittered_lat,
                longitude=jittered_lng,
                speed_kmh=self.rng.uniform(0, 5),  # Slow movement in lot
                heading_deg=self.rng.uniform(0, 360),
                posted_speed_kmh=10,
                status=status,
                is_speeding=False,
                is_hos_violation=False,
                is_detour=trip.is_detour,
                gps_accuracy_m=self.behavior.telemetry_config.get('gps_jitter', {}).get('typical_m', 10),
                location_id=location_id,
                location_type=status
            )
    
    def _get_corridor_stops(self, route: RouteResult) -> pd.DataFrame:
        """Pre-compute rest stops along route corridor."""
        from .overture import find_stops_along_route
        
        if not route or not route.coordinates:
            return pd.DataFrame()
        
        buffer_km = self.config.get('breaks', {}).get('corridor_buffer_km', 30)
        return find_stops_along_route(
            route.coordinates, 
            self.rest_stops, 
            buffer_km=buffer_km,
            max_stops=10
        )
    
    def _select_corridor_stop(
        self,
        lat: float,
        lng: float,
        corridor_stops: pd.DataFrame,
        used_stop_ids: set
    ) -> Optional[Tuple[str, float, float, str]]:
        """
        Select a rest stop from corridor candidates, preferring unused stops.
        
        Falls back to point-nearest if no corridor stops available.
        """
        if corridor_stops.empty:
            return self._find_nearby_rest_stop(lat, lng)
        
        available = corridor_stops[~corridor_stops['rest_stop_id'].isin(used_stop_ids)]
        if available.empty:
            available = corridor_stops
        
        distances = available.apply(
            lambda row: haversine_distance(lat, lng, row['latitude'], row['longitude']),
            axis=1
        )
        nearest_idx = distances.idxmin()
        row = available.loc[nearest_idx]
        
        return (
            row['rest_stop_id'],
            row['longitude'],
            row['latitude'],
            row['rest_type']
        )
    
    def _find_nearby_rest_stop(
        self,
        lat: float,
        lng: float,
        max_distance_km: float = 30
    ) -> Optional[Tuple[str, float, float, str]]:
        """Find nearest rest stop within distance."""
        from .overture import find_nearest_rest_stop
        return find_nearest_rest_stop(lat, lng, self.rest_stops, max_distance_km)


@dataclass
class GenerationResult:
    """Container for telemetry generation results."""
    telemetry_df: pd.DataFrame
    trips: List[Trip]
    violations_df: pd.DataFrame


def generate_telemetry_chunked(
    config: dict,
    trucks: List[TruckAssignment],
    router: ORSRouter,
    warehouses: pd.DataFrame,
    destinations: pd.DataFrame,
    rest_stops: pd.DataFrame,
    start_date: date,
    end_date: date,
    chunk_size_days: int = 7
) -> Generator[GenerationResult, None, None]:
    behavior = BehaviorSimulator(config, config.get('seed', 42))

    generator = TelemetryGenerator(
        config=config,
        trucks=trucks,
        router=router,
        behavior=behavior,
        warehouses=warehouses,
        destinations=destinations,
        rest_stops=rest_stops
    )

    current_date = start_date
    while current_date <= end_date:
        chunk_end = min(current_date + timedelta(days=chunk_size_days - 1), end_date)
        logger.info(f"Generating chunk: {current_date} to {chunk_end}")

        generator.generated_trips = []
        points = []
        day = current_date
        while day <= chunk_end:
            for point in generator.generate_day(day):
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
            day += timedelta(days=1)

        if points:
            telemetry_df = pd.DataFrame(points)
            violations_df = telemetry_to_violations(telemetry_df)
            yield GenerationResult(
                telemetry_df=telemetry_df,
                trips=generator.generated_trips.copy(),
                violations_df=violations_df
            )

        current_date = chunk_end + timedelta(days=1)


# ============================================================================
# FOOD DELIVERY MODE
# ============================================================================

class DeliveryTelemetryGenerator:
    def __init__(
        self,
        config: dict,
        vehicles: List[VehicleAssignment],
        router: ORSRouter,
        behavior: BehaviorSimulator,
        stores: pd.DataFrame,
        delivery_addresses: pd.DataFrame
    ):
        self.config = config
        self.vehicles = {v.vehicle_id: v for v in vehicles}
        self.router = router
        self.behavior = behavior
        self.stores = stores
        self.delivery_addresses = delivery_addresses
        self.rng = np.random.default_rng(config.get('seed', 42))
        self.generated_trips: List[DeliveryTrip] = []
        self.battery_config = config.get('battery', {})
        self.shift_config = config.get('shift', {})
        self.sla_config = config.get('delivery_sla', {})

        self.rider_states: Dict[str, DriverState] = {}
        for v in vehicles:
            self.rider_states[v.rider_id] = DriverState(
                driver_id=v.rider_id,
                profile=v.profile
            )

    def generate_day(
        self,
        day: date
    ) -> Iterator[TelemetryPoint]:
        for state in self.rider_states.values():
            state.reset_daily(str(day))

        if not hasattr(self, 'generated_trips'):
            self.generated_trips = []

        operating_rate = self.config['fleet']['daily_operating_rate']
        operating_vehicles = [
            v for v in self.vehicles.values()
            if self.rng.random() < operating_rate
        ]

        logger.debug(f"Day {day}: {len(operating_vehicles)} e-bikes operating")

        for vehicle in operating_vehicles:
            yield from self._generate_rider_shift(vehicle, day)

    def _generate_rider_shift(self, vehicle: VehicleAssignment, day: date) -> Iterator[TelemetryPoint]:
        rider_state = self.rider_states[vehicle.rider_id]
        trips_config = self.config['fleet']['trips_per_day']
        num_deliveries = int(self.rng.integers(trips_config['min'], trips_config['max'] + 1))

        shift_start = self.shift_config.get('start_hour', 10)
        shift_end = self.shift_config.get('end_hour', 22)
        peak_hours = self.shift_config.get('peak_hours', [11, 12, 13, 17, 18, 19, 20])

        current_time = datetime.combine(day, datetime.min.time()) + timedelta(
            hours=shift_start,
            minutes=int(self.rng.integers(0, 30))
        )
        current_store_id = vehicle.home_store_id
        current_coords = vehicle.home_coords

        for delivery_num in range(num_deliveries):
            if current_time.hour >= shift_end:
                break

            if rider_state.needs_recharge:
                recharge_time = self.battery_config.get('recharge_time_min', 30)
                yield from self._emit_dwell(
                    vehicle, current_time, recharge_time,
                    current_coords, current_store_id, 'RECHARGING'
                )
                current_time += timedelta(minutes=recharge_time)
                rider_state.recharge()

            break_after = self.shift_config.get('break_after_hours', 4.0) * 60
            if rider_state.minutes_since_break > break_after:
                break_dur = self.shift_config.get('break_duration_min', 20)
                yield from self._emit_dwell(
                    vehicle, current_time, break_dur,
                    current_coords, current_store_id, 'RIDER_BREAK'
                )
                current_time += timedelta(minutes=break_dur)
                rider_state.take_break(break_dur)

            is_peak = current_time.hour in peak_hours
            if not is_peak and self.rng.random() > 0.6:
                wait_min = int(self.rng.integers(5, 20))
                current_time += timedelta(minutes=wait_min)
                continue

            store_row = self._pick_store(current_coords)
            store_id = store_row.get('store_id', current_store_id)
            store_coords = (store_row['longitude'], store_row['latitude'])

            addr_row = self._pick_delivery_address(store_coords)
            addr_id = addr_row['address_id']
            addr_coords = (addr_row['longitude'], addr_row['latitude'])

            is_detour = self.behavior.should_take_detour(vehicle.profile)
            route_variation = "DETOUR" if is_detour else "OPTIMAL"
            route_index = self.rng.integers(1, 3) if is_detour else 0

            outbound_route = self.router.get_route(
                origin_id=store_id, dest_id=addr_id,
                origin_lng=store_coords[0], origin_lat=store_coords[1],
                dest_lng=addr_coords[0], dest_lat=addr_coords[1],
                route_index=route_index
            )

            return_route = self.router.get_route(
                origin_id=addr_id, dest_id=store_id,
                origin_lng=addr_coords[0], origin_lat=addr_coords[1],
                dest_lng=store_coords[0], dest_lat=store_coords[1],
                route_index=0
            )

            if not outbound_route or not return_route:
                continue

            pickup_dur = self.behavior.get_dwell_duration('store_pickup')
            dropoff_dur = self.behavior.get_dwell_duration('delivery_dropoff')

            trip_id = f"{day}-{vehicle.vehicle_id}-{delivery_num}"
            battery_start = rider_state.battery_pct

            trip = DeliveryTrip(
                trip_id=trip_id,
                vehicle_id=vehicle.vehicle_id,
                rider_id=vehicle.rider_id,
                store_id=store_id,
                address_id=addr_id,
                store_coords=store_coords,
                address_coords=addr_coords,
                scheduled_start=current_time,
                trip_type='STORE_TO_ADDRESS',
                route_variation=route_variation,
                outbound_route=outbound_route,
                return_route=return_route,
                is_detour=is_detour,
                pickup_duration_min=pickup_dur,
                dropoff_duration_min=dropoff_dur,
                sla_target_min=self.sla_config.get('target_minutes', 30),
                battery_start_pct=battery_start
            )

            yield from self._emit_dwell(
                vehicle, current_time, pickup_dur,
                store_coords, store_id, 'DWELL_STORE_PICKUP'
            )
            current_time += timedelta(minutes=pickup_dur)

            delivery_start = current_time
            for point in self._emit_route_telemetry(vehicle, trip, outbound_route, current_time, rider_state):
                yield point
                current_time = point.timestamp

            rider_state.add_distance(
                outbound_route.distance_km,
                self.battery_config.get('drain_per_km', 1.67)
            )

            yield from self._emit_dwell(
                vehicle, current_time, dropoff_dur,
                addr_coords, addr_id, 'DWELL_DELIVERY_DROPOFF'
            )
            current_time += timedelta(minutes=dropoff_dur)

            actual_delivery_min = (current_time - delivery_start).total_seconds() / 60
            trip.actual_delivery_min = actual_delivery_min
            trip.sla_met = actual_delivery_min <= trip.sla_target_min
            trip.battery_end_pct = rider_state.battery_pct

            for point in self._emit_route_telemetry(vehicle, trip, return_route, current_time, rider_state):
                yield point
                current_time = point.timestamp

            rider_state.add_distance(
                return_route.distance_km,
                self.battery_config.get('drain_per_km', 1.67)
            )
            rider_state.deliveries_today += 1

            current_store_id = store_id
            current_coords = store_coords

            self.generated_trips.append(trip)

            gap_min = int(self.rng.integers(1, 5))
            current_time += timedelta(minutes=gap_min)

    def _pick_store(self, current_coords: Tuple[float, float]) -> pd.Series:
        distances = self.stores.apply(
            lambda row: haversine_distance(
                current_coords[1], current_coords[0],
                row['latitude'], row['longitude']
            ), axis=1
        )
        nearby = self.stores[distances < 3.0]
        if nearby.empty:
            nearby = self.stores.nsmallest(20, distances.name if hasattr(distances, 'name') else 0)
            nearby = self.stores.iloc[distances.nsmallest(20).index]
        return nearby.sample(n=1, random_state=int(self.rng.integers(1e9))).iloc[0]

    def _pick_delivery_address(self, store_coords: Tuple[float, float]) -> pd.Series:
        dist_config = self.config.get('distance_distribution', {})
        short_max = dist_config.get('short_max_km', 3)
        medium_max = dist_config.get('medium_max_km', 6)

        distances = self.delivery_addresses.apply(
            lambda row: haversine_distance(
                store_coords[1], store_coords[0],
                row['latitude'], row['longitude']
            ), axis=1
        )

        short = self.delivery_addresses[distances < short_max]
        medium = self.delivery_addresses[(distances >= short_max) & (distances < medium_max)]

        roll = self.rng.random()
        short_pct = dist_config.get('short_pct', 0.70)
        medium_pct = dist_config.get('medium_pct', 0.25)

        if roll < short_pct and not short.empty:
            selected = short
        elif roll < short_pct + medium_pct and not medium.empty:
            selected = medium
        else:
            selected = self.delivery_addresses.iloc[distances.nsmallest(50).index]

        return selected.sample(n=1, random_state=int(self.rng.integers(1e9))).iloc[0]

    def _emit_route_telemetry(
        self,
        vehicle: VehicleAssignment,
        trip: DeliveryTrip,
        route: RouteResult,
        start_time: datetime,
        rider_state: DriverState
    ) -> Iterator[TelemetryPoint]:
        ping_cfg = self.config.get('telemetry', {}).get('ping_interval', {}).get('moving', {})
        interval_sec = ping_cfg.get('target_sec', 10)
        variance_sec = ping_cfg.get('variance_sec', 3)

        route_points = interpolate_route(route, interval_sec)
        prev_lng, prev_lat = route.origin_coords
        current_time = start_time

        for lng, lat, elapsed_sec in route_points:
            has_gap, gap_dur = self.behavior.should_have_gap()
            if has_gap:
                current_time += timedelta(seconds=gap_dur)
                continue

            jittered_lat, jittered_lng = self.behavior.add_gps_jitter(lat, lng)

            is_speeding = self.behavior.should_speed(vehicle.profile)
            speed_factor = self.behavior.get_speed_factor(vehicle.profile, is_speeding)

            if route.duration_min > 0:
                base_speed = (route.distance_km / route.duration_min) * 60
            else:
                base_speed = vehicle.base_speed_kmh

            is_start = elapsed_sec < 30
            is_end = (route.duration_min * 60 - elapsed_sec) < 30
            speed = simulate_acceleration(
                base_speed * speed_factor,
                elapsed_sec,
                route.duration_min * 60,
                is_start, is_end
            )

            route_progress = elapsed_sec / (route.duration_min * 60) if route.duration_min > 0 else 0.5
            posted_speed = estimate_posted_speed(
                route.distance_km, route.duration_min, self.config,
                route_progress=route_progress,
                route_distance_km=route.distance_km
            )

            threshold = self.config.get('speeding', {}).get('threshold_factor', 1.10)
            actual_speeding = speed > posted_speed * threshold

            heading = calculate_heading(prev_lng, prev_lat, lng, lat)

            actual_interval = int(interval_sec + self.rng.integers(-variance_sec, variance_sec + 1))
            rider_state.add_driving_time(actual_interval / 60)

            yield TelemetryPoint(
                telemetry_id=str(uuid.uuid4()),
                truck_id=trip.vehicle_id,
                driver_id=trip.rider_id,
                trip_id=trip.trip_id,
                timestamp=current_time,
                latitude=jittered_lat,
                longitude=jittered_lng,
                speed_kmh=max(0, speed),
                heading_deg=heading,
                posted_speed_kmh=posted_speed,
                status='RIDING',
                is_speeding=actual_speeding,
                is_hos_violation=False,
                is_detour=trip.is_detour,
                gps_accuracy_m=self.behavior.telemetry_config.get('gps_jitter', {}).get('typical_m', 8),
                location_id=None,
                location_type=None
            )

            prev_lng, prev_lat = lng, lat
            current_time += timedelta(seconds=actual_interval)

    def _emit_dwell(
        self,
        vehicle: VehicleAssignment,
        start_time: datetime,
        duration_minutes: float,
        coords: Tuple[float, float],
        location_id: str,
        status: str
    ) -> Iterator[TelemetryPoint]:
        dwell_cfg = self.config.get('telemetry', {}).get('ping_interval', {}).get('dwell', {})
        interval_sec = int(self.rng.integers(
            dwell_cfg.get('min_sec', 60),
            dwell_cfg.get('max_sec', 180) + 1
        ))
        num_points = max(1, int(duration_minutes * 60 / interval_sec))

        for i in range(num_points):
            jittered_lat, jittered_lng = self.behavior.add_gps_jitter(coords[1], coords[0])

            yield TelemetryPoint(
                telemetry_id=str(uuid.uuid4()),
                truck_id=vehicle.vehicle_id,
                driver_id=vehicle.rider_id,
                trip_id='',
                timestamp=start_time + timedelta(seconds=i * interval_sec),
                latitude=jittered_lat,
                longitude=jittered_lng,
                speed_kmh=self.rng.uniform(0, 2),
                heading_deg=self.rng.uniform(0, 360),
                posted_speed_kmh=0,
                status=status,
                is_speeding=False,
                is_hos_violation=False,
                is_detour=False,
                gps_accuracy_m=self.behavior.telemetry_config.get('gps_jitter', {}).get('typical_m', 8),
                location_id=location_id,
                location_type=status
            )


def generate_delivery_telemetry_chunked(
    config: dict,
    vehicles: List[VehicleAssignment],
    router: ORSRouter,
    stores: pd.DataFrame,
    delivery_addresses: pd.DataFrame,
    start_date: date,
    end_date: date,
    chunk_size_days: int = 7
) -> Generator[GenerationResult, None, None]:
    behavior = BehaviorSimulator(config, config.get('seed', 42))

    generator = DeliveryTelemetryGenerator(
        config=config,
        vehicles=vehicles,
        router=router,
        behavior=behavior,
        stores=stores,
        delivery_addresses=delivery_addresses
    )

    current_date = start_date
    while current_date <= end_date:
        chunk_end = min(current_date + timedelta(days=chunk_size_days - 1), end_date)
        logger.info(f"Generating delivery chunk: {current_date} to {chunk_end}")

        generator.generated_trips = []
        points = []
        day = current_date
        while day <= chunk_end:
            for point in generator.generate_day(day):
                points.append({
                    'telemetry_id': point.telemetry_id,
                    'vehicle_id': point.truck_id,
                    'rider_id': point.driver_id,
                    'trip_id': point.trip_id,
                    'timestamp': point.timestamp,
                    'latitude': point.latitude,
                    'longitude': point.longitude,
                    'speed_kmh': point.speed_kmh,
                    'heading_deg': point.heading_deg,
                    'posted_speed_kmh': point.posted_speed_kmh,
                    'status': point.status,
                    'is_speeding': point.is_speeding,
                    'is_late_delivery': False,
                    'is_detour': point.is_detour,
                    'gps_accuracy_m': point.gps_accuracy_m,
                    'location_id': point.location_id,
                    'location_type': point.location_type
                })
            day += timedelta(days=1)

        if points:
            telemetry_df = pd.DataFrame(points)
            violations_df = delivery_to_violations(telemetry_df, generator.generated_trips)
            yield GenerationResult(
                telemetry_df=telemetry_df,
                trips=generator.generated_trips.copy(),
                violations_df=violations_df
            )

        current_date = chunk_end + timedelta(days=1)


def telemetry_to_violations(df: pd.DataFrame) -> pd.DataFrame:
    violations = []

    speeding = df[df['is_speeding']].copy()
    if not speeding.empty:
        speeding = speeding.sort_values(['truck_id', 'trip_id', 'timestamp'])
        for (truck_id, trip_id), group in speeding.groupby(['truck_id', 'trip_id']):
            violations.append({
                'violation_id': str(uuid.uuid4()),
                'truck_id': truck_id,
                'trip_id': trip_id,
                'violation_type': 'SPEEDING',
                'start_time': group['timestamp'].min(),
                'end_time': group['timestamp'].max(),
                'duration_minutes': (group['timestamp'].max() - group['timestamp'].min()).total_seconds() / 60,
                'max_speed_kmh': group['speed_kmh'].max(),
                'posted_speed_kmh': group['posted_speed_kmh'].mean()
            })

    hos = df[df['is_hos_violation']].copy()
    if not hos.empty:
        for truck_id, group in hos.groupby('truck_id'):
            violations.append({
                'violation_id': str(uuid.uuid4()),
                'truck_id': truck_id,
                'trip_id': group['trip_id'].iloc[0],
                'violation_type': 'HOS_EXCEEDED',
                'start_time': group['timestamp'].min(),
                'end_time': group['timestamp'].max(),
                'duration_minutes': (group['timestamp'].max() - group['timestamp'].min()).total_seconds() / 60,
                'max_speed_kmh': None,
                'posted_speed_kmh': None
            })

    return pd.DataFrame(violations) if violations else pd.DataFrame()


def delivery_to_violations(
    df: pd.DataFrame,
    trips: List[DeliveryTrip]
) -> pd.DataFrame:
    violations = []

    speeding = df[df['is_speeding']].copy()
    if not speeding.empty:
        speeding = speeding.sort_values(['vehicle_id', 'trip_id', 'timestamp'])
        for (vehicle_id, trip_id), group in speeding.groupby(['vehicle_id', 'trip_id']):
            violations.append({
                'violation_id': str(uuid.uuid4()),
                'vehicle_id': vehicle_id,
                'trip_id': trip_id,
                'violation_type': 'SPEEDING',
                'start_time': group['timestamp'].min(),
                'end_time': group['timestamp'].max(),
                'duration_minutes': (group['timestamp'].max() - group['timestamp'].min()).total_seconds() / 60,
                'max_speed_kmh': group['speed_kmh'].max(),
                'posted_speed_kmh': group['posted_speed_kmh'].mean()
            })

    for trip in trips:
        if not trip.sla_met:
            violations.append({
                'violation_id': str(uuid.uuid4()),
                'vehicle_id': trip.vehicle_id,
                'trip_id': trip.trip_id,
                'violation_type': 'LATE_DELIVERY',
                'start_time': trip.scheduled_start,
                'end_time': trip.scheduled_start + timedelta(minutes=trip.actual_delivery_min),
                'duration_minutes': trip.actual_delivery_min - trip.sla_target_min,
                'max_speed_kmh': None,
                'posted_speed_kmh': None
            })

        if trip.battery_end_pct <= 0:
            violations.append({
                'violation_id': str(uuid.uuid4()),
                'vehicle_id': trip.vehicle_id,
                'trip_id': trip.trip_id,
                'violation_type': 'BATTERY_DEPLETED',
                'start_time': trip.scheduled_start,
                'end_time': trip.scheduled_start + timedelta(minutes=trip.actual_delivery_min),
                'duration_minutes': 0,
                'max_speed_kmh': None,
                'posted_speed_kmh': None
            })

    return pd.DataFrame(violations) if violations else pd.DataFrame()
