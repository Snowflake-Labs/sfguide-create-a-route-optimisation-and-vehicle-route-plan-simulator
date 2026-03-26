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
  region: string;
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
  poi_categories?: string[];
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
