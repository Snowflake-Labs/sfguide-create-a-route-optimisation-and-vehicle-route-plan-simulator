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

export const CITIES: Record<string, CityConfig> = {
  'Los Angeles': { name: 'Los Angeles', latitude: 34.05, longitude: -118.24, zoom: 11 },
  'San Francisco': { name: 'San Francisco', latitude: 37.76, longitude: -122.44, zoom: 12 },
  'San Diego': { name: 'San Diego', latitude: 32.72, longitude: -117.16, zoom: 12 },
  'San Jose': { name: 'San Jose', latitude: 37.34, longitude: -121.89, zoom: 12 },
  'Sacramento': { name: 'Sacramento', latitude: 38.58, longitude: -121.49, zoom: 12 },
  'Fresno': { name: 'Fresno', latitude: 36.74, longitude: -119.77, zoom: 12 },
  'Oakland': { name: 'Oakland', latitude: 37.80, longitude: -122.27, zoom: 12 },
  'Long Beach': { name: 'Long Beach', latitude: 33.77, longitude: -118.19, zoom: 12 },
  'Santa Barbara': { name: 'Santa Barbara', latitude: 34.42, longitude: -119.70, zoom: 13 },
  'Bakersfield': { name: 'Bakersfield', latitude: 35.37, longitude: -119.02, zoom: 12 },
  'Anaheim': { name: 'Anaheim', latitude: 33.84, longitude: -117.91, zoom: 12 },
  'Santa Ana': { name: 'Santa Ana', latitude: 33.75, longitude: -117.87, zoom: 13 },
  'Irvine': { name: 'Irvine', latitude: 33.68, longitude: -117.83, zoom: 12 },
  'Riverside': { name: 'Riverside', latitude: 33.95, longitude: -117.40, zoom: 12 },
  'Stockton': { name: 'Stockton', latitude: 37.96, longitude: -121.29, zoom: 12 },
  'Modesto': { name: 'Modesto', latitude: 37.64, longitude: -120.99, zoom: 12 },
  'Pasadena': { name: 'Pasadena', latitude: 34.15, longitude: -118.14, zoom: 13 },
  'Huntington Beach': { name: 'Huntington Beach', latitude: 33.66, longitude: -117.99, zoom: 13 },
  'Torrance': { name: 'Torrance', latitude: 33.84, longitude: -118.34, zoom: 13 },
  'Berkeley': { name: 'Berkeley', latitude: 37.87, longitude: -122.27, zoom: 13 },
};

export const CALIFORNIA_CENTER: CityConfig = {
  name: 'All Cities',
  latitude: 37.27,
  longitude: -119.27,
  zoom: 6,
};

export const CITY_NAMES = Object.keys(CITIES);

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
