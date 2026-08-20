// Routing primitives: ORS DIRECTIONS calls (single-leg + detour 3-point),
// destination/waypoint pickers, the unroutable-error pattern matcher, and
// the pre-flight POI-pair routability probe used by generateTelemetry.

import type { POI, RouteFetchResult, SnowSqlFn } from './types';
import { GenerationConfig, haversineKm } from '../profiles';
import { log } from '../../diagnostics';
import { binPoisByLatLng, binDegForArea, bboxAreaKm2 } from './spatial';

const UNROUTABLE_PATTERNS: RegExp[] = [
  /Could not find routable point/i,
  /code['":\s]+2010/i,
  /point .* not found/i,
  /coordinate \d+:\s*-?\d+(\.\d+)?\s+-?\d+(\.\d+)?/i,
];

export function isUnroutableError(msg: string): boolean {
  return UNROUTABLE_PATTERNS.some(p => p.test(msg));
}

// ----------------------------------------------------------------------------
// In-process route cache (per-job, ephemeral). With only a few thousand POIs
// and stratified destination picking, the same (origin, dest, profile) pairs
// recur constantly across 100 vehicles x N days x ~15 trips, so the same ORS
// DIRECTIONS statement is issued thousands of times. Caching the geometry in
// memory collapses those to one ORS call per distinct pair. Two vehicles that
// drive the same road pair follow the same road in reality, and per-trip GPS
// jitter/timing is applied downstream in interpolateRoute, so realism is
// preserved. This is NOT a materialized ORS table read back in a view - it is
// an in-memory, per-run cache - so Architecture Tenet 9 (live routing) holds.
//
// We cache geometry AND 'UNROUTABLE' (so a known-bad pair is never retried),
// but NOT null (hard/transient failures must stay retryable so ORS recovery
// can kick in). Single-flight: concurrent callers for the same key share one
// in-flight Promise. FIFO-capped to bound memory across long/large runs.
const ROUTE_CACHE_MAX = 300_000;
const routeCache = new Map<string, Promise<RouteFetchResult>>();
let routeCacheHits = 0;
let routeCacheMisses = 0;

// Per-run liveness signal. Every real ORS DIRECTIONS call bumps these when it
// resolves (success, UNROUTABLE, hard-fail, or timeout), giving jobs.ts a second
// "still alive" signal beyond vehicle-day-completion progress events. On a
// continent-scale region a single vehicle-day can take longer than the 15-min
// no-progress watchdog window, so without this a healthy-but-slow run (route
// calls still completing every <=60s) is falsely aborted as an "ORS stall". A
// genuine outage is unaffected: it is caught quickly by the engine hard-stop
// (25 consecutive failures + 0 successes), so refreshing on timeouts here does
// not mask a down ORS. Reset by clearRouteCache() at generator start.
let lastRouteActivityMs = Date.now();
let routeCallCompletions = 0;

export function clearRouteCache(): void {
  routeCache.clear();
  routeCacheHits = 0;
  routeCacheMisses = 0;
  lastRouteActivityMs = Date.now();
  routeCallCompletions = 0;
}

export function routeCacheStats(): { size: number; hits: number; misses: number; hitRate: number } {
  const total = routeCacheHits + routeCacheMisses;
  return {
    size: routeCache.size,
    hits: routeCacheHits,
    misses: routeCacheMisses,
    hitRate: total > 0 ? routeCacheHits / total : 0,
  };
}

// Liveness snapshot for the jobs.ts watchdog/heartbeat. `completions` increases
// monotonically per run so a tick can tell whether any ORS call landed since the
// last tick; `lastActivityMs` is the wall-clock of the most recent completion.
export function getRouteActivity(): { lastActivityMs: number; completions: number } {
  return { lastActivityMs: lastRouteActivityMs, completions: routeCallCompletions };
}

function markRouteActivity(): void {
  lastRouteActivityMs = Date.now();
  routeCallCompletions++;
}

// Wrap a route fetch with the single-flight cache. `key` identifies the pair;
// `fetcher` performs the real ORS call on a miss. A resolved `null` (hard fail)
// is evicted so it can be retried; geometry and 'UNROUTABLE' are retained.
async function cachedRoute(key: string, fetcher: () => Promise<RouteFetchResult>): Promise<RouteFetchResult> {
  const existing = routeCache.get(key);
  if (existing) {
    routeCacheHits++;
    return existing;
  }
  routeCacheMisses++;
  if (routeCache.size >= ROUTE_CACHE_MAX) {
    // FIFO eviction: drop the oldest inserted key.
    const oldest = routeCache.keys().next().value;
    if (oldest !== undefined) routeCache.delete(oldest);
  }
  const p = fetcher();
  routeCache.set(key, p);
  const result = await p;
  if (result === null) routeCache.delete(key); // keep transient hard-fails retryable
  return result;
}

// Per-call ORS timeout. A single stuck DIRECTIONS statement would otherwise
// block a vehicle-day worker for up to the SQL API's ~10 min poll ceiling and
// stall the whole generator. Racing against a bounded timer turns a hang into a
// thrown error, which the callers' catch converts to a retryable `null` (hard
// fail) - feeding the existing consecutive-failure ORS recovery path.
const ROUTE_CALL_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// Round a coordinate to ~1m so tiny float noise on identical POIs collapses to
// one key (POI coords repeat exactly, but this is belt-and-suspenders).
function coordKey(lng: number, lat: number): string {
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

export async function fetchRoute(
  originLat: number, originLng: number,
  destLat: number, destLng: number,
  profile: string,
  region: string,
  snowSql: SnowSqlFn,
): Promise<RouteFetchResult> {
  const key = `d|${profile}|${region}|${coordKey(originLng, originLat)}|${coordKey(destLng, destLat)}`;
  return cachedRoute(key, () => fetchRouteUncached(originLat, originLng, destLat, destLng, profile, region, snowSql));
}

async function fetchRouteUncached(
  originLat: number, originLng: number,
  destLat: number, destLng: number,
  profile: string,
  region: string,
  snowSql: SnowSqlFn,
): Promise<RouteFetchResult> {
  const sql = `
    SELECT TO_VARCHAR(ST_ASGEOJSON(GEOJSON)) AS GEO_STR, DISTANCE, DURATION
    FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
      '${profile}',
      ARRAY_CONSTRUCT(${originLng},${originLat}),
      ARRAY_CONSTRUCT(${destLng},${destLat}),
      '${region.replace(/'/g, "''")}'
    ))`;
  try {
    const rows = await withTimeout(snowSql(sql), ROUTE_CALL_TIMEOUT_MS, 'DIRECTIONS');
    if (!rows.length) {
      return 'UNROUTABLE';
    }
    const dist = rows[0].DISTANCE;
    const dur = rows[0].DURATION;
    const geo = typeof rows[0].GEO_STR === 'string' ? JSON.parse(rows[0].GEO_STR) : rows[0].GEO_STR;
    const coords: [number, number][] = geo?.coordinates || [];
    if (coords.length < 2 || dist == null || dur == null) {
      return 'UNROUTABLE';
    }
    return {
      coordinates: coords.map(c => [c[1], c[0]]),
      distance_m: Number(dist) || 0,
      duration_sec: Number(dur) || 0,
    };
  } catch (e: any) {
    const msg = String(e?.message || '');
    if (isUnroutableError(msg)) {
      return 'UNROUTABLE';
    }
    log('WARN', 'Studio', `Route fetch failed: ${msg.slice(0, 300)}`, {
      detail: { origin: [originLat, originLng], dest: [destLat, destLng], profile },
    });
    return null;
  } finally {
    // Bump the liveness signal on every completion (success/UNROUTABLE/fail/timeout)
    // so the watchdog can tell a slow-but-alive run from a wedged generator.
    markRouteActivity();
  }
}

export async function fetchDetourRoute(
  originLat: number, originLng: number,
  waypointLat: number, waypointLng: number,
  destLat: number, destLng: number,
  profile: string,
  region: string,
  snowSql: SnowSqlFn,
): Promise<RouteFetchResult> {
  const key = `t|${profile}|${region}|${coordKey(originLng, originLat)}|${coordKey(waypointLng, waypointLat)}|${coordKey(destLng, destLat)}`;
  return cachedRoute(key, () => fetchDetourRouteUncached(originLat, originLng, waypointLat, waypointLng, destLat, destLng, profile, region, snowSql));
}

async function fetchDetourRouteUncached(
  originLat: number, originLng: number,
  waypointLat: number, waypointLng: number,
  destLat: number, destLng: number,
  profile: string,
  region: string,
  snowSql: SnowSqlFn,
): Promise<RouteFetchResult> {
  const coordsJson = JSON.stringify({
    coordinates: [
      [originLng, originLat],
      [waypointLng, waypointLat],
      [destLng, destLat],
    ],
  }).replace(/'/g, "''");
  const sql = `
    SELECT TO_VARCHAR(ST_ASGEOJSON(GEOJSON)) AS GEO_STR, DISTANCE, DURATION
    FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
      '${profile}',
      PARSE_JSON('${coordsJson}')::VARIANT,
      '${region.replace(/'/g, "''")}'
    ))`;
  try {
    const rows = await withTimeout(snowSql(sql), ROUTE_CALL_TIMEOUT_MS, 'DIRECTIONS(detour)');
    if (!rows.length) return 'UNROUTABLE';
    const dist = rows[0].DISTANCE;
    const dur = rows[0].DURATION;
    const geo = typeof rows[0].GEO_STR === 'string' ? JSON.parse(rows[0].GEO_STR) : rows[0].GEO_STR;
    const coords: [number, number][] = geo?.coordinates || [];
    if (coords.length < 2 || dist == null || dur == null) return 'UNROUTABLE';
    return {
      coordinates: coords.map(c => [c[1], c[0]]),
      distance_m: Number(dist) || 0,
      duration_sec: Number(dur) || 0,
    };
  } catch (e: any) {
    const msg = String(e?.message || '');
    if (isUnroutableError(msg)) {
      return 'UNROUTABLE';
    }
    log('WARN', 'Studio', `Detour route fetch failed: ${msg.slice(0, 300)}`, {
      detail: { profile },
    });
    return null;
  } finally {
    markRouteActivity();
  }
}

export function pickDestination(
  origin: POI, pois: POI[], config: GenerationConfig, rng: () => number,
): POI {
  const destPois = pois.filter(p => p.location_id !== origin.location_id);
  if (destPois.length === 0) return origin;

  const { short_pct, short_max_km, medium_pct, medium_max_km } = config.distance_distribution;
  const r = rng();
  let maxKm: number;
  if (r < short_pct) maxKm = short_max_km;
  else if (r < short_pct + medium_pct) maxKm = medium_max_km;
  else maxKm = 999;

  const nearby = destPois.filter(p => haversineKm(origin.lat, origin.lng, p.lat, p.lng) <= maxKm);
  const pool = nearby.length > 0 ? nearby : destPois;

  // Layer 2: stratified destination pool (region-agnostic). Bin the candidate
  // pool by spatial cell, pick a bin uniformly, then a POI within. This stops
  // dense metros (Ruhr, Bay Area, Paris) from dominating destination selection.
  // Falls back to uniform-over-pool when stratification is disabled or when
  // fewer than min_bins_required bins are populated (small regions / short
  // distance bands), preserving original behaviour.
  const ssEnabled = config.spatial_spread?.enabled !== false;
  const minBins = config.spatial_spread?.min_bins_required ?? 3;
  if (ssEnabled) {
    const ssBin = config.spatial_spread?.bin_deg;
    const binDeg = ssBin && ssBin > 0
      ? ssBin
      : binDegForArea(config.region_area_km2 ?? bboxAreaKm2(config.bbox));
    const bins = binPoisByLatLng(pool, binDeg);
    if (bins.size >= minBins) {
      const keys = [...bins.keys()];
      const key = keys[Math.floor(rng() * keys.length)];
      const list = bins.get(key)!;
      return list[Math.floor(rng() * list.length)];
    }
  }
  return pool[Math.floor(rng() * pool.length)];
}

export function pickNearestRoutableNeighbor(
  origin: POI, pois: POI[], rng: () => number,
): POI | null {
  const NEIGHBOR_RADIUS_KM = 10;
  const candidates = pois.filter(p =>
    p.location_id !== origin.location_id &&
    haversineKm(origin.lat, origin.lng, p.lat, p.lng) <= NEIGHBOR_RADIUS_KM
  );
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

export function pickDetourWaypoint(
  origin: POI, dest: POI, pois: POI[], rng: () => number,
): POI | null {
  const midLat = (origin.lat + dest.lat) / 2;
  const midLng = (origin.lng + dest.lng) / 2;
  const directDist = haversineKm(origin.lat, origin.lng, dest.lat, dest.lng);
  const maxOffset = directDist * 0.5;
  const candidates = pois.filter(p =>
    p.location_id !== origin.location_id &&
    p.location_id !== dest.location_id &&
    haversineKm(midLat, midLng, p.lat, p.lng) <= maxOffset
  );
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

// Pre-flight probe: pick N random ordered pairs from the (post-filter) POI list and
// confirm they actually route on the active graph. Catches any remaining POI/graph
// mismatch before vehicles are generated. For multi-country regions (no country filter)
// this is the only safety net, so we keep it conservative.
export async function probeRoutability(
  pois: POI[],
  profile: string,
  region: string,
  snowSql: SnowSqlFn,
  opts?: { sampleSize?: number; minSuccess?: number; rng?: () => number },
): Promise<{ ok: boolean; success: number; total: number; failures: Array<{ origin: [number, number]; dest: [number, number]; reason: string }> }> {
  const sampleSize = opts?.sampleSize ?? 5;
  const minSuccess = opts?.minSuccess ?? 3;
  const rng = opts?.rng ?? Math.random;
  if (pois.length < 2) {
    return { ok: false, success: 0, total: 0, failures: [{ origin: [0, 0], dest: [0, 0], reason: 'fewer than 2 POIs available' }] };
  }
  const failures: Array<{ origin: [number, number]; dest: [number, number]; reason: string }> = [];
  let success = 0;
  for (let i = 0; i < sampleSize; i++) {
    const a = pois[Math.floor(rng() * pois.length)];
    let b = pois[Math.floor(rng() * pois.length)];
    let guard = 0;
    while (b.location_id === a.location_id && guard++ < 10) b = pois[Math.floor(rng() * pois.length)];
    const result = await fetchRoute(a.lat, a.lng, b.lat, b.lng, profile, region, snowSql);
    if (result && result !== 'UNROUTABLE') {
      success++;
    } else {
      failures.push({ origin: [a.lat, a.lng], dest: [b.lat, b.lng], reason: result === 'UNROUTABLE' ? 'UNROUTABLE' : 'hard_fail' });
    }
  }
  return { ok: success >= minSuccess, success, total: sampleSize, failures };
}
