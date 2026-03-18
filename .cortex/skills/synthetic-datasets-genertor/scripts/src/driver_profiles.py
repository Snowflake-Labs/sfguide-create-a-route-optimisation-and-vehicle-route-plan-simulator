"""
Driver Profile Module - Behavior mixture model for realistic driver simulation.

Implements:
- Driver profile assignment (COMPLIANT, MILD, OUTLIER)
- Event-level anomaly injection (not always-on)
- Speed variation by profile
- HOS (Hours of Service) tracking
- Detour probability
"""

import logging
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Tuple
from enum import Enum
import numpy as np

logger = logging.getLogger(__name__)


class ProfileType(Enum):
    """Driver behavior profile types."""
    COMPLIANT = "COMPLIANT"
    MILD = "MILD"
    OUTLIER = "OUTLIER"


@dataclass
class DriverProfile:
    """
    Driver behavior profile with event-level probabilities.
    
    NOTE: Even COMPLIANT drivers may have rare anomalies - 
    anomalies are event-level, not always-on flags.
    """
    profile_type: ProfileType
    detour_probability: float       # Probability of taking alternative route
    speeding_probability: float     # Probability of speeding on any segment
    hos_violation_probability: float  # Probability of >9h driving day
    speed_variance: float           # Speed variation factor (e.g., 0.05 = ±5%)
    
    # Derived thresholds
    speed_factor_min: float = field(init=False)
    speed_factor_max: float = field(init=False)
    
    def __post_init__(self):
        self.speed_factor_min = 1.0 - self.speed_variance
        self.speed_factor_max = 1.0 + self.speed_variance


@dataclass 
class DriverState:
    """
    Tracks driver state during simulation for HOS and behavior.
    """
    driver_id: str
    profile: DriverProfile
    current_date: str = ""
    driving_minutes_today: float = 0.0
    last_break_time: Optional[float] = None
    minutes_since_break: float = 0.0
    violations_today: List[str] = field(default_factory=list)
    
    def reset_daily(self, date: str):
        """Reset daily counters."""
        self.current_date = date
        self.driving_minutes_today = 0.0
        self.last_break_time = None
        self.minutes_since_break = 0.0
        self.violations_today = []
    
    def add_driving_time(self, minutes: float):
        """Add driving time and check for HOS violations."""
        self.driving_minutes_today += minutes
        self.minutes_since_break += minutes
    
    def take_break(self, duration_minutes: float):
        """Record a break."""
        if duration_minutes >= 30:
            self.minutes_since_break = 0
    
    @property
    def is_hos_violation(self) -> bool:
        """Check if currently in HOS violation (>9h driving)."""
        return self.driving_minutes_today > 540  # 9 hours
    
    @property
    def needs_mandatory_break(self) -> bool:
        """Check if mandatory break is needed (>4.5h since last break)."""
        return self.minutes_since_break > 270  # 4.5 hours


def create_profile_from_config(
    profile_name: str,
    profile_config: dict
) -> DriverProfile:
    """Create a DriverProfile from configuration."""
    profile_type = ProfileType(profile_name)
    
    return DriverProfile(
        profile_type=profile_type,
        detour_probability=profile_config.get('detour_probability', 0.1),
        speeding_probability=profile_config.get('speeding_probability', 0.05),
        hos_violation_probability=profile_config.get('hos_violation_probability', 0.01),
        speed_variance=profile_config.get('speed_variance', 0.05)
    )


def assign_driver_profiles(
    num_drivers: int,
    config: dict,
    seed: int = 42
) -> List[Tuple[str, DriverProfile]]:
    """
    Assign driver profiles based on mixture model proportions.
    
    Args:
        num_drivers: Number of drivers to assign
        config: Configuration with driver_profiles section
        seed: Random seed
        
    Returns:
        List of (driver_id, DriverProfile) tuples
    """
    rng = np.random.default_rng(seed)
    profiles_config = config.get('driver_profiles', {})
    
    # Build probability distribution
    profile_names = []
    proportions = []
    
    for name, cfg in profiles_config.items():
        profile_names.append(name)
        proportions.append(cfg.get('proportion', 0.33))
    
    # Normalize proportions
    total = sum(proportions)
    proportions = [p / total for p in proportions]
    
    # Create profile objects
    profile_objects = {
        name: create_profile_from_config(name, profiles_config[name])
        for name in profile_names
    }
    
    # Assign profiles to drivers
    assignments = []
    for i in range(num_drivers):
        driver_id = f"DRV-{i:05d}"
        profile_name = rng.choice(profile_names, p=proportions)
        profile = profile_objects[profile_name]
        assignments.append((driver_id, profile))
    
    # Log distribution
    counts = {}
    for _, profile in assignments:
        name = profile.profile_type.value
        counts[name] = counts.get(name, 0) + 1
    
    logger.info(f"Assigned driver profiles: {counts}")
    
    return assignments


class BehaviorSimulator:
    """
    Simulates driver behavior for realistic telemetry generation.
    """
    
    def __init__(self, config: dict, seed: int = 42):
        self.config = config
        self.rng = np.random.default_rng(seed)
        self.telemetry_config = config.get('telemetry', {})
        self.speeding_config = config.get('speeding', {})
    
    def should_take_detour(self, profile: DriverProfile) -> bool:
        """
        Determine if driver should take an alternative route.
        
        Event-level decision based on profile probability.
        """
        return self.rng.random() < profile.detour_probability
    
    def should_speed(self, profile: DriverProfile) -> bool:
        """
        Determine if driver should speed on this segment.
        
        Event-level decision - even compliant drivers occasionally speed.
        """
        return self.rng.random() < profile.speeding_probability
    
    def should_exceed_hos(self, profile: DriverProfile) -> bool:
        """
        Determine if driver will exceed HOS limits today.
        
        Decided at start of day, affects whether mandatory breaks are taken.
        """
        return self.rng.random() < profile.hos_violation_probability
    
    def get_speed_factor(self, profile: DriverProfile, is_speeding: bool = False) -> float:
        """
        Get speed multiplier for current segment.
        
        Args:
            profile: Driver profile
            is_speeding: Whether this is a speeding event
            
        Returns:
            Speed multiplier (e.g., 1.1 = 10% faster)
        """
        if is_speeding:
            # During speeding events, exceed normal variance
            threshold = self.speeding_config.get('threshold_factor', 1.08)
            severe = self.speeding_config.get('severe_threshold', 1.20)
            return self.rng.uniform(threshold, severe)
        else:
            # Normal speed variance within profile limits
            return self.rng.uniform(
                profile.speed_factor_min,
                profile.speed_factor_max
            )
    
    def get_ping_interval(self, is_moving: bool) -> float:
        """
        Get variable ping interval based on movement state.
        
        Returns seconds between telemetry pings.
        """
        ping_config = self.telemetry_config.get('ping_interval', {})
        
        if is_moving:
            cfg = ping_config.get('moving', {'min_sec': 20, 'max_sec': 90})
        else:
            cfg = ping_config.get('stopped', {'min_sec': 300, 'max_sec': 1200})
        
        return self.rng.uniform(cfg['min_sec'], cfg['max_sec'])
    
    def add_gps_jitter(self, lat: float, lng: float) -> Tuple[float, float]:
        """
        Add realistic GPS jitter to coordinates.
        
        Returns (jittered_lat, jittered_lng)
        """
        jitter_config = self.telemetry_config.get('gps_jitter', {})
        
        typical_m = jitter_config.get('typical_m', 10)
        typical_std = jitter_config.get('typical_std_m', 5)
        multipath_prob = jitter_config.get('multipath_probability', 0.02)
        multipath_max = jitter_config.get('multipath_max_m', 150)
        
        # Check for multipath spike
        if self.rng.random() < multipath_prob:
            jitter_m = self.rng.uniform(50, multipath_max)
        else:
            jitter_m = abs(self.rng.normal(typical_m, typical_std))
        
        # Convert meters to degrees (approximate)
        lat_jitter = (jitter_m / 111000) * self.rng.choice([-1, 1])
        lng_jitter = (jitter_m / (111000 * np.cos(np.radians(lat)))) * self.rng.choice([-1, 1])
        
        return lat + lat_jitter, lng + lng_jitter
    
    def should_have_gap(self) -> Tuple[bool, float]:
        """
        Determine if there should be a telemetry gap.
        
        Returns (has_gap, gap_duration_seconds)
        """
        gap_config = self.telemetry_config.get('gaps', {})
        
        if self.rng.random() < gap_config.get('probability', 0.01):
            min_dur = gap_config.get('min_duration_min', 5) * 60
            max_dur = gap_config.get('max_duration_min', 30) * 60
            duration = self.rng.uniform(min_dur, max_dur)
            return True, duration
        
        return False, 0
    
    def get_dwell_duration(
        self,
        location_type: str,
        is_long_dwell: bool = False
    ) -> float:
        """
        Get dwell duration using lognormal distribution.
        
        Args:
            location_type: 'warehouse' or 'rest_stop'
            is_long_dwell: Whether this is a long dwell event
            
        Returns:
            Dwell duration in minutes
        """
        dwell_config = self.config.get('dwell', {})
        
        if location_type == 'warehouse':
            cfg = dwell_config.get('warehouse', {})
            if is_long_dwell:
                return self.rng.uniform(
                    cfg.get('long_dwell_min', 480),
                    cfg.get('long_dwell_max', 1440)
                )
            else:
                loading_cfg = cfg.get('loading', {})
                median = loading_cfg.get('median_min', 45)
                sigma = loading_cfg.get('sigma', 0.8)
                max_min = loading_cfg.get('max_min', 480)
                
                duration = self.rng.lognormal(np.log(median), sigma)
                return min(duration, max_min)
        
        else:  # rest_stop
            cfg = dwell_config.get('rest_stop', {})
            
            # Choose between short break, mandatory break, or overnight
            break_type = self.rng.choice(
                ['short_break', 'mandatory_break', 'overnight'],
                p=[0.6, 0.35, 0.05]
            )
            
            break_cfg = cfg.get(break_type, {})
            median = break_cfg.get('median_min', 30)
            sigma = break_cfg.get('sigma', 0.5)
            max_min = break_cfg.get('max_min', 60)
            
            duration = self.rng.lognormal(np.log(median), sigma)
            return min(duration, max_min)


def calculate_heading(
    prev_lng: float,
    prev_lat: float,
    curr_lng: float,
    curr_lat: float
) -> float:
    """
    Calculate heading/bearing between two points.
    
    Returns heading in degrees (0-360, 0=North).
    """
    dlng = curr_lng - prev_lng
    dlat = curr_lat - prev_lat
    
    # Handle zero movement
    if abs(dlng) < 1e-9 and abs(dlat) < 1e-9:
        return 0.0
    
    # Calculate bearing
    bearing_rad = np.arctan2(dlng, dlat)
    bearing_deg = np.degrees(bearing_rad)
    
    # Normalize to 0-360
    return (bearing_deg + 360) % 360


def simulate_acceleration(
    base_speed: float,
    time_in_segment: float,
    segment_duration: float,
    is_start: bool = False,
    is_end: bool = False
) -> float:
    """
    Simulate realistic acceleration/deceleration.
    
    Args:
        base_speed: Target cruising speed
        time_in_segment: Time since segment start
        segment_duration: Total segment duration
        is_start: Is this near trip start?
        is_end: Is this near trip end?
        
    Returns:
        Adjusted speed
    """
    if is_start and time_in_segment < 60:
        # Accelerating from stop
        accel_factor = min(time_in_segment / 60, 1.0)
        return base_speed * accel_factor * 0.5 + base_speed * 0.5 * accel_factor**2
    
    if is_end and (segment_duration - time_in_segment) < 60:
        # Decelerating to stop
        time_to_end = segment_duration - time_in_segment
        decel_factor = min(time_to_end / 60, 1.0)
        return base_speed * decel_factor
    
    return base_speed
