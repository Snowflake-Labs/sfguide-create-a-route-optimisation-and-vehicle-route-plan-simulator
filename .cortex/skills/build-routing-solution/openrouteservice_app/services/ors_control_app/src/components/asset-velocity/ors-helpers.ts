// ORS-call helpers for AssetVelocity smart-reposition logic.
// Wraps OPENROUTESERVICE_APP.CORE.MATRIX (options variant) and ISOCHRONES.

import { sfQuery, asSqlJsonLiteral, type Trailer, type Terminal, type MatrixCache } from './helpers';

// Best-fit ORS profile for the active fleet. Trucking ALWAYS uses driving-hgv
// even if individual rows say driving-car, because the page is HGV-tuned.
export function profileForFleet(trailers: Trailer[]): string {
  if (!trailers.length) return 'driving-car';
  const subtypes = trailers.filter(t => t.VEHICLE_SUBTYPE).length;
  if (subtypes > 0) return 'driving-hgv';
  // Fall through to whatever the trailers report (taxi/ebike/etc.).
  return trailers[0].ORS_PROFILE || 'driving-car';
}

// Conservative envelope of HGV restrictions across the selected trailer set.
// We use the MAX of weight/height/length/axleload (the most restrictive route)
// and ANY hazmat so a single hazmat trailer pulls the whole matrix to hazmat-safe roads.
export function fleetEnvelope(trailers: Trailer[]): {
  weight: number;
  height: number;
  length: number;
  width: number;
  axleload: number;
  hazmat: boolean;
} {
  if (!trailers.length) return { weight: 0, height: 0, length: 0, width: 0, axleload: 0, hazmat: false };
  return {
    weight:   Math.max(...trailers.map(t => t.WEIGHT_TONS ?? 0)),
    height:   Math.max(...trailers.map(t => t.HEIGHT_M ?? 0)),
    length:   Math.max(...trailers.map(t => t.LENGTH_M ?? 0)),
    width:    Math.max(...trailers.map(t => t.WIDTH_M ?? 0)),
    axleload: Math.max(...trailers.map(t => t.AXLELOAD_T ?? 0)),
    hazmat:   trailers.some(t => t.HAZMAT === true),
  };
}

export function avoidFeaturesArr(csv?: string): string[] {
  if (!csv) return [];
  return csv.split(',').map(s => s.trim()).filter(Boolean);
}

// Builds the ORS Matrix `options` payload for the reachability gate only.
// Do NOT send profile_params.restrictions or avoid_features here: they force ORS
// into the flexible (non-CH) matrix algorithm, which times out on continental
// graphs (50x50 EU HGV). driving-hgv without dynamic weighting uses the CH fast
// path. Full HGV restrictions are enforced at VROOM OPTIMIZATION (buildChallenge).
export function buildMatrixOptions(
  sourcesLngLat: [number, number][],
  destsLngLat: [number, number][],
): Record<string, unknown> {
  const locations = [...sourcesLngLat, ...destsLngLat];
  const sources = sourcesLngLat.map((_, i) => i);
  const destinations = destsLngLat.map((_, i) => sourcesLngLat.length + i);
  return {
    locations,
    sources,
    destinations,
    metrics: ['duration'],
    resolve_locations: true,
  };
}

// One MATRIX call returns a duration/distance matrix that we cache per
// (trailer, terminal) pair. NULL durations are kept as 'not routable'.
export async function fetchMatrix(
  trailers: Trailer[],
  terminals: Terminal[],
  profile: string,
  region: string,
  maxRepositionMinutes: number,
): Promise<MatrixCache> {
  if (!trailers.length || !terminals.length) return {};

  // ORS matrix capacity: 100 locations max per call (per native app function spec).
  // Strategy: chunk trailers into batches so total locations <= 100.
  const cache: MatrixCache = {};
  const dests = terminals.map(t => [Number(t.TERMINAL_LNG), Number(t.TERMINAL_LAT)] as [number, number]);
  const trailerBatchSize = Math.max(1, Math.min(trailers.length, 100 - dests.length));
  if (trailerBatchSize <= 0) {
    console.warn('[AV] Too many terminals for one MATRIX call; truncating to 50.');
  }
  const effectiveTrailerBatch = trailerBatchSize > 0 ? trailerBatchSize : 1;

  for (let i = 0; i < trailers.length; i += effectiveTrailerBatch) {
    const batch = trailers.slice(i, i + effectiveTrailerBatch);
    const sources = batch.map(t => [Number(t.LAST_LNG), Number(t.LAST_LAT)] as [number, number]);
    const opts = buildMatrixOptions(sources, dests);
    // Dollar-quoted SQL literal so apostrophes/backslashes/quotes inside any
    // free-text field never need escaping. Bubble SQL errors up to the caller
    // so the page can surface "ORS matrix call failed: <msg>" instead of
    // silently rendering 0 reachable terminals.
    const sql = `
      SELECT OPENROUTESERVICE_APP.CORE.MATRIX(
        '${profile.replace(/'/g, "''")}',
        PARSE_JSON(${asSqlJsonLiteral(opts)}),
        '${region.replace(/'/g, "''")}'
      ) AS RESP`;
    const rows = await sfQuery(sql, 'OPENROUTESERVICE_APP', 'CORE', { throwOnError: true });
    const resp = rows[0]?.RESP;
    if (!resp) {
      console.warn('[AV] MATRIX returned no RESP for batch', i);
      continue;
    }
    const respObj = typeof resp === 'string' ? JSON.parse(resp) : resp;
    if (respObj && typeof respObj === 'object' && respObj.error) {
      const msg = typeof respObj.message === 'string'
        ? respObj.message
        : String(respObj.error);
      throw new Error(msg.slice(0, 500));
    }
    const durations: (number | null)[][] = respObj?.durations || [];
    const distances: (number | null)[][] = respObj?.distances || [];
    for (let r = 0; r < batch.length; r++) {
      const trailer = batch[r];
      cache[trailer.VEHICLE_ID] = {};
      for (let c = 0; c < terminals.length; c++) {
        const dur = durations[r]?.[c] ?? null;
        const dist = distances[r]?.[c] ?? null;
        const reachable = dur != null && Number.isFinite(Number(dur)) && Number(dur) <= maxRepositionMinutes * 60;
        cache[trailer.VEHICLE_ID][terminals[c].TERMINAL_ID] = {
          durationSec: dur != null ? Number(dur) : null,
          distanceM: dist != null ? Number(dist) : null,
          reachable,
        };
      }
    }
  }
  return cache;
}

// Sort terminals for a single trailer by road duration ascending.
// Returns terminal list with computed durationSec attached. Reachable-only.
export function nearestByRoad(
  trailer: Trailer,
  terminals: Terminal[],
  cache: MatrixCache,
  n = 3,
): Array<Terminal & { durationSec: number; distanceM: number | null }> {
  const trailerCache = cache[trailer.VEHICLE_ID];
  if (!trailerCache) return [];
  const decorated = terminals
    .map(t => {
      const cell = trailerCache[t.TERMINAL_ID];
      if (!cell?.reachable || cell.durationSec == null) return null;
      return { ...t, durationSec: cell.durationSec, distanceM: cell.distanceM };
    })
    .filter((x): x is Terminal & { durationSec: number; distanceM: number | null } => x !== null)
    .sort((a, b) => a.durationSec - b.durationSec)
    .slice(0, n);
  return decorated;
}

// Per-trailer isochrone polygon for the dispatcher's reachability gate.
// Returns GeoJSON polygon (or null on error). Uses the existing ISOCHRONES
// wrapper; HGV-specific restrictions inside the wrapper are not yet plumbed
// through, so this polygon is profile-only (driving-hgv graph) - the matrix
// gate (CH fast-path matrix) is the authoritative duration filter.
export async function fetchTrailerIsochrone(
  trailer: Trailer,
  profile: string,
  region: string,
  rangeSec: number,
): Promise<any | null> {
  const sql = `
    SELECT GEOJSON FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES(
      '${profile.replace(/'/g, "''")}',
      ${Number(trailer.LAST_LNG)}::FLOAT,
      ${Number(trailer.LAST_LAT)}::FLOAT,
      ${Math.round(rangeSec)}::INT,
      '${region.replace(/'/g, "''")}'
    ))`;
  const rows = await sfQuery(sql, 'OPENROUTESERVICE_APP', 'CORE');
  const geo = rows[0]?.GEOJSON;
  if (!geo) return null;
  try {
    return typeof geo === 'string' ? JSON.parse(geo) : geo;
  } catch (e) {
    console.warn('[AV] isochrone parse error', e);
    return null;
  }
}
