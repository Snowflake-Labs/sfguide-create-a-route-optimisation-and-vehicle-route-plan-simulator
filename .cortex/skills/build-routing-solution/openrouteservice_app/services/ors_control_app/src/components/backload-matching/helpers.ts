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

// sfQuery / SfQueryOpts / asSqlJsonLiteral are owned by src/lib/sfQuery so all
// pages share a single body.error path and a single dollar-quoted JSON inliner.
import {
  sfQuery as sharedSfQuery,
  asSqlJsonLiteral,
  safeText,
  type SfQueryOpts as SharedSfQueryOpts,
} from '../../lib/sfQuery';
export { asSqlJsonLiteral, safeText };
export type SfQueryOpts = SharedSfQueryOpts;

export async function sfQuery(
  sql: string,
  database = BM_DB,
  schema = BM_SCHEMA,
  opts: SfQueryOpts = {},
): Promise<any[]> {
  return sharedSfQuery(sql, database, schema, opts);
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

// Probe per-region ORS health. Returns true only when both:
//   * SHOW SERVICES reports RUNNING with cur >= tgt
//   * ORS_STATUS(region) -> service_ready=true (i.e. graphs are loaded)
// Used by the BackloadMatching solve flow to avoid the documented cold-start
// race where the service flips RUNNING before the graph is loaded, which
// causes the gateway's matrix pre-compute to silently fall back to per-leg
// VROOM (-> hours-long apparent hang). See plan: backload-solve-hang-fix.
export async function isOrsRegionReady(
  region: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ ready: boolean; reason?: string }> {
  if (!region) return { ready: false, reason: 'no region' };
  try {
    const safe = region.replace(/'/g, "''");
    const rows = await sfQuery(
      `SELECT OPENROUTESERVICE_APP.CORE.ORS_STATUS('${safe}') AS S`,
      'OPENROUTESERVICE_APP', 'CORE',
      { signal: opts.signal, throwOnError: true },
    );
    const raw = rows?.[0]?.S;
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const ready = !!(obj && (obj.service_ready === true || obj.service_ready === 'true'));
    return ready ? { ready: true } : { ready: false, reason: obj?.message || obj?.error || 'service not ready' };
  } catch (err: any) {
    return { ready: false, reason: err?.message || 'status probe failed' };
  }
}

// Build a precomputed VROOM matrix from a list of unique [lon,lat] locations
// using the deployed MATRIX TVF. Returns { durations, costs } in seconds /
// meters (rounded), matching the shape VROOM expects in payload.matrices.
// Returns null if the locations < 2 or the MATRIX call yielded nothing.
export async function buildVroomMatrix(
  profile: string,
  locations: [number, number][],
  region: string | null | undefined,
  opts: { signal?: AbortSignal } = {},
): Promise<{ durations: number[][]; costs: number[][] } | null> {
  if (!locations || locations.length < 2) return null;
  const locArrSql = locations
    .map(([lon, lat]) => `ARRAY_CONSTRUCT(${Number(lon)}::FLOAT, ${Number(lat)}::FLOAT)`)
    .join(', ');
  const regionLit = region ? `'${String(region).replace(/'/g, "''")}'` : 'NULL';
  const sql = `SELECT OPENROUTESERVICE_APP.CORE.MATRIX('${profile}', ARRAY_CONSTRUCT(${locArrSql}), ${regionLit}) AS M`;
  const rows = await sfQuery(sql, 'OPENROUTESERVICE_APP', 'CORE', {
    signal: opts.signal,
    throwOnError: true,
  });
  const raw = rows?.[0]?.M;
  if (!raw) return null;
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // ORS surfaces structured failures (e.g. maximum_routes_exceeded) as
  // { error: { code, message } } with no durations/distances. Throw so the
  // caller can surface the reason in matrixNote and fall back to the
  // gateway-side pre-compute path (options.g=true).
  if (obj?.error) {
    const msg = typeof obj.error === 'string'
      ? obj.error
      : (obj.error.message || JSON.stringify(obj.error));
    throw new Error(`MATRIX rejected: ${msg}`);
  }
  const dur = obj?.durations;
  const dist = obj?.distances;
  if (!Array.isArray(dur) || !Array.isArray(dist)) return null;
  const durations = dur.map((row: any[]) =>
    row.map(v => (v == null ? 0 : Math.round(Number(v)))));
  const costs = dist.map((row: any[]) =>
    row.map(v => (v == null ? 0 : Math.round(Number(v)))));
  return { durations, costs };
}

// Per-trailer empty-leg baseline: shortest-path travel time + distance from
// each trailer's current dropoff location to its end point (HOME or shared
// destination). Used to derive per-vehicle VROOM `max_travel_time` and
// `max_distance` so that the "Detour budget" and "Allowed deviation" sliders
// scale linearly with the empty drive home rather than a global envelope.
//
// Sources:
//   'matrix'     - real ORS shortest-path from MATRIX TVF.
//   'haversine'  - great-circle fallback for a single trailer when MATRIX
//                  failed or returned a missing/zero cell. Other trailers in
//                  the same call still get the real ORS baseline.
//   'fixed-open' - open-end mode (`endMode === 'open'`): no end point exists,
//                  so we use a fixed 200 km / (200 / KMH_HGV) h baseline per
//                  trailer. Sliders still bite on top.
export type EmptyLegBaseline = {
  durSec: number;
  distMeters: number;
  source: 'matrix' | 'haversine' | 'fixed-open';
};

const FIXED_OPEN_KM = 200;

function fixedOpenBaseline(): EmptyLegBaseline {
  return {
    durSec:     Math.round((FIXED_OPEN_KM / KMH_HGV) * 3600),
    distMeters: FIXED_OPEN_KM * 1000,
    source:     'fixed-open',
  };
}

function haversineBaseline(
  startLon: number, startLat: number,
  endLon: number,   endLat: number,
): EmptyLegBaseline {
  const meters = haversineKm(startLon, startLat, endLon, endLat) * 1000;
  return {
    durSec:     Math.max(1, Math.round((meters / 1000) / KMH_HGV * 3600)),
    distMeters: Math.max(1, Math.round(meters)),
    source:     'haversine',
  };
}

export async function computeEmptyLegBaselines(
  profile: string,
  trailers: Trailer[],
  trailerEnd: (t: Trailer) => [number, number] | null,
  region: string | null | undefined,
  opts: { signal?: AbortSignal } = {},
): Promise<Map<Trailer, EmptyLegBaseline>> {
  const out = new Map<Trailer, EmptyLegBaseline>();
  if (!trailers.length) return out;

  // Open-end short-circuit: if no trailer has an end point, no MATRIX call.
  const anyEnd = trailers.some(t => trailerEnd(t) !== null);
  if (!anyEnd) {
    for (const t of trailers) out.set(t, fixedOpenBaseline());
    return out;
  }

  // Build deduped [lon,lat] location list. Index by "lon,lat" rounded to
  // 6 decimal places (~10cm) so identical points share an index.
  const key = (lon: number, lat: number) =>
    `${lon.toFixed(6)},${lat.toFixed(6)}`;
  const indexByKey = new Map<string, number>();
  const locations: [number, number][] = [];
  const addLoc = (lon: number, lat: number): number => {
    const k = key(lon, lat);
    let idx = indexByKey.get(k);
    if (idx === undefined) {
      idx = locations.length;
      indexByKey.set(k, idx);
      locations.push([lon, lat]);
    }
    return idx;
  };

  type Spec = { trailer: Trailer; startIdx: number; endIdx: number | null;
                startLon: number; startLat: number;
                endLon: number | null; endLat: number | null; };
  const specs: Spec[] = trailers.map(t => {
    const startLon = Number(t.DROPOFF_LON);
    const startLat = Number(t.DROPOFF_LAT);
    const startIdx = addLoc(startLon, startLat);
    const endPt = trailerEnd(t);
    if (!endPt) {
      return { trailer: t, startIdx, endIdx: null,
               startLon, startLat, endLon: null, endLat: null };
    }
    const endLon = Number(endPt[0]);
    const endLat = Number(endPt[1]);
    const endIdx = addLoc(endLon, endLat);
    return { trailer: t, startIdx, endIdx,
             startLon, startLat, endLon, endLat };
  });

  let matrix: { durations: number[][]; costs: number[][] } | null = null;
  try {
    matrix = await buildVroomMatrix(profile, locations, region, opts);
  } catch {
    matrix = null;
  }

  for (const spec of specs) {
    if (spec.endIdx === null || spec.endLon === null || spec.endLat === null) {
      // Trailer has no end point even though some others do - treat as open.
      out.set(spec.trailer, fixedOpenBaseline());
      continue;
    }
    if (!matrix) {
      out.set(spec.trailer,
        haversineBaseline(spec.startLon, spec.startLat, spec.endLon, spec.endLat));
      continue;
    }
    const durRow = matrix.durations[spec.startIdx];
    const costRow = matrix.costs[spec.startIdx];
    const dur  = durRow ? Number(durRow[spec.endIdx]) : NaN;
    const dist = costRow ? Number(costRow[spec.endIdx]) : NaN;
    if (Number.isFinite(dur) && Number.isFinite(dist) && dur > 0 && dist > 0) {
      out.set(spec.trailer, {
        durSec:     Math.round(dur),
        distMeters: Math.round(dist),
        source:     'matrix',
      });
    } else {
      out.set(spec.trailer,
        haversineBaseline(spec.startLon, spec.startLat, spec.endLon, spec.endLat));
    }
  }

  return out;
}
