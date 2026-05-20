export type VehicleType = 'car' | 'ebike' | 'hgv';
export type RegionScale = 'city' | 'country';

export interface ProfileTemplate {
  id: string;
  name: string;
  description: string;
  vehicleType: VehicleType;
  orsProfile: 'driving-car' | 'cycling-electric' | 'driving-hgv';
  regionScale: RegionScale;
  defaultConfig: Partial<GenerationConfig>;
  feeds: string[];
}

export const PROFILE_TEMPLATES: ProfileTemplate[] = [
  {
    id: 'city-taxis',
    name: 'City Taxis',
    description: 'Car-based taxi and rideshare fleet operating within a city',
    vehicleType: 'car',
    orsProfile: 'driving-car',
    regionScale: 'city',
    feeds: ['fleet-intelligence-taxis'],
    defaultConfig: {
      mode: 'urban_mobility',
      fleet: { num_vehicles: 50, weekday_operating_rate: 0.9, weekend_operating_rate: 0.6, trips_per_day: { min: 8, max: 20 } },
      shifts: [
        { name: 'Morning', start: 6, end: 14, proportion: 0.4 },
        { name: 'Afternoon', start: 14, end: 22, proportion: 0.4 },
        { name: 'Night', start: 22, end: 6, proportion: 0.2 },
      ],
      time: { start_date: '2026-03-01', end_date: '2026-03-07', chunk_size_days: 7 },
      distance_distribution: { short_pct: 0.6, short_max_km: 5, medium_pct: 0.3, medium_max_km: 15, long_pct: 0.1 },
      driver_profiles: {
        COMPLIANT: { proportion: 0.80, detour_probability: 0.05, speeding_probability: 0.05, speed_variance: 0.08 },
        MILD: { proportion: 0.15, detour_probability: 0.12, speeding_probability: 0.10, speed_variance: 0.12 },
        OUTLIER: { proportion: 0.05, detour_probability: 0.25, speeding_probability: 0.20, speed_variance: 0.18 },
      },
      routing: { optimal_route_probability: 0.75, alternative_route_probability: 0.20, detour_probability: 0.05, posted_speeds: { primary: 50, secondary: 40, residential: 30, default: 35 } },
      telemetry: { ping_interval_moving: { mean_sec: 10, std_sec: 3 }, ping_interval_dwell: { min_sec: 30, max_sec: 120 }, gps_jitter: { typical_m: 6, multipath_probability: 0.02, multipath_max_m: 80 } },
      dwell: { origin: { median_min: 3, sigma: 0.5, max_min: 12 }, destination: { median_min: 2, sigma: 0.4, max_min: 8 }, idle: { median_min: 5, sigma: 0.5, max_min: 20 } },
      detour: { probability: 0.05, max_detour_factor: 1.4 },
      poi_categories: ['restaurant', 'bar', 'hotel', 'corporate_or_business_office', 'shopping_mall', 'hospital', 'airport', 'cafe', 'coffee_shop', 'lounge'],
      ghost_trailer: {
        probability: 0.05,
        start_day_min: 0,
        start_day_max: 2,
        duration_days_min: 1,
        duration_days_max: 2,
        ping_interval_min_sec: 120,
        ping_interval_max_sec: 600,
      },
    },
  },
  {
    id: 'ebike-couriers',
    name: 'E-Bike Couriers',
    description: 'Electric bike food delivery couriers in an urban area',
    vehicleType: 'ebike',
    orsProfile: 'cycling-electric',
    regionScale: 'city',
    feeds: ['fleet-intelligence-food-delivery'],
    defaultConfig: {
      mode: 'food_delivery',
      fleet: { num_vehicles: 100, daily_operating_rate: 0.85, trips_per_day: { min: 15, max: 35 } },
      shifts: [
        { name: 'Lunch', start: 10, end: 15, proportion: 0.3 },
        { name: 'Dinner', start: 17, end: 23, proportion: 0.5 },
        { name: 'AllDay', start: 10, end: 23, proportion: 0.2 },
      ],
      time: { start_date: '2026-03-01', end_date: '2026-03-07', chunk_size_days: 7 },
      distance_distribution: { short_pct: 0.7, short_max_km: 3, medium_pct: 0.25, medium_max_km: 8, long_pct: 0.05 },
      driver_profiles: {
        COMPLIANT: { proportion: 0.85, detour_probability: 0.03, speeding_probability: 0.02, speed_variance: 0.06 },
        MILD: { proportion: 0.12, detour_probability: 0.10, speeding_probability: 0.08, speed_variance: 0.10 },
        OUTLIER: { proportion: 0.03, detour_probability: 0.20, speeding_probability: 0.15, speed_variance: 0.14 },
      },
      routing: { optimal_route_probability: 0.85, alternative_route_probability: 0.12, detour_probability: 0.03, posted_speeds: { primary: 25, secondary: 20, residential: 15, default: 18 } },
      telemetry: { ping_interval_moving: { mean_sec: 8, std_sec: 2 }, ping_interval_dwell: { min_sec: 20, max_sec: 90 }, gps_jitter: { typical_m: 5, multipath_probability: 0.03, multipath_max_m: 60 } },
      dwell: { origin: { median_min: 4, sigma: 0.6, max_min: 15 }, destination: { median_min: 2, sigma: 0.3, max_min: 5 }, idle: { median_min: 6, sigma: 0.5, max_min: 20 } },
      battery: { range_km: 60, drain_per_km: 1.67, recharge_threshold_pct: 15 },
      delivery_sla: { target_minutes: 30, warning_minutes: 25 },
      detour: { probability: 0.03, max_detour_factor: 1.3 },
      poi_categories: ['restaurant', 'fast_food_restaurant', 'cafe', 'bakery', 'pizzaria', 'casual_eatery', 'coffee_shop', 'sandwich_shop', 'chicken_restaurant'],
      ghost_trailer: {
        probability: 0.08,
        start_day_min: 0,
        start_day_max: 3,
        duration_days_min: 1,
        duration_days_max: 1,
        ping_interval_min_sec: 180,
        ping_interval_max_sec: 600,
      },
    },
  },
  {
    id: 'hgv-logistics',
    name: 'HGV Logistics',
    description: 'Heavy goods vehicles operating at regional or country scale',
    vehicleType: 'hgv',
    orsProfile: 'driving-hgv',
    regionScale: 'country',
    feeds: ['route-deviation'],
    defaultConfig: {
      mode: 'trucking',
      fleet: { num_vehicles: 30, weekday_operating_rate: 0.85, weekend_operating_rate: 0.35, trips_per_day: { min: 2, max: 4 } },
      shifts: [
        { name: 'Day', start: 5, end: 17, proportion: 0.7 },
        { name: 'Night', start: 18, end: 4, proportion: 0.3 },
      ],
      time: { start_date: '2026-03-01', end_date: '2026-03-07', chunk_size_days: 7 },
      distance_distribution: { short_pct: 0.15, short_max_km: 30, medium_pct: 0.45, medium_max_km: 150, long_pct: 0.40 },
      driver_profiles: {
        COMPLIANT: { proportion: 0.75, detour_probability: 0.08, speeding_probability: 0.05, hos_violation_probability: 0.02, speed_variance: 0.06 },
        MILD: { proportion: 0.18, detour_probability: 0.18, speeding_probability: 0.12, hos_violation_probability: 0.08, speed_variance: 0.10 },
        OUTLIER: { proportion: 0.07, detour_probability: 0.35, speeding_probability: 0.25, hos_violation_probability: 0.15, speed_variance: 0.16 },
      },
      routing: { optimal_route_probability: 0.70, alternative_route_probability: 0.20, detour_probability: 0.10, posted_speeds: { motorway: 80, primary: 60, secondary: 50, residential: 30, default: 55 } },
      telemetry: { ping_interval_moving: { mean_sec: 15, std_sec: 5 }, ping_interval_dwell: { min_sec: 60, max_sec: 180 }, gps_jitter: { typical_m: 8, multipath_probability: 0.02, multipath_max_m: 100 } },
      dwell: { origin: { median_min: 15, sigma: 0.6, max_min: 45 }, destination: { median_min: 20, sigma: 0.7, max_min: 60 }, idle: { median_min: 10, sigma: 0.5, max_min: 30 } },
      breaks: { driving_hours_between_breaks: 4.5, mandatory_break_duration_min: 45, max_daily_driving_hours: 9 },
      detour: { probability: 0.10, max_detour_factor: 1.5 },
      poi_categories: ['warehouse', 'gas_station', 'parking', 'storage_facility', 'b2b_transportation_and_storage_service', 'transportation_location', 'ground_transport_facility_or_service', 'industrial_facility_or_service'],
      ghost_trailer: {
        probability: 0.10,
        start_day_min: 0,
        start_day_max: 1,
        duration_days_min: 5,
        duration_days_max: 7,
        ping_interval_min_sec: 300,
        ping_interval_max_sec: 900,
      },
    },
  },
];

export interface DwellConfig {
  median_min: number;
  sigma: number;
  max_min: number;
  long_wait_probability?: number;
}

export interface ShiftConfig {
  name: string;
  start: number;
  end: number;
  proportion: number;
}

export interface DriverProfileConfig {
  proportion: number;
  detour_probability: number;
  speeding_probability: number;
  hos_violation_probability?: number;
  speed_variance: number;
}

export interface GenerationConfig {
  mode: string;
  vehicleType?: VehicleType;
  region: string;
  regionScale?: RegionScale;
  ors_profile: string;
  bbox: { min_lat: number; max_lat: number; min_lng: number; max_lng: number };
  fleet: {
    num_vehicles: number;
    weekday_operating_rate?: number;
    weekend_operating_rate?: number;
    daily_operating_rate?: number;
    trips_per_day: { min: number; max: number };
  };
  shifts: ShiftConfig[];
  time: { start_date: string; end_date: string; chunk_size_days: number };
  distance_distribution: { short_pct: number; short_max_km: number; medium_pct: number; medium_max_km: number; long_pct: number };
  driver_profiles: Record<string, DriverProfileConfig>;
  routing: {
    optimal_route_probability: number;
    alternative_route_probability: number;
    detour_probability: number;
    posted_speeds: Record<string, number>;
  };
  telemetry: {
    ping_interval_moving: { mean_sec: number; std_sec: number };
    ping_interval_dwell: { min_sec: number; max_sec: number };
    gps_jitter: { typical_m: number; multipath_probability: number; multipath_max_m: number };
  };
  dwell: Record<string, DwellConfig | Record<string, DwellConfig>>;
  breaks?: { driving_hours_between_breaks: number; mandatory_break_duration_min: number; max_daily_driving_hours: number };
  battery?: { range_km: number; drain_per_km: number; recharge_threshold_pct: number };
  delivery_sla?: { target_minutes: number; warning_minutes: number };
  detour?: { probability: number; max_detour_factor: number };
  poi_categories?: string[];
  ghost_trailer?: {
    probability: number;
    start_day_min: number;
    start_day_max: number;
    duration_days_min: number;
    duration_days_max: number;
    ping_interval_min_sec: number;
    ping_interval_max_sec: number;
  };
}

export function resolveVehicleType(config: GenerationConfig): VehicleType {
  if (config.vehicleType) return config.vehicleType;
  if (config.ors_profile === 'cycling-electric') return 'ebike';
  if (config.ors_profile === 'driving-hgv') return 'hgv';
  return 'car';
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function lognormalSample(medianMin: number, sigma: number, maxMin: number, rng: () => number): number {
  const mu = Math.log(medianMin);
  const u1 = rng();
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
  const val = Math.exp(mu + sigma * z);
  return Math.min(Math.max(val, 0.5), maxMin);
}

export function calculateHeading(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const la1 = lat1 * Math.PI / 180;
  const la2 = lat2 * Math.PI / 180;
  const x = Math.sin(dLng) * Math.cos(la2);
  const y = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(x, y) * 180 / Math.PI) + 360) % 360;
}

export function addGpsJitter(lat: number, lng: number, jitterM: number, rng: () => number): [number, number] {
  const angle = rng() * 2 * Math.PI;
  const dist = jitterM * rng() / 111320;
  return [lat + dist * Math.cos(angle), lng + dist * Math.sin(angle) / Math.cos(lat * Math.PI / 180)];
}

export function createRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

export function rngInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function rngFloat(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function uuid(rng: () => number): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += hex[(Math.floor(rng() * 4) + 8)];
    else s += hex[Math.floor(rng() * 16)];
  }
  return s;
}
