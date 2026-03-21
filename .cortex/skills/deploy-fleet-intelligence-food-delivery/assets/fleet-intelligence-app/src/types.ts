export interface CityConfig {
  name: string;
  latitude: number;
  longitude: number;
  zoom: number;
}

export interface RouteData {
  order_id: string;
  courier_id: string;
  restaurant_name: string;
  customer_address: string;
  coordinates: [number, number][];
  distance_km: number;
  eta_mins: number;
  order_status: string;
  city: string;
  color: [number, number, number, number];
  delay_reason: string;
  delay_minutes: number;
  flood_affected: boolean;
}

export interface CourierLocation {
  courier_id: string;
  lat: number;
  lon: number;
  state: string;
  timestamp: string;
}

export interface CityStats {
  city: string;
  orders: number;
  couriers: number;
  restaurants: number;
  total_km: number;
  avg_mins: number;
}

export interface FleetStats {
  total_orders: number;
  total_couriers: number;
  total_restaurants: number;
  total_km: number;
  avg_delivery_mins: number;
  cities: CityStats[];
}

export interface Working {
  type: 'status' | 'thinking' | 'tool_use' | 'tool_result' | 'analyst_delta';
  message?: string;
  text?: string;
  tool_name?: string;
  tool_type?: string;
  status?: string;
  sql?: string;
  sql_explanation?: string;
  has_results?: boolean;
  row_count?: number;
  results?: Record<string, any>[];
}

export interface FileAttachment {
  name: string;
  type: 'image' | 'pdf';
  mimeType: string;
  base64?: string;
  extractedText?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  workings?: Working[];
  attachments?: FileAttachment[];
}

export type MapMode = 'routes' | 'heatmap' | 'matrix';

export type StatusFilter = 'all' | 'active' | 'in_transit' | 'picked_up';

export interface MapFilter {
  type: 'all' | 'status' | 'restaurant' | 'courier' | 'cuisine' | 'vehicle' | 'shift';
  value: string;
  label: string;
}

export const DEFAULT_MAP_FILTER: MapFilter = { type: 'all', value: '', label: '' };

export function parseAgentFilter(filterType: string, filterValue: string): MapFilter {
  const t = filterType.toLowerCase();
  switch (t) {
    case 'restaurant':
      return { type: 'restaurant', value: filterValue, label: `Restaurant: ${filterValue}` };
    case 'courier':
      return { type: 'courier', value: filterValue, label: `Courier: ${filterValue}` };
    case 'cuisine':
      return { type: 'cuisine', value: filterValue, label: `Cuisine: ${filterValue}` };
    case 'vehicle':
      return { type: 'vehicle', value: filterValue, label: `Vehicle: ${filterValue}` };
    case 'shift':
      return { type: 'shift', value: filterValue, label: `Shift: ${filterValue}` };
    case 'status':
      return { type: 'status', value: filterValue, label: filterValue === 'active' ? 'Active Only' : filterValue.replace(/_/g, ' ') };
    case 'all':
    case 'reset':
      return DEFAULT_MAP_FILTER;
    default:
      return DEFAULT_MAP_FILTER;
  }
}

export interface ActiveStats {
  active: number;
  delivered: number;
  in_transit: number;
  picked_up: number;
  cities: { city: string; active: number; delivered: number; in_transit: number; picked_up: number }[];
}

export interface HexMatrixData {
  hex_id: string;
  delivery_count: number;
  avg_distance_km: number;
  avg_duration_mins: number;
  avg_speed_kmh: number;
  unique_couriers: number;
  unique_restaurants: number;
  lat: number;
  lon: number;
}

export interface TravelTimeHexData {
  hex_id: string;
  lat: number;
  lon: number;
  dest_count: number;
  avg_travel_time_secs: number;
  min_travel_time_secs: number;
  max_travel_time_secs: number;
  avg_distance_meters: number;
  max_distance_meters: number;
}

export type MatrixResolution = 7 | 8 | 9 | 10;

export interface VehicleTypeOption {
  label: string;
  value: string;
  description: string;
  icon: string;
  disabled?: boolean;
}

export const VEHICLE_TYPES: VehicleTypeOption[] = [
  { label: 'E-Bike', value: 'cycling-electric', description: 'Electric bicycle (default)', icon: '⚡', disabled: false },
  { label: 'Car', value: 'driving-car', description: 'Standard driving profile', icon: '🚗', disabled: true },
  { label: 'Bicycle', value: 'cycling-regular', description: 'Regular cycling', icon: '🚲', disabled: true },
  { label: 'Road Bike', value: 'cycling-road', description: 'Road cycling', icon: '🚴', disabled: true },
  { label: 'HGV', value: 'driving-hgv', description: 'Heavy goods vehicle', icon: '🚛', disabled: true },
  { label: 'Walking', value: 'foot-walking', description: 'Walking profile', icon: '🚶', disabled: true },
];

export const DEFAULT_VEHICLE_TYPE = 'cycling-electric';

export interface MatrixExistingDetail {
  table: string;
  region: string;
  vehicle_type: string;
  count: number;
}

export interface ReachabilityHexData {
  hex_id: string;
  lat: number;
  lon: number;
  travel_time_secs: number;
  distance_meters: number;
}

export interface MatrixSelection {
  origin_hex: string;
  origin_lat: number;
  origin_lon: number;
  resolution: MatrixResolution;
  destinations: ReachabilityHexData[];
  max_travel_time_secs: number;
  max_distance_meters: number;
}

export interface CatchmentRestaurant {
  name: string;
  cuisine: string;
  city: string;
  lon: number;
  lat: number;
  drive_mins: number;
  orders: number;
  active: number;
}

export interface CatchmentCustomer {
  lon: number;
  lat: number;
  status: string;
  restaurant: string;
  drive_mins: number;
}

export interface CatchmentData {
  origin: string;
  resolution: number;
  max_minutes: number;
  total_deliveries: number;
  restaurants: CatchmentRestaurant[];
  customers: CatchmentCustomer[];
}

export interface AnimatedRoute {
  coordinates: [number, number][];
  timestamps: number[];
  distance_meters: number;
  duration_seconds: number;
  start: [number, number];
  end: [number, number];
  restaurant?: CatchmentRestaurant;
}

export const CITIES: Record<string, CityConfig> = {
  'London': { name: 'London', latitude: 51.51, longitude: -0.13, zoom: 11 },
  'Paris': { name: 'Paris', latitude: 48.86, longitude: 2.35, zoom: 12 },
  'Berlin': { name: 'Berlin', latitude: 52.52, longitude: 13.40, zoom: 11 },
  'New York': { name: 'New York', latitude: 40.71, longitude: -74.01, zoom: 11 },
  'Chicago': { name: 'Chicago', latitude: 41.88, longitude: -87.63, zoom: 11 },
  'Los Angeles': { name: 'Los Angeles', latitude: 34.05, longitude: -118.24, zoom: 11 },
  'San Francisco': { name: 'San Francisco', latitude: 37.76, longitude: -122.44, zoom: 12 },
  'San Jose': { name: 'San Jose', latitude: 37.34, longitude: -121.89, zoom: 12 },
  'Sacramento': { name: 'Sacramento', latitude: 38.58, longitude: -121.49, zoom: 12 },
  'Santa Barbara': { name: 'Santa Barbara', latitude: 34.42, longitude: -119.70, zoom: 13 },
  'Stockton': { name: 'Stockton', latitude: 37.96, longitude: -121.29, zoom: 12 },
};

export const US_CENTER: CityConfig = {
  name: 'All Cities',
  latitude: 39.83,
  longitude: -98.58,
  zoom: 4,
};

export const CITY_NAMES = Object.keys(CITIES);

export interface MatrixRegion {
  id: string;
  name: string;
  hex_count_res9: number;
  hex_count_res8: number;
  hex_count_res7: number;
  pairs_res9: number;
  pairs_res8: number;
  pairs_res7: number;
  total_pairs: number;
  built_res9: number;
  built_res8: number;
  built_res7: number;
}

export interface MatrixEstimate {
  region: string;
  resolutions: {
    res: number;
    label: string;
    hexagons: number;
    cutoff_miles: number;
    sparse_pairs: number;
    est_time_minutes: number;
    est_credits: number;
  }[];
  total_pairs: number;
  total_time_minutes: number;
  total_credits: number;
  api_comparison: {
    provider: string;
    cost_per_call: number;
    calls_needed: number;
    total_cost: number;
  }[];
  snowflake_cost: number;
}

export interface MatrixBuildStatus {
  region: string;
  resolution: number;
  vehicle_type: string;
  status: 'idle' | 'building' | 'complete' | 'error';
  stage: string;
  total_origins: number;
  processed_origins: number;
  total_pairs: number;
  built_pairs: number;
  percent_complete: number;
  elapsed_seconds: number;
  est_remaining_seconds: number;
  hexagons: number;
  work_queue: number;
  raw_ingested: number;
  flattened: number;
  error?: string;
}

export function courierColor(courierId: string): [number, number, number, number] {
  let n: number;
  const parts = courierId.split('-');
  const last = parts[parts.length - 1];
  n = parseInt(last, 10);
  if (isNaN(n)) n = Math.abs(courierId.split('').reduce((a, c) => a + c.charCodeAt(0), 0));

  const hue = (n * 137.508) % 360;
  const s = 0.7;
  const l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - c / 2;

  let r: number, g: number, b: number;
  if (hue < 60) { r = c; g = x; b = 0; }
  else if (hue < 120) { r = x; g = c; b = 0; }
  else if (hue < 180) { r = 0; g = c; b = x; }
  else if (hue < 240) { r = 0; g = x; b = c; }
  else if (hue < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), 220];
}
