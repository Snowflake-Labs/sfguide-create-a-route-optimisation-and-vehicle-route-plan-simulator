// Constants, types, and pure helpers for the Backload Matching view.
//
// Neutral (industry-agnostic) and USD-denominated. Reads go through the SA
// app's SELECT-only /api/query proxy; the live routing seam is called through
// ROUTING_PLATFORM.CONTRACT (matrix) and OPENROUTESERVICE_APP.CORE.DIRECTIONS
// (empty-leg polyline) at interaction time - never precomputed into tables.

export const BM = 'FLEET_APP.BACKLOAD_MATCHING';

// Default freight economics. USD per loaded km is the pricing unit; internal
// volumes inherit the same model, external offers carry their real PRICE_USD.
export const USD_PER_LOADED_KM = 1.3;
export const KMH_DEFAULT = 60;      // avg speed fallback for time-budget math
export const COST_SCALE = 100;      // USD -> VROOM integer cost units

// Route color ramp (RGB). Index-cycled across assignments so the list chip,
// map path, and stop markers all agree per assignment.
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
  MAX_PALLETS?: number; MAX_VOLUME_M3?: number;
}

export interface Volume {
  ID: string; PICKUP_CITY: string; PICKUP_LON: number; PICKUP_LAT: number;
  DROPOFF_CITY: string; DROPOFF_LON: number; DROPOFF_LAT: number;
  PICKUP_FROM_TS: string; PICKUP_TO_TS: string;
  WEIGHT_KG: number; PRODUCT: string; HAZMAT: boolean;
  PALLETS?: number; VOLUME_M3?: number;
}

export interface Offer extends Volume {
  OFFER_ID: string; SOURCE: string; PRICE_USD: number;
  PICKUP_COUNTRY: string; DROPOFF_COUNTRY: string; LISTING_TEXT: string;
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
  waitSec?: number;    // VROOM step.waiting_time
  serviceSec?: number; // break service time when kind === 'break'
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
  ROUTE_GEOJSON?: unknown;
  EMPTY_GEOJSON?: unknown;
  STOPS: Stop[];
  TOUR_KM?: number;
  TOUR_HRS?: number;
  WAIT_SEC?: number;
  N_DELIVERIES?: number;
  COST_USD?: number;
  REVENUE_USD?: number;
  NET_BENEFIT_USD?: number;
}

export interface SvcStatus { name: string; status: string; cur: number; tgt: number; }

// Per-vehicle-class profile loaded from FLEET_APP.BACKLOAD_MATCHING.VW_VEHICLE_CLASS.
export type VehicleClass = {
  VEHICLE_TYPE: string;
  ORS_PROFILE: string;
  PAYLOAD_KG_TYP: number;
  PAYLOAD_KG_MAX: number;
  SHIPMENT_KG_MIN: number;
  SHIPMENT_KG_MAX: number;
  AVG_SPEED_KMH: number;
  COST_PER_KM: number;
  COST_PER_HR: number;
  HOME_RANGE_KM: number;
  LABEL_NOUN: string;
};

// SELECT-only read through the SA app query proxy. /api/query lowercases column
// keys; we re-upper them so uppercase field access (t.DROPOFF_LON) resolves.
export async function sfRead(sql: string, opts: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>[]> {
  const res = await fetch('/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }), signal: opts.signal,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  const rows = (body.rows as Record<string, unknown>[]) || [];
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(r)) o[k.toUpperCase()] = r[k];
    return o;
  });
}

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371, toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Synthesize multi-dim capacity when source data only has kg.
// Heuristic: 1 pallet ~ 750 kg, 1 m3 ~ 250 kg (typical mixed freight).
export function synthPallets(kg: number): number { return Math.max(1, Math.round(kg / 750)); }
export function synthVolumeM3(kg: number): number { return Math.max(1, Math.round(kg / 250)); }

// Robust single-quoted SQL string-literal escaping. Snowflake honors backslash
// escape sequences inside string constants, so doubling single quotes alone is
// not enough (a trailing/embedded backslash can still break out of the literal).
// Escape backslashes first, then double single quotes. Reads here go through the
// SELECT-only /api/query proxy, so this is defense in depth on a read-only path.
export function sqlLiteral(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

export async function fetchVehicleClass(vt: string): Promise<VehicleClass | null> {
  if (!vt) return null;
  const safe = sqlLiteral(vt);
  const rows = await sfRead(`SELECT * FROM ${BM}.VW_VEHICLE_CLASS WHERE VEHICLE_TYPE = '${safe}' LIMIT 1`);
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    VEHICLE_TYPE: String(r.VEHICLE_TYPE),
    ORS_PROFILE: String(r.ORS_PROFILE),
    PAYLOAD_KG_TYP: Number(r.PAYLOAD_KG_TYP),
    PAYLOAD_KG_MAX: Number(r.PAYLOAD_KG_MAX) || Number(r.PAYLOAD_KG_TYP),
    SHIPMENT_KG_MIN: Number(r.SHIPMENT_KG_MIN),
    SHIPMENT_KG_MAX: Number(r.SHIPMENT_KG_MAX),
    AVG_SPEED_KMH: Number(r.AVG_SPEED_KMH) || KMH_DEFAULT,
    COST_PER_KM: Number(r.COST_PER_KM),
    COST_PER_HR: Number(r.COST_PER_HR),
    HOME_RANGE_KM: Number(r.HOME_RANGE_KM),
    LABEL_NOUN: String(r.LABEL_NOUN || 'vehicle'),
  };
}

// Build a precomputed VROOM matrix from unique [lon,lat] locations via the
// neutral routing seam ROUTING_PLATFORM.CONTRACT.MATRIX. Returns
// { durations(sec), costs(meters) } or null. Throws on a structured ORS error
// so the caller can fall back to gateway-side precompute / haversine.
export async function buildVroomMatrix(
  profile: string,
  locations: [number, number][],
  region: string | null | undefined,
  opts: { signal?: AbortSignal } = {},
): Promise<{ durations: number[][]; costs: number[][] } | null> {
  if (!locations || locations.length < 2) return null;
  const prof = profile.replace(/[^a-z0-9-]/gi, '');
  const locsJson = JSON.stringify(locations.map(([lon, lat]) => [Number(lon), Number(lat)]));
  const regionLit = region ? `'${sqlLiteral(String(region))}'` : 'NULL';
  const sql = `SELECT ROUTING_PLATFORM.CONTRACT.MATRIX('${prof}', PARSE_JSON('${locsJson}')::VARIANT, ${regionLit}, NULL) AS M`;
  const rows = await sfRead(sql, opts);
  const raw = (rows[0] as { M?: unknown } | undefined)?.M;
  if (raw == null) return null;
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (obj?.error) {
    const msg = typeof obj.error === 'string' ? obj.error : (obj.error.message || JSON.stringify(obj.error));
    throw new Error(`MATRIX rejected: ${msg}`);
  }
  const dur = obj?.durations;
  const dist = obj?.distances;
  if (!Array.isArray(dur) || !Array.isArray(dist)) return null;
  const durations = dur.map((row: unknown[]) => row.map((v) => (v == null ? 0 : Math.round(Number(v)))));
  const costs = dist.map((row: unknown[]) => row.map((v) => (v == null ? 0 : Math.round(Number(v)))));
  return { durations, costs };
}

// Per-trailer empty-leg baseline: shortest-path travel time + distance from
// each trailer's current dropoff to its end point (home / shared dest). Used to
// derive per-vehicle VROOM max_travel_time / max_distance so the "Detour budget"
// and "Allowed deviation" sliders scale with the empty drive home rather than a
// global envelope. Sources: matrix (real ORS), haversine (fallback), fixed-open
// (open-end mode, fixed baseline).
export type EmptyLegBaseline = {
  durSec: number;
  distMeters: number;
  source: 'matrix' | 'haversine' | 'fixed-open';
};

const FIXED_OPEN_KM = 200;

function fixedOpenBaseline(kmh = KMH_DEFAULT, homeRangeKm = FIXED_OPEN_KM): EmptyLegBaseline {
  const km = homeRangeKm > 0 ? homeRangeKm : FIXED_OPEN_KM;
  const speed = kmh > 0 ? kmh : KMH_DEFAULT;
  return { durSec: Math.round((km / speed) * 3600), distMeters: km * 1000, source: 'fixed-open' };
}

function haversineBaseline(startLon: number, startLat: number, endLon: number, endLat: number, kmh = KMH_DEFAULT): EmptyLegBaseline {
  const meters = haversineKm(startLon, startLat, endLon, endLat) * 1000;
  const speed = kmh > 0 ? kmh : KMH_DEFAULT;
  return {
    durSec: Math.max(1, Math.round((meters / 1000) / speed * 3600)),
    distMeters: Math.max(1, Math.round(meters)),
    source: 'haversine',
  };
}

export async function computeEmptyLegBaselines(
  profile: string,
  trailers: Trailer[],
  trailerEnd: (t: Trailer) => [number, number] | null,
  region: string | null | undefined,
  opts: { signal?: AbortSignal; kmh?: number; homeRangeKm?: number } = {},
): Promise<Map<Trailer, EmptyLegBaseline>> {
  const out = new Map<Trailer, EmptyLegBaseline>();
  if (!trailers.length) return out;
  const kmh = opts.kmh ?? KMH_DEFAULT;
  const homeRangeKm = opts.homeRangeKm ?? FIXED_OPEN_KM;

  const anyEnd = trailers.some((t) => trailerEnd(t) !== null);
  if (!anyEnd) {
    for (const t of trailers) out.set(t, fixedOpenBaseline(kmh, homeRangeKm));
    return out;
  }

  const key = (lon: number, lat: number) => `${lon.toFixed(6)},${lat.toFixed(6)}`;
  const indexByKey = new Map<string, number>();
  const locations: [number, number][] = [];
  const addLoc = (lon: number, lat: number): number => {
    const k = key(lon, lat);
    let idx = indexByKey.get(k);
    if (idx === undefined) { idx = locations.length; indexByKey.set(k, idx); locations.push([lon, lat]); }
    return idx;
  };

  type Spec = {
    trailer: Trailer; startIdx: number; endIdx: number | null;
    startLon: number; startLat: number; endLon: number | null; endLat: number | null;
  };
  const specs: Spec[] = trailers.map((t) => {
    const startLon = Number(t.DROPOFF_LON), startLat = Number(t.DROPOFF_LAT);
    const startIdx = addLoc(startLon, startLat);
    const endPt = trailerEnd(t);
    if (!endPt) return { trailer: t, startIdx, endIdx: null, startLon, startLat, endLon: null, endLat: null };
    const endLon = Number(endPt[0]), endLat = Number(endPt[1]);
    const endIdx = addLoc(endLon, endLat);
    return { trailer: t, startIdx, endIdx, startLon, startLat, endLon, endLat };
  });

  let matrix: { durations: number[][]; costs: number[][] } | null = null;
  try { matrix = await buildVroomMatrix(profile, locations, region, opts); } catch { matrix = null; }

  for (const spec of specs) {
    if (spec.endIdx === null || spec.endLon === null || spec.endLat === null) {
      out.set(spec.trailer, fixedOpenBaseline(kmh, homeRangeKm));
      continue;
    }
    if (!matrix) {
      out.set(spec.trailer, haversineBaseline(spec.startLon, spec.startLat, spec.endLon, spec.endLat, kmh));
      continue;
    }
    const durRow = matrix.durations[spec.startIdx];
    const costRow = matrix.costs[spec.startIdx];
    const dur = durRow ? Number(durRow[spec.endIdx]) : NaN;
    const dist = costRow ? Number(costRow[spec.endIdx]) : NaN;
    if (Number.isFinite(dur) && Number.isFinite(dist) && dur > 0 && dist > 0) {
      out.set(spec.trailer, { durSec: Math.round(dur), distMeters: Math.round(dist), source: 'matrix' });
    } else {
      out.set(spec.trailer, haversineBaseline(spec.startLon, spec.startLat, spec.endLon, spec.endLat, kmh));
    }
  }
  return out;
}

// Solver snap radius (meters). The optimization/VROOM path enforces the region
// maximum_snapping_radius (1000m for standard regions). MATRIX snaps more
// leniently, so a point can return a finite duration yet still abort the whole
// solve with VROOM code 3 ("could not find routable point within a radius of
// 1000.0 meters"). Any point whose snapped_distance exceeds this must be dropped
// before the solve. Continental-preset regions use 5000m; pass snapRadiusM to
// override when the active region uses a larger radius.
export const SOLVER_SNAP_RADIUS_M = 1000;

// Stable coordinate key for de-duping / matching dropped points. VROOM echoes
// the failing coordinate rounded to ~6dp; matching to 4dp (~11m) is safe and
// mirrors the retry loop's coordNear epsilon (1e-4).
export function coordKey(lon: number, lat: number): string {
  return `${Number(lon).toFixed(4)},${Number(lat).toFixed(4)}`;
}

// Bulk routability pre-filter. A single unroutable location aborts the ENTIRE
// VROOM solve (code 3) and VROOM names only ONE offending coordinate per solve,
// so a dataset with N unroutable points needs N sequential failed solves to
// clear via the drop-and-retry loop. When a large region (e.g. Europe) seeds
// freight across the whole bbox, N easily exceeds the retry cap and the solve
// never converges. This helper removes the bulk in a handful of MATRIX calls
// BEFORE the first solve.
//
// Given unique [lon,lat] points and a known-routable central anchor, it probes
// each point BOTH directions via MATRIX_TABULAR:
//   inbound  (anchor -> point): durations[0][j] + destinations[j].snapped_distance
//   outbound (point -> anchor): durations[j][0]
// A point is unroutable when its snapped_distance is null / greater than the
// solver radius (off-road / mid-ocean), OR when either direction has a null
// duration (point on a disconnected road component - e.g. a coastal stub
// reachable inbound but dead outbound; see the Friesland case). Returns the set
// of coordKey()s to exclude. Fails OPEN: any probe/parse error keeps the batch
// so a transient MATRIX hiccup never blocks a valid solve.
export async function findUnroutablePoints(
  profile: string,
  points: [number, number][],
  anchor: [number, number],
  region: string | null | undefined,
  opts: { signal?: AbortSignal; snapRadiusM?: number; batchSize?: number } = {},
): Promise<Set<string>> {
  const bad = new Set<string>();
  if (!points.length) return bad;
  const prof = profile.replace(/[^a-z0-9-]/gi, '');
  const regionLit = region ? `'${sqlLiteral(String(region))}'` : 'NULL';
  const snapMax = opts.snapRadiusM ?? SOLVER_SNAP_RADIUS_M;
  // Keep each MATRIX call comfortably under the gateway location guardrail.
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 150, 150));
  const anchorArr = `ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(${Number(anchor[0])}, ${Number(anchor[1])}))`;
  const fmtArr = (pts: [number, number][]) =>
    'ARRAY_CONSTRUCT(' + pts.map(([lo, la]) => `ARRAY_CONSTRUCT(${Number(lo)}, ${Number(la)})`).join(',') + ')';
  const parse = (v: unknown): unknown => {
    if (v == null) return null;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  };

  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    const destArr = fmtArr(batch);
    // Two function calls (inbound + outbound) hoisted into a subquery so each
    // MATRIX_TABULAR is evaluated once; extract durations/destinations from the
    // shared inbound result.
    const sql =
      `SELECT TO_VARCHAR(MI:durations) AS DUR_IN, TO_VARCHAR(MI:destinations) AS DESTS, ` +
      `TO_VARCHAR(MO:durations) AS DUR_OUT FROM (SELECT ` +
      `OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR('${prof}', ${anchorArr}, ${destArr}, ${regionLit}) AS MI, ` +
      `OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR('${prof}', ${destArr}, ${anchorArr}, ${regionLit}) AS MO)`;
    try {
      const rows = await sfRead(sql, { signal: opts.signal });
      const r = rows[0] as { DUR_IN?: unknown; DESTS?: unknown; DUR_OUT?: unknown } | undefined;
      const durIn = parse(r?.DUR_IN) as number[][] | null;
      const dests = parse(r?.DESTS) as Array<{ snapped_distance?: number } | null> | null;
      const durOut = parse(r?.DUR_OUT) as number[][] | null;
      // If the batch response is unusable, keep every point (fail open).
      if (!Array.isArray(durIn) || !Array.isArray(durIn[0])) continue;
      for (let j = 0; j < batch.length; j++) {
        const inD = durIn[0]?.[j];
        const outD = Array.isArray(durOut) ? durOut[j]?.[0] : undefined;
        const snap = Array.isArray(dests) ? dests[j]?.snapped_distance : undefined;
        const nullIn = inD == null || !Number.isFinite(Number(inD));
        const nullOut = outD == null || !Number.isFinite(Number(outD));
        const farSnap = snap == null || !Number.isFinite(Number(snap)) || Number(snap) > snapMax;
        if (nullIn || nullOut || farSnap) bad.add(coordKey(batch[j][0], batch[j][1]));
      }
    } catch {
      // Transient MATRIX error: keep this batch's points, let the solve-time
      // retry loop catch any real unroutable point.
    }
  }
  return bad;
}

// Empty-leg road polyline (trailer dropoff -> first pickup) via ORS DIRECTIONS.
// Returns a GeoJSON geometry object or null. Numeric-only waypoints -> inlined
// array literal is injection-safe.
export async function fetchEmptyLegGeoJSON(
  profile: string, from: [number, number], to: [number, number], region: string,
): Promise<unknown | null> {
  const pts = [from, to].filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && !(lon === 0 && lat === 0));
  if (pts.length < 2) return null;
  const prof = profile.replace(/[^a-z0-9-]/gi, '');
  const reg = sqlLiteral(region);
  const locs = JSON.stringify(pts.map(([lon, lat]) => [Number(lon), Number(lat)]));
  const sql = `SELECT ST_ASGEOJSON(GEOJSON)::STRING AS G FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS('${prof}', OBJECT_CONSTRUCT('coordinates', PARSE_JSON('${locs}'))::VARIANT, '${reg}'))`;
  try {
    const rows = await sfRead(sql);
    const g = (rows[0] as { G?: string } | undefined)?.G;
    if (!g) return null;
    return JSON.parse(g);
  } catch {
    return null;
  }
}
