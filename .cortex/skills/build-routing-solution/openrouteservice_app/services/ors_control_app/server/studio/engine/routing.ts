// Routing primitives: ORS DIRECTIONS calls (single-leg + detour 3-point),
// destination/waypoint pickers, the unroutable-error pattern matcher, and
// the pre-flight POI-pair routability probe used by generateTelemetry.

import type { POI, RouteFetchResult, SnowSqlFn } from './types.js';
import { GenerationConfig, haversineKm } from '../profiles.js';
import { log } from '../../diagnostics.js';

const UNROUTABLE_PATTERNS: RegExp[] = [
  /Could not find routable point/i,
  /code['":\s]+2010/i,
  /point .* not found/i,
  /coordinate \d+:\s*-?\d+(\.\d+)?\s+-?\d+(\.\d+)?/i,
];

export function isUnroutableError(msg: string): boolean {
  return UNROUTABLE_PATTERNS.some(p => p.test(msg));
}

export async function fetchRoute(
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
    const rows = await snowSql(sql);
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
    const rows = await snowSql(sql);
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
