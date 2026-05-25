// Constants, types, and pure helpers for BackloadMatching.

export const BM_DB = 'FLEET_INTELLIGENCE';
export const BM_SCHEMA = 'BACKLOAD_MATCHING';
export const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

// Default freight economics (€/loaded-km is the standard pricing unit on
// European freight exchanges — Timocom, WTransnet, Teleroute all quote rates
// per loaded km). Internal volumes inherit the same model.
export const EUR_PER_LOADED_KM = 1.20;
export const EUR_PER_EMPTY_KM = 1.20; // legacy alias kept for older code paths
export const KMH_HGV = 60;            // assumed avg HGV speed for time-budget math
export const COST_SCALE = 100;        // €→VROOM int units (VROOM costs are ints)

export const ROUTE_COLORS: [number, number, number][] = [
  [41, 181, 232], [34, 197, 94], [245, 158, 11], [239, 68, 68],
  [128, 0, 255], [255, 105, 180], [0, 191, 255], [50, 205, 50],
  [255, 165, 0], [220, 38, 38], [99, 102, 241], [16, 185, 129],
];

export interface Trailer {
  TRAILER_ID: string; OPERATING_COUNTRY: string; HOME_DEPOT: string;
  HOME_LON: number; HOME_LAT: number; CURRENT_LOAD: string;
  DROPOFF_CITY: string; DROPOFF_LON: number; DROPOFF_LAT: number;
  ETA_TS: string; ETA_MIN: number; STATUS: string;
  HAZMAT_CERT: boolean; MAX_PAYLOAD_KG: number;
  // Card C: multi-dim capacity (synthetic when not in source)
  MAX_PALLETS?: number; MAX_VOLUME_M3?: number;
}

export interface Volume {
  ID: string; PICKUP_CITY: string; PICKUP_LON: number; PICKUP_LAT: number;
  DROPOFF_CITY: string; DROPOFF_LON: number; DROPOFF_LAT: number;
  PICKUP_FROM_TS: string; PICKUP_TO_TS: string;
  WEIGHT_KG: number; PRODUCT: string; HAZMAT: boolean;
  // Card C: optional pallets / m3 columns; we synthesize defaults if missing.
  PALLETS?: number; VOLUME_M3?: number;
}

export interface Offer extends Volume {
  OFFER_ID: string; SOURCE: string; PRICE_EUR: number;
  PICKUP_COUNTRY: string; DROPOFF_COUNTRY: string;
  LISTING_TEXT: string;
}

export interface Stop {
  kind: 'start' | 'pickup' | 'dropoff' | 'end' | 'break';
  label: string;
  city?: string;
  lon: number;
  lat: number;
  jobId?: number;
  offerId?: string;
  source?: string;
  product?: string;
  weightKg?: number;
  // Card J: wait time at this step (seconds) returned by VROOM.
  waitSec?: number;
  // Card A: break service time (seconds) when kind === 'break'.
  serviceSec?: number;
}

export interface AvoidZone {
  ZONE_ID: string;
  NAME: string;
  CATEGORY: string;
  POLYGON_GEOJSON: any;
}

export interface Assignment {
  ASSIGNMENT_ID: string;
  TRAILER_ID: string; OFFER_ID: string; SOURCE: string;
  PICKUP_LON: number; PICKUP_LAT: number;
  DROPOFF_LON: number; DROPOFF_LAT: number;
  EMPTY_KM: number; LOADED_KM: number; SCORE: number;
  DETOUR_KM?: number; SAVED_KM?: number;
  PRODUCT: string; PICKUP_CITY: string; PROPOSAL_DROPOFF_CITY: string;
  HOME_LON: number; HOME_LAT: number;
  TRAILER_DROPOFF_LON: number; TRAILER_DROPOFF_LAT: number;
  ROUTE_GEOJSON?: any;
  EMPTY_GEOJSON?: any;
  STOPS: Stop[];
  // Post-solve economics (Card: cost / net-benefit).
  TOUR_KM?: number;
  TOUR_HRS?: number;
  WAIT_SEC?: number;
  N_DELIVERIES?: number;
  COST_EUR?: number;
  REVENUE_EUR?: number;
  NET_BENEFIT_EUR?: number;
}

export interface SvcStatus { name: string; status: string; cur: number; tgt: number; }

export async function sfQuery(sql: string, database = BM_DB, schema = BM_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, database, schema }) });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    console.error('[BM/sfQuery] Error:', err, 'SQL:', sql.slice(0, 300));
    return [];
  }
}

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371, toRad = (x: number) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function profileForVehicleType(vt: string): string {
  switch ((vt || '').toLowerCase()) {
    case 'ebike': case 'bicycle': case 'bike': return 'cycling-electric';
    case 'car':                                return 'driving-car';
    case 'hgv': case 'truck':                  return 'driving-hgv';
    default:                                   return 'driving-hgv';
  }
}

// Synthesize multi-dim capacity for vehicles/shipments when source data only
// has kg. Heuristic: 1 pallet ≈ 750 kg, 1 m³ ≈ 250 kg (typical mixed freight).
export function synthPallets(kg: number): number { return Math.max(1, Math.round(kg / 750)); }
export function synthVolumeM3(kg: number): number { return Math.max(1, Math.round(kg / 250)); }
