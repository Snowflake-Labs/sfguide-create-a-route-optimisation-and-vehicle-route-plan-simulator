// Constants, types, and pure helpers for the Backload Matching view.
//
// Neutral (industry-agnostic) and USD-denominated. Reads go through the SA
// app's SELECT-only /api/query proxy; the live routing seam is called through
// ROUTING_PLATFORM.CONTRACT (matrix) and OPENROUTESERVICE_APP.CORE.DIRECTIONS
// (empty-leg polyline) at interaction time - never precomputed into tables.

import type { LngLat } from '@/lib/map/map-fit';
import { throwIfSuspended, isSuspendedBody, RoutingSuspendedError, SUSPEND_REASON, isOutOfGraph, parseOutOfGraphPoints } from '@/lib/routing-suspend';

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
  // Provenance, carried STRUCTURALLY rather than inferred from SOURCE. SOURCE is
  // a channel label, and one of its values used to be the literal 'INTERNAL' on
  // rows that are external, which made the internal-first preference this whole
  // page expresses unreadable from that column. Set at assignment build time
  // from WHICH POOL the row came out of, so no label can flip it.
  IS_INTERNAL: boolean;
  PICKUP_LON: number; PICKUP_LAT: number;
  DROPOFF_LON: number; DROPOFF_LAT: number;
  EMPTY_KM: number; LOADED_KM: number; SCORE: number;
  DETOUR_KM?: number; SAVED_KM?: number;
  // Empty (deadhead) km split into its two real legs: idle location -> first
  // pickup (out) and last task stop -> tour end (back). EMPTY_KM is their sum.
  EMPTY_OUT_KM?: number;
  EMPTY_BACK_KM?: number;
  // Reposition baseline the vehicle would have driven empty anyway (idle -> end),
  // from computeEmptyLegBaselines (real ORS matrix, haversine/fixed fallback).
  // SAVED_KM = max(0, BASELINE_EMPTY_KM - EMPTY_KM) and is only meaningful when
  // BASELINE_SOURCE is not 'fixed-open'.
  BASELINE_EMPTY_KM?: number;
  BASELINE_SOURCE?: EmptyLegBaseline['source'];
  PRODUCT: string; PICKUP_CITY: string; PROPOSAL_DROPOFF_CITY: string;
  HOME_LON: number; HOME_LAT: number;
  TRAILER_DROPOFF_LON: number; TRAILER_DROPOFF_LAT: number;
  // Tour end point and last task stop - the two ends of the return empty leg.
  END_LON?: number; END_LAT?: number;
  LAST_TASK_LON?: number; LAST_TASK_LAT?: number;
  ROUTE_GEOJSON?: unknown;
  EMPTY_GEOJSON?: unknown;        // idle location -> first pickup
  EMPTY_RETURN_GEOJSON?: unknown; // last task stop -> tour end (reposition home)
  STOPS: Stop[];
  TOUR_KM?: number;
  TOUR_HRS?: number;
  WAIT_SEC?: number;
  N_DELIVERIES?: number;
  COST_USD?: number;
  REVENUE_USD?: number;
  NET_BENEFIT_USD?: number;
  // Set when the plan was collected from a solve the AGENT ran (see
  // lib/backload-rehydrate). Such a plan arrives with no polylines, so the page
  // must run the same geometry-enrichment pass a local solve runs.
  REHYDRATED?: boolean;
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
//
// `params` binds `:name` placeholders, resolved and escaped server-side by
// /api/query. Prefer it over string interpolation for any value that scopes a
// read - notably REGION. The contract views are MULTI-REGION (region is a
// dimension, not a pre-filter), so an unparameterized `SELECT *` silently
// returns every loaded region: that is how San Francisco trailers and loads
// ended up inside a Europe VROOM challenge, which the Europe road graph
// rejected as "out of bounds".
export async function sfRead(
  sql: string,
  opts: { signal?: AbortSignal; params?: Record<string, string | null> } = {},
): Promise<Record<string, unknown>[]> {
  const res = await fetch('/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts.params ? { sql, params: opts.params } : { sql }),
    signal: opts.signal,
  });
  const body = await res.json();
  // A suspended routing engine returns a typed 503 with NO `error` key, so this
  // check has to come first or the outage is flattened into "HTTP 503".
  throwIfSuspended(res.status, body);
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  const rows = (body.rows as Record<string, unknown>[]) || [];
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(r)) o[k.toUpperCase()] = r[k];
    return o;
  });
}

/**
 * Call a synapse verb through the app's verb dispatcher.
 *
 * The SAME stored procedure backs the agent's MCP tool, so a plan drawn on screen
 * and a plan the agent describes come from one implementation instead of two that
 * drift. Solve strategy, challenge construction, engine invocation and scoring live
 * behind the verb; what stays client-side is only what must be instant (applying
 * weights, re-grading against a slider) or visual (map, drawer).
 *
 * Two failure shapes have to be handled, and conflating them is what makes a
 * suspended region read as "there is nothing to dispatch":
 *  - a typed 503 from the dispatcher, whose payload carries NO `error` key;
 *  - a 200 whose payload is the verb's own { status: 'FAILED', reason }.
 */
export async function callVerb(verb: string, args: unknown[]): Promise<Record<string, unknown>> {
  const res = await fetch('/api/tool', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verb, args }),
  });
  const body = await res.json();
  if (res.status === 503 && isSuspendedBody(body)) throw new RoutingSuspendedError(body);
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  const result = (body.result ?? {}) as Record<string, unknown>;
  if (String(result.status ?? '') === 'FAILED') {
    const err = String(result.error ?? 'Verb call failed');
    if (String(result.reason ?? '') === 'OPTIMIZATION_UNAVAILABLE') {
      // Land in the same catch as a 503 so the shared resume notice is shown.
      // tier/waitMinutes are unknown from here; the notice tolerates that.
      throw new RoutingSuspendedError({
        reason: SUSPEND_REASON, region: String(result.region ?? ''),
        tier: null, waitMinutes: '', message: err,
      });
    }
    throw new Error(err);
  }
  return result;
}

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371, toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Tokens that are NOT place names. Pickup/dropoff cities fall back to these
// literal strings when the underlying POI has no name, so "Destination" and
// "Origin" are placeholders - never somewhere a vehicle actually goes. Mirrors
// the PLACEHOLDERS set in TOOL_BACKLOAD_CHAIN_SOLVE, which already scrubs them
// server-side. Anything published to the agent must scrub them too, or the
// agent quotes "Destination" back to the user as a delivery point.
export const PLACEHOLDER_PLACES = new Set([
  'origin', 'destination', 'drop-off', 'dropoff', 'unknown', 'depot',
]);

// A city name if it is really a place, else null.
export function realPlace(city?: string | null): string | null {
  const t = (city ?? '').trim();
  if (!t) return null;
  return PLACEHOLDER_PLACES.has(t.toLowerCase()) ? null : t;
}

/**
 * What to SHOW where a place name is expected.
 *
 * MEASURED on the live pool: 316 of 800 internal loads have no DELIVERY_CITY and
 * 235 have no PICKUP_CITY, because 2,621 trip destination POI ids (and 2,497
 * origins) exist in neither V_DIM_POIS_CURRENT nor the base DIM_POIS - the name
 * is genuinely unknown, not merely unjoined. Rendering that as an empty span gave
 * cards reading "Cowen Warehouse Services ->" and, when both ends were unknown, a
 * bare "->": a data gap that looks exactly like a broken renderer, on a card whose
 * every number is right.
 *
 * `ref` is a load or vehicle id to name the site by when there is no place name,
 * which is more use to a dispatcher than the word "unknown" alone.
 */
export function placeLabel(city?: string | null, ref?: string | null): string {
  const p = realPlace(city);
  if (p) return p;
  const r = (ref ?? '').trim();
  return r ? `unnamed site (${r})` : 'location unknown';
}

export interface TourChain {
  // Ordered "pick X [LOAD] -> drop Y [LOAD]" text over the task stops.
  chain: string;
  // Every distinct load carried on this tour, in the order first touched. A
  // tour with more than one entry is a CHAINED tour: the first dropoff is a
  // handover, not the destination.
  loadIds: string[];
  firstPickup: string | null;
  // The LAST dropoff. This is the tour's destination; the first dropoff is
  // only hop 1. Falls back to the load id when the site is unnamed.
  finalDropoff: string | null;
  // Where the tour terminates (home depot / shared destination). Never a
  // delivery.
  endCity: string | null;
  truncatedStops: number;
}

// Derive a chain-truthful description of a tour from its ordered STOPS array.
// STOPS is the only complete record of a solved tour: the scalar OFFER_ID /
// PICKUP_CITY / PROPOSAL_DROPOFF_CITY fields on Assignment come from the FIRST
// pickup only, so reading them for a multi-load tour reports hop 1 as if it
// were the whole workload.
export function describeTourChain(stops: Stop[] | undefined, maxStops = 8): TourChain {
  const list = Array.isArray(stops) ? stops : [];
  const tasks = list.filter((s) => s.kind === 'pickup' || s.kind === 'dropoff');
  const loadIds: string[] = [];
  for (const s of tasks) {
    if (s.offerId && !loadIds.includes(s.offerId)) loadIds.push(s.offerId);
  }
  const site = (s: Stop): string => {
    const where = realPlace(s.city);
    if (where) return where;
    return s.offerId ? `unnamed site for ${s.offerId}` : 'unnamed site';
  };
  const shown = tasks.slice(0, maxStops);
  const chain = shown
    .map((s) => `${s.kind === 'pickup' ? 'pick' : 'drop'} ${site(s)}${s.offerId ? ` [${s.offerId}]` : ''}`)
    .join(' -> ');
  const drops = tasks.filter((s) => s.kind === 'dropoff');
  const lastDrop = drops.length ? drops[drops.length - 1] : undefined;
  const firstPick = tasks.find((s) => s.kind === 'pickup');
  return {
    chain,
    loadIds,
    firstPickup: firstPick ? site(firstPick) : null,
    finalDropoff: lastDrop ? site(lastDrop) : null,
    endCity: realPlace(list.find((s) => s.kind === 'end')?.city),
    truncatedStops: Math.max(0, tasks.length - shown.length),
  };
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

/**
 * Deadhead avoided, from the baseline already on the assignment.
 *
 * ONE rule for the whole page, because there are now two producers of
 * BASELINE_EMPTY_KM (the solve and the collected-plan pass) and a second copy of
 * this arithmetic would be free to disagree with the first. 'fixed-open' is
 * excluded deliberately: that baseline is a fixed envelope, not a measurement of
 * this vehicle, so subtracting the tour's empty km from it invents a saving.
 */
export function deriveSavedKm(a: Assignment): void {
  if (a.BASELINE_EMPTY_KM === undefined || a.BASELINE_SOURCE === 'fixed-open') return;
  a.SAVED_KM = Math.max(0, a.BASELINE_EMPTY_KM - a.EMPTY_KM);
}

/**
 * Attach one vehicle's reposition baseline to an assignment.
 *
 * DETOUR_KM is deliberately NOT touched. On the solve path it is derived from
 * the real tour km; on a collected plan the procedure computed its own and the
 * card must keep the number the agent quoted rather than switch to a locally
 * recomputed one halfway through a session.
 */
export function applyBaseline(a: Assignment, base: EmptyLegBaseline | undefined): void {
  if (!base) return;
  a.BASELINE_EMPTY_KM = base.distMeters / 1000;
  a.BASELINE_SOURCE = base.source;
  deriveSavedKm(a);
}

/**
 * The vehicle is already standing at the point it would have repositioned to, so
 * its no-backload baseline is zero and there is no line to draw.
 *
 * MEASURED on the live USA pool: 35 of 89 vehicles report idle == home, and
 * because a zero approach is cheap those vehicles carry the HIGHEST margins - so
 * the top card of a collected plan is very often one of them. Without an
 * explicit state the map simply shows no grey line and the page reads as broken
 * on arrival. Threshold matches `samePlace`, the same tolerance fetchBaselineLeg
 * uses to decide it has nothing to route.
 */
export function isAtEndBaseline(a: Assignment): boolean {
  if (a.END_LON === undefined || a.END_LAT === undefined) return false;
  return samePlace(
    [Number(a.TRAILER_DROPOFF_LON), Number(a.TRAILER_DROPOFF_LAT)],
    [Number(a.END_LON), Number(a.END_LAT)],
  );
}

/**
 * Fill the fields a graded PROPOSAL does not carry from the load pool this page
 * already holds.
 *
 * A collected plan arrives with `PRODUCT: ''` (the procedure's proposal rows have
 * no product at all), so the card rendered "loaded 1221 km \u00b7" with nothing
 * after the separator, and the same tour solved locally showed "B2B pallets".
 * The load rows are already in memory for the map, so this needs no query.
 *
 * Only ever fills a BLANK field. A value the solver resolved stays, because the
 * pool row is a different read of the same load and overwriting would let the
 * card disagree with the plan it is describing. `realPlace` is applied so a
 * placeholder ('Origin', 'Drop-off') is not laundered into a real-looking name.
 *
 * Returns true when it changed something, so the caller can skip a state update
 * it does not need - this runs from an effect that depends on `assignments`.
 */
export function backfillFromLoadPool(
  a: Assignment, pool: Map<string, Volume | Offer>,
): boolean {
  const row = pool.get(String(a.OFFER_ID));
  if (!row) return false;
  let changed = false;
  if (!a.PRODUCT && row.PRODUCT) { a.PRODUCT = String(row.PRODUCT); changed = true; }
  if (!realPlace(a.PICKUP_CITY)) {
    const p = realPlace(row.PICKUP_CITY);
    if (p) { a.PICKUP_CITY = p; changed = true; }
  }
  if (!realPlace(a.PROPOSAL_DROPOFF_CITY)) {
    const d = realPlace(row.DROPOFF_CITY);
    if (d) { a.PROPOSAL_DROPOFF_CITY = d; changed = true; }
  }
  // The stops list is a separate render of the same places, so leaving it blank
  // would fix the card and not the panel below it.
  for (const s of a.STOPS) {
    if (s.kind === 'pickup' && !realPlace(s.city)) {
      const p = realPlace(row.PICKUP_CITY);
      if (p) { s.city = p; changed = true; }
    }
    if (s.kind === 'dropoff' && !realPlace(s.city)) {
      const d = realPlace(row.DROPOFF_CITY);
      if (d) { s.city = d; changed = true; }
    }
    if ((s.kind === 'pickup' || s.kind === 'dropoff') && !s.product && row.PRODUCT) {
      s.product = String(row.PRODUCT); changed = true;
    }
  }
  return changed;
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

// The bbox of the road graph ORS will actually route on.
export interface RegionBbox {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

// Read the ACTIVE region's graph bbox.
//
// Deliberately REGION_ORS_MAP and not FLEET_INTELLIGENCE.CORE.REGION_REGISTRY
// (which use-region-camera.ts reads): the registry bbox is a boundary envelope
// kept for camera framing, while REGION_ORS_MAP carries the extent of the PBF
// the graph was built from - which is the thing ORS enforces when it answers
// "code 6010 out of bounds". Framing the camera on one and routing on the other
// is fine; deciding routability on the camera bbox is not.
//
// Returns null on any missing row / null column, and the caller then skips the
// check. That fail-open is free here: no engine call has been made yet, so
// skipping costs nothing beyond leaving the existing ORS probe to do its job.
export async function fetchRegionBbox(
  region: string | null | undefined,
  opts: { signal?: AbortSignal } = {},
): Promise<RegionBbox | null> {
  if (!region) return null;
  try {
    const rows = await sfRead(
      'SELECT MIN_LON, MAX_LON, MIN_LAT, MAX_LAT ' +
        'FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP WHERE REGION = :region',
      { signal: opts.signal, params: { region: String(region) } },
    );
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) return null;
    const n = (v: unknown) => (v == null ? NaN : Number(v));
    const box: RegionBbox = {
      minLon: n(r.MIN_LON), maxLon: n(r.MAX_LON),
      minLat: n(r.MIN_LAT), maxLat: n(r.MAX_LAT),
    };
    const finite = Object.values(box).every((v) => Number.isFinite(v));
    if (!finite || box.minLon >= box.maxLon || box.minLat >= box.maxLat) return null;
    return box;
  } catch {
    return null;
  }
}

// True when a point lies outside the graph bbox, i.e. ORS will reject the whole
// request rather than return a per-point null. Non-finite coordinates are NOT
// reported here - they are absent data, not out-of-graph, and the existing
// point collection already skips them.
export function pointOutsideBbox(box: RegionBbox, lon: number, lat: number): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
  return lon < box.minLon || lon > box.maxLon || lat < box.minLat || lat > box.maxLat;
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
//
// `opts.stats`, when supplied, is filled in with the evidence behind the result
// so the caller can tell a TRUSTWORTHY shear from a backed-off probe. Without
// that distinction the caller cannot safely act on "the pre-filter removed
// everything": it has to assume the probe misfired and solve the full set,
// which is how a pool that was half out-of-region reached the engine intact.
export interface UnroutableProbeStats {
  probed: number;
  // Points that routed cleanly in BOTH directions and snapped close. Any value
  // above zero proves the engine is up and answering, so a large rejected
  // fraction is real data rather than a degraded probe.
  clean: number;
  rejected: number;
  // True when the probe backed off and deliberately returned an EMPTY set.
  backedOff: boolean;
}

export async function findUnroutablePoints(
  profile: string,
  points: [number, number][],
  anchor: [number, number],
  region: string | null | undefined,
  opts: {
    signal?: AbortSignal;
    snapRadiusM?: number;
    batchSize?: number;
    stats?: UnroutableProbeStats;
  } = {},
): Promise<Set<string>> {
  const bad = new Set<string>();
  let clean = 0;
  const publish = (backedOff: boolean) => {
    if (opts.stats) {
      opts.stats.probed = points.length;
      opts.stats.clean = clean;
      opts.stats.rejected = bad.size;
      opts.stats.backedOff = backedOff;
    }
  };
  if (!points.length) { publish(false); return bad; }
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

  // Extra MATRIX calls the out-of-graph bisect below is allowed to spend.
  // Bounded so a pathological batch cannot turn a probe into an unbounded
  // sequence of round trips.
  let bisectBudget = 24;

  // Points ORS refused BY COORDINATE. Counted separately from `bad` because the
  // backoff below must not discard them (see the note there).
  let offGraphConvicted = 0;

  // Probe ONE batch. Returns 'ok' when verdicts were recorded, 'open' when the
  // response was unusable and the batch must be kept, or 'off-graph' with the
  // coordinates ORS named when the call was refused for being out of bounds.
  const probeBatch = async (
    batch: [number, number][],
  ): Promise<{ kind: 'ok' | 'open' } | { kind: 'off-graph'; named: { lon: number; lat: number }[] }> => {
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
      if (!Array.isArray(durIn) || !Array.isArray(durIn[0])) return { kind: 'open' };
      for (let j = 0; j < batch.length; j++) {
        const inD = durIn[0]?.[j];
        const outD = Array.isArray(durOut) ? durOut[j]?.[0] : undefined;
        const snap = Array.isArray(dests) ? dests[j]?.snapped_distance : undefined;
        const nullIn = inD == null || !Number.isFinite(Number(inD));
        const nullOut = outD == null || !Number.isFinite(Number(outD));
        const farSnap = snap == null || !Number.isFinite(Number(snap)) || Number(snap) > snapMax;
        if (nullIn || nullOut || farSnap) bad.add(coordKey(batch[j][0], batch[j][1]));
        else clean++;
      }
      return { kind: 'ok' };
    } catch (err) {
      // An OUT-OF-GRAPH refusal is evidence, not a hiccup. A point outside the
      // graph bbox does not come back as a null cell - it fails the whole
      // MATRIX call (ORS 6010), so treating it like a transient error kept all
      // 150 points of the batch INCLUDING the one that caused the throw, and
      // the pre-filter could never shear the case it exists for.
      const text = (err as { message?: string } | null)?.message ?? String(err);
      if (isOutOfGraph(text)) return { kind: 'off-graph', named: parseOutOfGraphPoints(text) };
      // Any other MATRIX error: keep this batch's points, let the solve-time
      // retry loop catch any real unroutable point.
      return { kind: 'open' };
    }
  };

  // Worklist rather than a flat loop so an out-of-graph batch can be split and
  // re-probed instead of abandoned whole.
  const queue: [number, number][][] = [];
  for (let i = 0; i < points.length; i += batchSize) queue.push(points.slice(i, i + batchSize));

  while (queue.length) {
    const batch = queue.shift()!;
    if (!batch.length) continue;
    const res = await probeBatch(batch);
    if (res.kind !== 'off-graph') continue;

    // Convict whatever ORS named. parseOutOfGraphPoints already swaps ORS's
    // lat-first reporting into lon,lat - do NOT swap again.
    const namedKeys = new Set<string>();
    for (const p of res.named) {
      if (Number.isFinite(p.lon) && Number.isFinite(p.lat)) {
        const k = coordKey(p.lon, p.lat);
        namedKeys.add(k);
        if (!bad.has(k)) offGraphConvicted++;
        bad.add(k);
      }
    }
    const rest = batch.filter((pt) => !namedKeys.has(coordKey(pt[0], pt[1])));
    // Nothing narrowed and nothing left to split: keep the remainder (fail
    // open) rather than convicting points on no evidence.
    if (!rest.length) continue;
    if (bisectBudget <= 0) continue;
    if (rest.length === batch.length) {
      // ORS refused without naming a point we could match. Halve the batch so
      // the offending point is isolated instead of shielding its neighbours.
      if (batch.length === 1) { bad.add(coordKey(batch[0][0], batch[0][1])); offGraphConvicted++; continue; }
      const mid = Math.floor(batch.length / 2);
      bisectBudget -= 2;
      queue.push(batch.slice(0, mid), batch.slice(mid));
    } else {
      // Named points removed: re-probe the remainder so its verdicts are not lost.
      bisectBudget -= 1;
      queue.push(rest);
    }
  }
  // Sanity backoff: the pre-filter must only ever remove a MINORITY of genuinely
  // unroutable points (bad data is ~1% of a preset). If it flags a large
  // fraction, the probe MAY be untrustworthy - a suspended/degraded ORS returns
  // null durations rather than throwing, a mis-snapped anchor makes everything
  // look far, and a proxy/parse hiccup can null whole batches.
  //
  // But a large fraction is NOT automatically a bad probe. When the pool spans
  // two regions, half of it is legitimately off-graph, and backing off there is
  // the worst possible move: it hands the engine the very coordinates it cannot
  // route, which fails the matrix pre-compute outright (ORS 6010) instead of
  // shearing 29 points and solving the rest. So the backoff is now gated on
  // `clean === 0` - zero cleanly-routed points is the actual signature of a
  // probe that cannot see the graph. One clean point proves the engine is
  // answering, which makes every rejection real.
  //
  // Out-of-graph convictions are exempt entirely. Those points were not inferred
  // from a null cell that a degraded engine could also produce - ORS was asked
  // and explicitly refused them by coordinate, so there is no reading of that
  // response under which they are routable.
  if (
    points.length &&
    offGraphConvicted === 0 &&
    bad.size > Math.floor(points.length * 0.5) &&
    clean === 0
  ) {
    publish(true);
    return new Set();
  }
  publish(false);
  return bad;
}

// ORS routes through at most this many waypoints in one DIRECTIONS call. Longer
// tours fall back to straight links rather than failing the request.
export const MAX_DIRECTIONS_WAYPOINTS = 50;

// Drop unusable waypoints (non-finite, null island) and collapse consecutive
// duplicates - DIRECTIONS rejects zero-length legs, and VROOM `break` steps
// often repeat the location of the step before them.
// Drop unusable and repeated waypoints before a DIRECTIONS call.
//
// Consecutive duplicates are compared with `samePlace`, NOT with `===`. MEASURED
// in QUERY_HISTORY (3 calls today): a pair differing only in the 15th decimal -
// [-95.653004999012620, 28.821004867129155] then [..., 28.82100486712915] - both
// survived exact-equality dedupe, ORS returned a degenerate one-point line, and
// the statement failed with "GeoJSON::LineString: 'coordinates' malformed". The
// caller swallows that null and draws a straight line, so the only visible trace
// was a wasted round trip. 1e-5 deg is ~1 m: below any routable difference.
function cleanWaypoints(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [lon, lat] of pts) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || (lon === 0 && lat === 0)) continue;
    const prev = out[out.length - 1];
    if (prev && samePlace(prev, [Number(lon), Number(lat)])) continue;
    out.push([Number(lon), Number(lat)]);
  }
  return out;
}

// Straight LineString between two points, or null when they are the same place
// or either is unusable. Used as the LAST resort for a deadhead leg whose road
// geometry DIRECTIONS refused to return: without it the dashed layer is simply
// not pushed, so the map shows a tour with no visible connection to the vehicle
// and nothing anywhere says why. Geometry only - the caller must NOT copy a km
// off this, because a straight line is not the distance the vehicle drives.
export function straightLineGeoJSON(
  from: [number, number], to: [number, number],
): unknown | null {
  const pts = cleanWaypoints([from, to]);
  if (pts.length < 2) return null;
  return { type: 'LineString', coordinates: pts };
}

// Road polyline + real road distance through N waypoints via ORS DIRECTIONS.
// Returns null on failure so callers can fall back to haversine km / straight
// links. Numeric-only waypoints -> inlined array literal is injection-safe.
export async function fetchDirections(
  profile: string, waypoints: [number, number][], region: string,
): Promise<{ geo: unknown; km: number | null } | null> {
  const pts = cleanWaypoints(waypoints);
  if (pts.length < 2 || pts.length > MAX_DIRECTIONS_WAYPOINTS) return null;
  const prof = profile.replace(/[^a-z0-9-]/gi, '');
  const reg = sqlLiteral(region);
  const locs = JSON.stringify(pts);
  const sql = `SELECT ST_ASGEOJSON(GEOJSON)::STRING AS G, DISTANCE AS D FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS('${prof}', OBJECT_CONSTRUCT('coordinates', PARSE_JSON('${locs}'))::VARIANT, '${reg}'))`;
  try {
    const rows = await sfRead(sql);
    const r = rows[0] as { G?: string; D?: number | string } | undefined;
    if (!r?.G) return null;
    const meters = Number(r.D);
    return { geo: JSON.parse(r.G), km: Number.isFinite(meters) && meters > 0 ? meters / 1000 : null };
  } catch {
    return null;
  }
}

// Empty-leg road polyline + real road distance via ORS DIRECTIONS. Used for both
// deadhead legs of a tour: idle location -> first pickup, and last task stop ->
// tour end. Returns null on failure so callers fall back to haversine km and
// simply draw no dashed line.
export async function fetchEmptyLeg(
  profile: string, from: [number, number], to: [number, number], region: string,
): Promise<{ geo: unknown; km: number | null } | null> {
  return fetchDirections(profile, [from, to], region);
}

// Where a tour is required to finish. Mirrors the End radio group on the page.
export type EndMode = 'home' | 'shared' | 'open';

// Baseline (no-backload) reposition leg for ONE vehicle: the road polyline plus
// the road km it measured, and a human label for the point it ends at.
//
// `status` separates the three outcomes a caller must not conflate:
//   'ok'      - a real leg, `geo` is a LineString and `km` is road km
//   'at-end'  - the vehicle is ALREADY at its endpoint, so the baseline is 0 km
//               and there is nothing to draw. Measured: several trailers report
//               DROPOFF == HOME, and cleanWaypoints drops a zero-length leg, so
//               without this the UI waits on a fetch that can never return.
//   'failed'  - unroutable or the seam errored; no line, no number
export interface BaselineGeom {
  geo: unknown; km: number | null; endLabel: string;
  status: 'ok' | 'at-end' | 'failed';
}

// Two positions are the same place for baseline purposes. Matches the tolerance
// cleanWaypoints effectively applies (it collapses exact repeats) but with a
// little slack, because DROPOFF and HOME arrive from different columns and can
// differ in the last decimal for the same POI.
export function samePlace(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
}

/**
 * Endpoint the vehicle would have repositioned to with NO backload.
 *
 * Mirrors the `end` stop the solve builds (see endPt in backload-matching.tsx)
 * so this line and BASELINE_EMPTY_KM measure the SAME leg - a baseline drawn to
 * a different point than the baseline km was computed against puts a line and a
 * number that disagree on the same screen.
 *
 * `open` has no solver end point, so the baseline falls back to the home depot:
 * a vehicle with no backload still goes home, and drawing nothing would read as
 * "this vehicle has no baseline" rather than "the solve left the tour open".
 */
export function baselineEndpointFor(
  t: Pick<Trailer, 'HOME_LON' | 'HOME_LAT' | 'HOME_DEPOT'>,
  endMode: EndMode, sharedLon: number | null, sharedLat: number | null,
): { pt: [number, number]; label: string } | null {
  if (endMode === 'shared' && sharedLon !== null && sharedLat !== null
    && Number.isFinite(Number(sharedLon)) && Number.isFinite(Number(sharedLat))) {
    return { pt: [Number(sharedLon), Number(sharedLat)], label: 'shared destination' };
  }
  const lon = Number(t.HOME_LON), lat = Number(t.HOME_LAT);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const depot = t.HOME_DEPOT ? String(t.HOME_DEPOT) : 'home depot';
  return { pt: [lon, lat], label: endMode === 'open' ? `${depot} (assumed)` : depot };
}

// Baseline polyline for one vehicle: idle drop-off -> the endpoint above. Same
// live routing seam every other line on this map uses, so no precomputed table
// and no new procedure. Never returns null: a caller needs to tell "still
// fetching" from "there is no baseline", and returning null for both is what
// leaves a spinner up forever on a vehicle that is already home.
export async function fetchBaselineLeg(
  profile: string, from: [number, number], to: [number, number], region: string, endLabel: string,
): Promise<BaselineGeom> {
  if (samePlace(from, to)) return { geo: null, km: 0, endLabel, status: 'at-end' };
  const leg = await fetchEmptyLeg(profile, from, to, region);
  if (!leg) return { geo: null, km: null, endLabel, status: 'failed' };
  return { geo: leg.geo, km: leg.km, endLabel, status: 'ok' };
}

// Geometry-only wrapper (kept for callers that do not need the distance).
export async function fetchEmptyLegGeoJSON(
  profile: string, from: [number, number], to: [number, number], region: string,
): Promise<unknown | null> {
  const leg = await fetchEmptyLeg(profile, from, to, region);
  return leg ? leg.geo : null;
}

// Loaded tour polyline for one assignment, fetched lazily after the solve. The
// solve itself is run with VROOM geometry disabled (options.g=false) because the
// decoded per-route geometry blows the 20MB _OPTIMIZATION_RAW response cap on
// large regions - see the solve call in backload-matching.tsx.
//
// Waypoints span the first pickup through the last task stop: `start` (vehicle
// idle location) and `end` (tour end) are excluded because those two legs are
// the deadheads, drawn separately from EMPTY_GEOJSON / EMPTY_RETURN_GEOJSON.
// Falls back to a straight LineString through the same waypoints so the tour is
// never silently missing from the map.
//
// Returns the road distance alongside the geometry. It used to return `geo` only
// and drop the km that fetchDirections had already paid for, which left a
// collected plan drawing a real road line beside a straight-line LOADED_KM - two
// distance systems on one card, with a note promising the road one. `km` is null
// when the straight-line fallback was used, so a caller can tell a real road
// measurement from a substitute rather than treating them alike.
export async function fetchTourPath(
  profile: string, stops: Stop[], region: string,
): Promise<{ geo: unknown; km: number | null } | null> {
  const pts = cleanWaypoints(
    stops.filter((s) => s.kind !== 'start' && s.kind !== 'end')
      .map((s) => [Number(s.lon), Number(s.lat)] as [number, number]),
  );
  if (pts.length < 2) return null;
  const road = await fetchDirections(profile, pts, region);
  if (road?.geo) return { geo: road.geo, km: road.km };
  return { geo: { type: 'LineString', coordinates: pts }, km: null };
}

// Cut a tour polyline at the point closest to `at`, returning the leading
// portion. Used so the solid "loaded" path stops at the last task stop and the
// dashed empty-leg layer owns the reposition tail instead of it being painted as
// if the vehicle were loaded.
export function trimPathAt(path: LngLat[], at: [number, number]): LngLat[] {
  if (path.length < 2) return path;
  let bestIdx = path.length - 1;
  let bestD = Infinity;
  for (let i = 0; i < path.length; i += 1) {
    const d = haversineKm(path[i][0], path[i][1], at[0], at[1]);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }
  // Keep at least two points so the layer still renders something sane.
  return path.slice(0, Math.max(2, bestIdx + 1));
}
