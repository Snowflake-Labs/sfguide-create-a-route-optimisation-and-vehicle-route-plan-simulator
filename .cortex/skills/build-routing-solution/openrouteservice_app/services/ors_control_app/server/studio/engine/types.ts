// Shared types for the studio telemetry generation engine. All exported
// interfaces / types previously inlined in studio/engine.ts.

export interface TelemetryPoint {
  telemetry_id: string;
  region: string;
  vehicle_type: string;
  vehicle_id: string;
  trip_id: string | null;
  ts: Date;
  latitude: number;
  longitude: number;
  speed_kmh: number;
  heading_deg: number;
  posted_speed_kmh: number;
  status: string;
  is_speeding: boolean;
  is_hos_violation: boolean;
  is_detour: boolean;
  gps_accuracy_m: number;
  location_id: string | null;
  location_type: string | null;
  ors_profile: string;
  battery_pct: number | null;
  odometer_km: number | null;
  point_index: number | null;
}

export interface TripRecord {
  trip_id: string;
  vehicle_id: string;
  driver_id: string;
  vehicle_type: string;
  region: string;
  origin_poi_id: string;
  destination_poi_id: string;
  origin_lat: number;
  origin_lon: number;
  destination_lat: number;
  destination_lon: number;
  route_coordinates: [number, number][];
  distance_km: number;
  duration_minutes: number;
  planned_route_coordinates: [number, number][] | null;
  planned_distance_km: number | null;
  is_detour: boolean;
  detour_distance_km: number | null;
  trip_start: Date;
  trip_end: Date;
  status: string;
  ors_profile: string;
}

export type GenerationEvent =
  | { type: 'telemetry'; points: TelemetryPoint[] }
  | { type: 'trip'; record: TripRecord }
  | { type: 'stopped'; reason: string; completedDays: number; totalDays: number; routeSuccesses: number; routeFailures: number };

export interface POI {
  location_id: string;
  name: string;
  location_type: string;
  lat: number;
  lng: number;
  category: string;
}

export interface RouteGeometry {
  coordinates: [number, number][];
  distance_m: number;
  duration_sec: number;
}

export interface FleetMember {
  vehicle_id: string;
  driver_id: string;
  home_poi: POI;
  shift_start: number;
  shift_end: number;
  profile_type: string;
  detour_prob: number;
  speeding_prob: number;
  hos_violation_prob: number;
  speed_variance: number;
  base_speed_kmh: number;
  vehicle_type: string;
  battery_pct: number;
  ghost_start_day?: number;
  ghost_end_day?: number;
}

export interface GenerationProgress {
  day: number;
  totalDays: number;
  vehicleId?: string;
  pointsToday: number;
  totalPoints: number;
  totalTrips: number;
  routeSuccesses: number;
  routeFailures: number;
  unroutableSkips?: number;
  unroutablePois?: number;
  status: string;
}

export type RouteFetchResult = RouteGeometry | null | 'UNROUTABLE';

export interface FreightOffer {
  offer_id: string;
  source: string;
  product: string;
  pickup_poi_id: string;
  pickup_lat: number;
  pickup_lon: number;
  dropoff_poi_id: string;
  dropoff_lat: number;
  dropoff_lon: number;
  weight_kg: number;
  price_usd: number;
  hazmat: boolean;
  pickup_from_offset_min: number;
  pickup_to_offset_min: number;
  listing_text: string;
}

export type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;
