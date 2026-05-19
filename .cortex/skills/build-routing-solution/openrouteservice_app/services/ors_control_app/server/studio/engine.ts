import {
  GenerationConfig, DwellConfig, haversineKm, lognormalSample,
  calculateHeading, addGpsJitter, createRng, rngInt, rngFloat, uuid,
  resolveVehicleType, VehicleType,
} from './profiles.js';
import { log } from '../diagnostics.js';

export type {
  TelemetryPoint, TripRecord, GenerationEvent, POI, RouteGeometry,
  FleetMember, GenerationProgress, RouteFetchResult, FreightOffer,
} from './engine/types.js';
import type { POI, RouteGeometry, FleetMember, GenerationProgress, RouteFetchResult, FreightOffer, TelemetryPoint, TripRecord, GenerationEvent, SnowSqlFn } from './engine/types.js';
export { generateFreightOffers } from './engine/freight.js';

type VehicleState = 'MOVING' | 'DWELL_ORIGIN' | 'DWELL_DESTINATION' | 'DWELL_REST' | 'DWELL_RECHARGE' | 'IDLE' | 'OVERNIGHT';

interface VehicleLifecycle {
  vehicle: FleetMember;
  lat: number;
  lng: number;
  currentTime: Date;
  state: VehicleState;
  location_id: string | null;
  location_type: string | null;
  dailyDrivingMin: number;
  minSinceBreak: number;
  tripSeq: number;
  odometerKm: number;
  pointIndex: number;
}

const UNROUTABLE_PATTERNS: RegExp[] = [
  /Could not find routable point/i,
  /code['":\s]+2010/i,
  /point .* not found/i,
  /coordinate \d+:\s*-?\d+(\.\d+)?\s+-?\d+(\.\d+)?/i,
];

// Look up ISO-2 country codes for the active region from FLEET_INTELLIGENCE.CORE.REGION_REGISTRY.
// When the column is non-empty, loadPOIs filters POIs to those countries (eliminates border-bbox
// leakage). When NULL/empty, no country filter is applied and the job relies on the snap-distance
// filter + probeRoutability for safety. Returns null on lookup failure (logged WARN, non-fatal).
async function fetchRegionCountryCodes(region: string, snowSql: SnowSqlFn): Promise<string[] | null> {
  if (!region) return null;
  const safe = region.replace(/'/g, "''");
  try {
    const rows = await snowSql(
      `SELECT COUNTRY_CODES FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY WHERE REGION_NAME = '${safe}' LIMIT 1`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    const raw = rows?.[0]?.COUNTRY_CODES;
    if (raw == null) return null;
    const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : null);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map((c: unknown) => String(c).trim()).filter(Boolean);
  } catch (e: any) {
    log('WARN', 'Studio', `REGION_REGISTRY country lookup failed (continuing without country filter): ${e.message?.slice(0, 200)}`, {
      detail: { region },
    });
    return null;
  }
}

// Per-profile snap-distance threshold (metres) used by filterRoutablePois.
// Driving graphs are dense, so a snap > 300 m almost always means the point is
// off the active country graph (e.g. across a national border). Cycling/foot
// graphs are sparser and need a wider radius.
const SNAP_THRESHOLD_M_BY_PROFILE: Record<string, number> = {
  'driving-car': 300,
  'driving-hgv': 300,
  'cycling-regular': 2000,
  'cycling-electric': 2000,
  'cycling-mountain': 2000,
  'cycling-road': 2000,
  'foot-walking': 2000,
  'foot-hiking': 2000,
};

function snapThresholdForProfile(profile: string): number {
  return SNAP_THRESHOLD_M_BY_PROFILE[profile] ?? 2000;
}

function isUnroutableError(msg: string): boolean {
  return UNROUTABLE_PATTERNS.some(p => p.test(msg));
}

async function filterRoutablePois(
  pois: POI[],
  profile: string,
  region: string,
  bbox: { min_lat: number; max_lat: number; min_lng: number; max_lng: number },
  snowSql: SnowSqlFn,
  onProgressLog?: (msg: string) => void,
): Promise<POI[]> {
  if (pois.length === 0) return pois;

  const centerLat = (bbox.min_lat + bbox.max_lat) / 2;
  const centerLng = (bbox.min_lng + bbox.max_lng) / 2;
  const sourcesArr = `ARRAY_CONSTRUCT(ARRAY_CONSTRUCT(${centerLng}, ${centerLat}))`;
  const profileEsc = profile.replace(/'/g, "''");
  const regionEsc = region.replace(/'/g, "''");

  const BATCH_SIZE = 1000;
  const SNAP_THRESHOLD_M = snapThresholdForProfile(profile);
  const reachable = new Array<boolean>(pois.length).fill(false);
  let droppedNullDuration = 0;
  let droppedFarSnap = 0;

  for (let i = 0; i < pois.length; i += BATCH_SIZE) {
    const batch = pois.slice(i, i + BATCH_SIZE);
    const destsArr = 'ARRAY_CONSTRUCT(' +
      batch.map(p => `ARRAY_CONSTRUCT(${p.lng}, ${p.lat})`).join(',') +
      ')';
    const sql = `
      SELECT TO_VARCHAR(M:durations[0]) AS DURATIONS,
             TO_VARCHAR(M:destinations) AS DESTINATIONS
      FROM (
        SELECT OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR(
          '${profileEsc}',
          ${sourcesArr},
          ${destsArr},
          '${regionEsc}'
        ) AS M
      )
    `;
    try {
      const rows = await snowSql(sql);
      const rawDur = rows?.[0]?.DURATIONS;
      const rawDest = rows?.[0]?.DESTINATIONS;
      if (!rawDur) {
        log('WARN', 'Studio', `POI filter batch ${i}-${i + batch.length}: empty result, keeping batch`);
        for (let j = 0; j < batch.length; j++) reachable[i + j] = true;
        continue;
      }
      const durations = JSON.parse(typeof rawDur === 'string' ? rawDur : String(rawDur));
      const destinations = rawDest ? JSON.parse(typeof rawDest === 'string' ? rawDest : String(rawDest)) : [];
      if (!Array.isArray(durations)) {
        log('WARN', 'Studio', `POI filter batch ${i}: non-array durations, keeping batch`);
        for (let j = 0; j < batch.length; j++) reachable[i + j] = true;
        continue;
      }
      for (let j = 0; j < batch.length; j++) {
        const d = durations[j];
        if (d == null || !Number.isFinite(Number(d))) {
          droppedNullDuration++;
          continue;
        }
        const dest = Array.isArray(destinations) ? destinations[j] : null;
        // Treat a null destination object as not routable: ORS could not snap the POI to any
        // road in the active graph. Older code kept these because snap was undefined.
        if (dest == null) {
          droppedNullDuration++;
          continue;
        }
        const snap = dest?.snapped_distance;
        if (snap == null || !Number.isFinite(Number(snap)) || Number(snap) > SNAP_THRESHOLD_M) {
          droppedFarSnap++;
          continue;
        }
        reachable[i + j] = true;
      }
    } catch (e: any) {
      log('WARN', 'Studio', `POI filter batch ${i} failed (non-fatal): ${e.message?.slice(0, 200)}`);
      for (let j = 0; j < batch.length; j++) reachable[i + j] = true;
    }
  }

  const filtered = pois.filter((_p, i) => reachable[i]);
  const dropped = pois.length - filtered.length;
  log('INFO', 'Studio', `POI routability filter: ${filtered.length}/${pois.length} routable`, {
    detail: { dropped, droppedNullDuration, droppedFarSnap, profile, region, source: [centerLng, centerLat], snapThresholdM: SNAP_THRESHOLD_M },
  });

  if (filtered.length < Math.max(50, Math.floor(pois.length * 0.5))) {
    const msg = `POI filter dropped too many (${dropped}/${pois.length}); falling back to unfiltered list (probable bbox-centroid mismatch with graph)`;
    log('WARN', 'Studio', msg);
    onProgressLog?.(`POI filter: ${filtered.length}/${pois.length} routable - too aggressive, using unfiltered list`);
    return pois;
  }

  onProgressLog?.(`POI filter: ${filtered.length}/${pois.length} routable (dropped ${droppedNullDuration} unreachable, ${droppedFarSnap} far-snap)`);
  return filtered;
}

export async function loadPOIs(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  onLog?: (msg: string) => void,
): Promise<POI[]> {
  const { bbox } = config;
  const cats = config.poi_categories || ['restaurant', 'bar', 'hotel', 'corporate_or_business_office'];
  const catFilter = cats.map(c => `'${c}'`).join(',');
  const countryCodes = await fetchRegionCountryCodes(config.region, snowSql);
  const countryFilter = countryCodes && countryCodes.length
    ? `
      AND p.ADDRESSES[0]:country::STRING IN (${countryCodes.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})`
    : '';
  const sql = `
    WITH region_boundary AS (
      SELECT BOUNDARY
      FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
      WHERE rc.BOUNDARY IS NOT NULL
        AND (UPPER(rc.LOOKUP_NAME) = UPPER('${config.region.replace(/'/g, "''")}')
             OR UPPER(rc.REGION_KEY) = UPPER('${config.region.replace(/'/g, "''")}'))
      ORDER BY COALESCE(rc.BOUNDARY_AREA_KM2, 1e15) ASC
      LIMIT 1
    )
    SELECT p.ID AS LOCATION_ID, p.NAMES::VARIANT:primary AS NAME,
           p.BASIC_CATEGORY AS CATEGORY,
           ST_Y(p.GEOMETRY) AS LAT, ST_X(p.GEOMETRY) AS LNG
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
      LEFT JOIN region_boundary rb ON TRUE
    WHERE ST_Y(p.GEOMETRY) BETWEEN ${bbox.min_lat} AND ${bbox.max_lat}
      AND ST_X(p.GEOMETRY) BETWEEN ${bbox.min_lng} AND ${bbox.max_lng}
      AND p.BASIC_CATEGORY IN (${catFilter})${countryFilter}
      AND COALESCE(ST_INTERSECTS(p.GEOMETRY, rb.BOUNDARY), TRUE)
    LIMIT 5000`;
  log('INFO', 'Studio', `Loading POIs from Overture Maps`, {
    detail: { categories: cats, bbox, mode: config.mode, region: config.region, countryCodes, sql: sql.trim().replace(/\s+/g, ' ') },
  });
  try {
    const rows = await snowSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
    if (rows.length > 0) {
      const pois = rows.map((r: any) => ({
        location_id: r.LOCATION_ID || uuid(Math.random),
        name: r.NAME || 'Unknown',
        location_type: mapCategoryToType(r.CATEGORY || '', config.mode),
        lat: Number(r.LAT),
        lng: Number(r.LNG),
        category: r.CATEGORY || '',
      }));
      const catCounts: Record<string, number> = {};
      const typeCounts: Record<string, number> = {};
      for (const p of pois) {
        catCounts[p.category] = (catCounts[p.category] || 0) + 1;
        typeCounts[p.location_type] = (typeCounts[p.location_type] || 0) + 1;
      }
      log('INFO', 'Studio', `Loaded ${pois.length} POIs from Overture Maps`, {
        detail: { source: 'overture', categories: catCounts, types: typeCounts },
      });
      const sanitized = await filterRoutablePois(pois, config.ors_profile, config.region, bbox, snowSql, onLog);
      return sanitized;
    }
    log('ERROR', 'Studio', `Overture Maps returned 0 POIs for bbox`, {
      detail: { bbox, categories: cats },
    });
    throw new Error(
      `No POIs found in Overture Maps for region bbox ` +
      `[${bbox.min_lat},${bbox.min_lng} to ${bbox.max_lat},${bbox.max_lng}] ` +
      `with categories [${cats.join(', ')}]. Expand the bbox or change categories.`
    );
  } catch (e: any) {
    if (e.message?.startsWith('No POIs found')) throw e;
    log('ERROR', 'Studio', `Overture Maps query failed`, {
      detail: { error: e.message?.slice(0, 200), bbox, categories: cats },
    });
    throw new Error(
      `Cannot load POIs: Overture Maps is not accessible. ` +
      `Ensure the OVERTURE_MAPS__PLACES share is mounted. Error: ${e.message?.slice(0, 200)}`
    );
  }
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

function mapCategoryToType(category: string, mode: string): string {
  if (mode === 'food_delivery') {
    if (['restaurant', 'fast_food_restaurant', 'cafe', 'bakery', 'pizzaria', 'casual_eatery', 'coffee_shop', 'sandwich_shop', 'chicken_restaurant'].includes(category)) return 'RESTAURANT';
    return 'ADDRESS';
  }
  if (mode === 'trucking') {
    if (['warehouse', 'storage_facility', 'b2b_transportation_and_storage_service', 'industrial_facility_or_service'].includes(category)) return 'WAREHOUSE';
    if (['gas_station', 'parking', 'transportation_location', 'ground_transport_facility_or_service'].includes(category)) return 'REST_STOP';
    return 'DESTINATION';
  }
  return 'LOCATION';
}

export function buildFleet(config: GenerationConfig, pois: POI[], rng: () => number): FleetMember[] {
  const fleet: FleetMember[] = [];
  const { num_vehicles } = config.fleet;
  const profiles = Object.entries(config.driver_profiles);
  const homePois = pois.filter(p =>
    config.mode === 'food_delivery' ? p.location_type === 'RESTAURANT' :
    config.mode === 'trucking' ? p.location_type === 'WAREHOUSE' :
    true
  );
  if (homePois.length === 0) homePois.push(...pois.slice(0, Math.min(10, pois.length)));

  const vt = resolveVehicleType(config);

  for (let i = 0; i < num_vehicles; i++) {
    let profileType = 'COMPLIANT';
    let profileCfg = profiles[0][1];
    const r = rng();
    let cumulative = 0;
    for (const [name, cfg] of profiles) {
      cumulative += cfg.proportion;
      if (r < cumulative) { profileType = name; profileCfg = cfg; break; }
    }

    const shiftIdx = i % config.shifts.length;
    const shift = config.shifts[shiftIdx];
    const home = homePois[i % homePois.length];
    const baseSpeed = vt === 'ebike' ? rngFloat(rng, 15, 22)
      : vt === 'hgv' ? rngFloat(rng, 60, 85)
      : rngFloat(rng, 30, 55);

    fleet.push({
      vehicle_id: `V-${config.ors_profile.slice(0, 3).toUpperCase()}-${i.toString().padStart(5, '0')}`,
      driver_id: `DRV-${i.toString().padStart(5, '0')}`,
      home_poi: home,
      shift_start: shift.start,
      shift_end: shift.end,
      profile_type: profileType,
      detour_prob: profileCfg.detour_probability,
      speeding_prob: profileCfg.speeding_probability,
      hos_violation_prob: profileCfg.hos_violation_probability || 0,
      speed_variance: profileCfg.speed_variance,
      base_speed_kmh: baseSpeed,
      vehicle_type: vt,
      battery_pct: vt === 'ebike' ? 100 : -1,
    });
  }

  // Tag a configurable share of the fleet as "ghost" - they will sit idle at
  // their home POI for several days, replicating the non-moving-trailer pattern.
  const ghostCfg = config.ghost_trailer;
  if (ghostCfg && ghostCfg.probability > 0) {
    for (const member of fleet) {
      if (rng() < ghostCfg.probability) {
        const startDay = rngInt(rng, ghostCfg.start_day_min, ghostCfg.start_day_max);
        const duration = rngInt(rng, ghostCfg.duration_days_min, ghostCfg.duration_days_max);
        member.ghost_start_day = startDay;
        member.ghost_end_day = startDay + duration - 1;
      }
    }
  }
  return fleet;
}


async function fetchRoute(
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

async function fetchDetourRoute(
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

function pickDestination(
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

function pickNearestRoutableNeighbor(
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

function pickDetourWaypoint(
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

function interpolateRoute(
  route: RouteGeometry, config: GenerationConfig,
  lifecycle: VehicleLifecycle, tripId: string,
  destPoi: POI, rng: () => number, isDetour: boolean,
): TelemetryPoint[] {
  const points: TelemetryPoint[] = [];
  const coords = route.coordinates;
  if (coords.length < 2) return points;
  const vt = resolveVehicleType(config);

  const segments: number[] = [0];
  let totalDist = 0;
  for (let i = 1; i < coords.length; i++) {
    totalDist += haversineKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    segments.push(totalDist);
  }
  if (totalDist === 0) return points;

  const durationSec = route.duration_sec || (totalDist / (lifecycle.vehicle.base_speed_kmh / 3.6));
  const pingMean = config.telemetry.ping_interval_moving.mean_sec;
  const pingStd = config.telemetry.ping_interval_moving.std_sec;
  const jitterCfg = config.telemetry.gps_jitter;
  const postedSpeeds = config.routing.posted_speeds;
  const defaultSpeed = postedSpeeds.default || 30;
  const speedingThreshold = 1.08;

  let elapsed = 0;
  const vehicle = lifecycle.vehicle;
  const hosMaxDriveMin = config.breaks?.max_daily_driving_hours
    ? config.breaks.max_daily_driving_hours * 60 : Infinity;

  while (elapsed < durationSec) {
    if (vt === 'hgv' && lifecycle.dailyDrivingMin >= hosMaxDriveMin) {
      break;
    }

    const progress = Math.min(elapsed / durationSec, 1);
    const distAtProgress = progress * totalDist;

    let segIdx = 0;
    for (let i = 1; i < segments.length; i++) {
      if (segments[i] >= distAtProgress) { segIdx = i - 1; break; }
      segIdx = i - 1;
    }
    segIdx = Math.min(segIdx, coords.length - 2);
    const segStart = segments[segIdx];
    const segEnd = segments[segIdx + 1] || segStart + 0.001;
    const segFrac = (distAtProgress - segStart) / (segEnd - segStart);

    const lat = coords[segIdx][0] + segFrac * (coords[segIdx + 1][0] - coords[segIdx][0]);
    const lng = coords[segIdx][1] + segFrac * (coords[segIdx + 1][1] - coords[segIdx][1]);

    const speedFactor = 1 + (rng() - 0.5) * vehicle.speed_variance * 2;
    let speedKmh = vehicle.base_speed_kmh * speedFactor;
    if (progress < 0.1 || progress > 0.9) speedKmh *= 0.7;
    speedKmh = Math.max(5, Math.min(speedKmh, 130));
    const postedSpeed = defaultSpeed;
    const isSpeeding = rng() < vehicle.speeding_prob && speedKmh > postedSpeed * speedingThreshold;
    if (isSpeeding) speedKmh = postedSpeed * rngFloat(rng, 1.1, 1.25);

    const isHosViolation = vt === 'hgv' &&
      !!config.breaks?.max_daily_driving_hours &&
      lifecycle.dailyDrivingMin > config.breaks.max_daily_driving_hours * 60 &&
      rng() < vehicle.hos_violation_prob;

    const heading = calculateHeading(lat, lng,
      coords[Math.min(segIdx + 1, coords.length - 1)][0],
      coords[Math.min(segIdx + 1, coords.length - 1)][1]);

    const jitterM = rng() < jitterCfg.multipath_probability
      ? rngFloat(rng, 50, jitterCfg.multipath_max_m)
      : rngFloat(rng, 2, jitterCfg.typical_m);
    const [jLat, jLng] = addGpsJitter(lat, lng, jitterM, rng);

    const ts = new Date(lifecycle.currentTime.getTime() + elapsed * 1000);

    let batteryPct: number | null = null;
    if (vt === 'ebike' && config.battery) {
      const kmTraveled = distAtProgress;
      const drain = kmTraveled * config.battery.drain_per_km;
      batteryPct = Math.max(0, vehicle.battery_pct - drain);
    }

    lifecycle.odometerKm += (speedKmh / 3600) * pingMean;

    points.push({
      telemetry_id: uuid(rng),
      region: config.region,
      vehicle_type: vt,
      vehicle_id: vehicle.vehicle_id,
      trip_id: tripId,
      ts,
      latitude: jLat,
      longitude: jLng,
      speed_kmh: Math.round(speedKmh * 10) / 10,
      heading_deg: Math.round(heading * 10) / 10,
      posted_speed_kmh: postedSpeed,
      status: 'MOVING',
      is_speeding: isSpeeding,
      is_hos_violation: isHosViolation,
      is_detour: isDetour,
      gps_accuracy_m: jitterM,
      location_id: null,
      location_type: null,
      ors_profile: config.ors_profile,
      battery_pct: batteryPct,
      odometer_km: Math.round(lifecycle.odometerKm * 100) / 100,
      point_index: lifecycle.pointIndex++,
    });

    const interval = Math.max(5, pingMean + (rng() - 0.5) * 2 * pingStd);
    elapsed += interval;
  }

  lifecycle.lat = coords[coords.length - 1][0];
  lifecycle.lng = coords[coords.length - 1][1];
  lifecycle.currentTime = new Date(lifecycle.currentTime.getTime() + durationSec * 1000);
  lifecycle.dailyDrivingMin += durationSec / 60;
  lifecycle.minSinceBreak += durationSec / 60;

  if (vt === 'ebike' && config.battery) {
    const kmTraveled = totalDist;
    vehicle.battery_pct = Math.max(0, vehicle.battery_pct - kmTraveled * config.battery.drain_per_km);
  }

  return points;
}

function emitDwell(
  lifecycle: VehicleLifecycle, config: GenerationConfig, tripId: string | null,
  dwellConfig: DwellConfig, status: VehicleState, poi: POI | null,
  rng: () => number,
): TelemetryPoint[] {
  const points: TelemetryPoint[] = [];
  const vt = resolveVehicleType(config);
  let dwellMin = lognormalSample(dwellConfig.median_min, dwellConfig.sigma, dwellConfig.max_min, rng);
  if (dwellConfig.long_wait_probability && rng() < dwellConfig.long_wait_probability) {
    dwellMin = rngFloat(rng, dwellConfig.max_min, dwellConfig.max_min * 2);
  }
  const dwellSec = dwellMin * 60;
  const pingMin = config.telemetry.ping_interval_dwell.min_sec;
  const pingMax = config.telemetry.ping_interval_dwell.max_sec;

  let elapsed = 0;
  while (elapsed < dwellSec) {
    const [jLat, jLng] = addGpsJitter(lifecycle.lat, lifecycle.lng, 3, rng);
    const ts = new Date(lifecycle.currentTime.getTime() + elapsed * 1000);
    points.push({
      telemetry_id: uuid(rng),
      region: config.region,
      vehicle_type: vt,
      vehicle_id: lifecycle.vehicle.vehicle_id,
      trip_id: tripId,
      ts,
      latitude: jLat,
      longitude: jLng,
      speed_kmh: 0,
      heading_deg: 0,
      posted_speed_kmh: 0,
      status,
      is_speeding: false,
      is_hos_violation: false,
      is_detour: false,
      gps_accuracy_m: 3,
      location_id: poi?.location_id || null,
      location_type: poi?.location_type || null,
      ors_profile: config.ors_profile,
      battery_pct: lifecycle.vehicle.battery_pct > 0 ? lifecycle.vehicle.battery_pct : null,
      odometer_km: Math.round(lifecycle.odometerKm * 100) / 100,
      point_index: lifecycle.pointIndex++,
    });
    elapsed += rngFloat(rng, pingMin, pingMax);
  }
  lifecycle.currentTime = new Date(lifecycle.currentTime.getTime() + dwellSec * 1000);
  lifecycle.state = status;
  lifecycle.location_id = poi?.location_id || null;
  lifecycle.location_type = poi?.location_type || null;
  return points;
}

// Emit a single multi-day IDLE dwell session for "ghost trailers". Pings are
// sparse (default 5-15 min) so the row volume stays modest even over a 7-day
// window. The dwell sessionizer (CONDITIONAL_CHANGE_EVENT on STATUS) will roll
// these contiguous IDLE pings into one DT_DWELL_SESSIONS row.
function emitLongIdleDwell(
  lifecycle: VehicleLifecycle, config: GenerationConfig, poi: POI | null,
  durationSec: number, pingMinSec: number, pingMaxSec: number, rng: () => number,
): TelemetryPoint[] {
  const points: TelemetryPoint[] = [];
  const vt = resolveVehicleType(config);
  let elapsed = 0;
  while (elapsed < durationSec) {
    const [jLat, jLng] = addGpsJitter(lifecycle.lat, lifecycle.lng, 2, rng);
    const ts = new Date(lifecycle.currentTime.getTime() + elapsed * 1000);
    points.push({
      telemetry_id: uuid(rng),
      region: config.region,
      vehicle_type: vt,
      vehicle_id: lifecycle.vehicle.vehicle_id,
      trip_id: null,
      ts,
      latitude: jLat,
      longitude: jLng,
      speed_kmh: 0,
      heading_deg: 0,
      posted_speed_kmh: 0,
      status: 'IDLE',
      is_speeding: false,
      is_hos_violation: false,
      is_detour: false,
      gps_accuracy_m: 3,
      location_id: poi?.location_id || null,
      location_type: poi?.location_type || null,
      ors_profile: config.ors_profile,
      battery_pct: lifecycle.vehicle.battery_pct > 0 ? lifecycle.vehicle.battery_pct : null,
      odometer_km: Math.round(lifecycle.odometerKm * 100) / 100,
      point_index: lifecycle.pointIndex++,
    });
    elapsed += rngFloat(rng, pingMinSec, pingMaxSec);
  }
  lifecycle.currentTime = new Date(lifecycle.currentTime.getTime() + durationSec * 1000);
  lifecycle.state = 'IDLE';
  lifecycle.location_id = poi?.location_id || null;
  lifecycle.location_type = poi?.location_type || null;
  return points;
}

export async function* generateTelemetry(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  onProgress?: (p: GenerationProgress) => void,
  abortSignal?: { aborted: boolean },
  onLog?: (msg: string) => void,
): AsyncGenerator<GenerationEvent, void, void> {
  const rng = createRng(config.time.start_date.length * 31 + config.fleet.num_vehicles);
  const vt = resolveVehicleType(config);
  log('INFO', 'Studio', `Starting generation for ${config.region}`, {
    detail: {
      vehicleType: vt, profile: config.ors_profile, mode: config.mode,
      vehicles: config.fleet.num_vehicles, tripsPerDay: config.fleet.trips_per_day,
      days: config.time.start_date + ' to ' + config.time.end_date,
      bbox: config.bbox,
      driverProfiles: Object.keys(config.driver_profiles),
    },
  });
  const pois = await loadPOIs(config, snowSql, onLog);

  // Pre-flight probe: confirm at least 3 of 5 random POI pairs actually route on the
  // active graph before we burn time generating telemetry. This catches both the
  // historical Germany/CH border-leak and any other graph/POI mismatch (wrong profile,
  // unprovisioned region, partial graph).
  const probe = await probeRoutability(pois, config.ors_profile, config.region, snowSql, { rng });
  log('INFO', 'Studio', `Pre-flight POI routability probe: ${probe.success}/${probe.total} succeeded`, {
    detail: { region: config.region, profile: config.ors_profile, failures: probe.failures.slice(0, 3) },
  });
  onLog?.(`Pre-flight routability: ${probe.success}/${probe.total} of random POI pairs routed`);
  if (!probe.ok) {
    const sample = probe.failures.slice(0, 3).map(f => `(${f.origin[0].toFixed(4)},${f.origin[1].toFixed(4)})->(${f.dest[0].toFixed(4)},${f.dest[1].toFixed(4)}):${f.reason}`).join('; ');
    throw new Error(
      `POI/graph mismatch: only ${probe.success}/${probe.total} pre-flight pairs routed for ` +
      `region=${config.region} profile=${config.ors_profile}. ` +
      `Likely causes: bbox extends beyond country graph, wrong profile for region, or graph not yet ready. ` +
      `Sample failures: ${sample}`
    );
  }

  const fleet = buildFleet(config, pois, rng);
  const profileBreakdown: Record<string, number> = {};
  for (const m of fleet) profileBreakdown[m.profile_type] = (profileBreakdown[m.profile_type] || 0) + 1;
  const shiftBreakdown: Record<string, number> = {};
  for (const m of fleet) {
    const key = `${m.shift_start}:00-${m.shift_end}:00`;
    shiftBreakdown[key] = (shiftBreakdown[key] || 0) + 1;
  }
  log('INFO', 'Studio', `Built fleet of ${fleet.length} ${vt} vehicles`, {
    detail: { driverProfiles: profileBreakdown, shifts: shiftBreakdown, homePoisUsed: new Set(fleet.map(m => m.home_poi.location_id)).size },
  });

  const startDate = new Date(config.time.start_date + 'T00:00:00Z');
  const endDate = new Date(config.time.end_date + 'T23:59:59Z');
  const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000);
  let totalPoints = 0;
  let totalTrips = 0;
  let routeSuccesses = 0;
  let routeFailures = 0;
  let consecutiveFails = 0;
  let unroutableSkips = 0;
  const unroutablePoiIds = new Set<string>();
  const MAX_CONSECUTIVE_FAILURES = 25;
  const MIN_ATTEMPTS_BEFORE_STOP = 20;
  const MAX_ROUTE_RETRIES = 3;
  const RECOVERY_THRESHOLD = 10;
  const RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;
  let lastRecoveryMs = 0;

  for (let dayOffset = 0; dayOffset < totalDays; dayOffset++) {
    if (abortSignal?.aborted) return;

    const currentDay = new Date(startDate.getTime() + dayOffset * 86400000);
    const isWeekend = currentDay.getUTCDay() === 0 || currentDay.getUTCDay() === 6;
    const dayBatch: TelemetryPoint[] = [];

    for (const member of fleet) {
      if (abortSignal?.aborted) return;

      // Ghost trailer handling - vehicle is parked at home for several days.
      const inGhostWindow = member.ghost_start_day !== undefined
        && member.ghost_end_day !== undefined
        && dayOffset >= member.ghost_start_day
        && dayOffset <= member.ghost_end_day;
      if (inGhostWindow) {
        // On any ghost day other than the first, the long-idle pings were
        // already emitted on the start day - skip silently.
        if (dayOffset !== member.ghost_start_day) continue;
        const ghostCfg = config.ghost_trailer!;
        const totalGhostDays = (member.ghost_end_day! - member.ghost_start_day!) + 1;
        const ghostStartTime = new Date(Date.UTC(currentDay.getUTCFullYear(), currentDay.getUTCMonth(), currentDay.getUTCDate(), 0, rngInt(rng, 0, 30)));
        const ghostLifecycle: VehicleLifecycle = {
          vehicle: { ...member, battery_pct: vt === 'ebike' ? 100 : -1 },
          lat: member.home_poi.lat,
          lng: member.home_poi.lng,
          currentTime: ghostStartTime,
          state: 'IDLE',
          location_id: member.home_poi.location_id,
          location_type: member.home_poi.location_type,
          dailyDrivingMin: 0,
          minSinceBreak: 0,
          tripSeq: 0,
          odometerKm: 0,
          pointIndex: 0,
        };
        const durationSec = totalGhostDays * 86400;
        dayBatch.push(...emitLongIdleDwell(
          ghostLifecycle, config, member.home_poi,
          durationSec, ghostCfg.ping_interval_min_sec, ghostCfg.ping_interval_max_sec, rng,
        ));
        continue;
      }

      const operatingRate = config.fleet.daily_operating_rate
        || (isWeekend ? (config.fleet.weekend_operating_rate || 0.4) : (config.fleet.weekday_operating_rate || 0.85));
      if (rng() > operatingRate) continue;

      const shiftStart = member.shift_start;
      const lifecycle: VehicleLifecycle = {
        vehicle: { ...member, battery_pct: vt === 'ebike' ? 100 : -1 },
        lat: member.home_poi.lat,
        lng: member.home_poi.lng,
        currentTime: new Date(Date.UTC(currentDay.getUTCFullYear(), currentDay.getUTCMonth(), currentDay.getUTCDate(), shiftStart, rngInt(rng, 0, 30))),
        state: 'DWELL_ORIGIN',
        location_id: member.home_poi.location_id,
        location_type: member.home_poi.location_type,
        dailyDrivingMin: 0,
        minSinceBreak: 0,
        tripSeq: 0,
        odometerKm: 0,
        pointIndex: 0,
      };

      const numTrips = rngInt(rng, config.fleet.trips_per_day.min, config.fleet.trips_per_day.max);
      let currentOriginPoi = member.home_poi;

      for (let t = 0; t < numTrips; t++) {
        if (abortSignal?.aborted) return;
        const shiftEnd = member.shift_end < member.shift_start ? member.shift_end + 24 : member.shift_end;
        const currentHour = lifecycle.currentTime.getHours() + (lifecycle.currentTime.getHours() < member.shift_start ? 24 : 0);
        if (currentHour >= shiftEnd) break;

        if (config.breaks && lifecycle.minSinceBreak >= config.breaks.driving_hours_between_breaks * 60) {
          const breakDwell: DwellConfig = { median_min: config.breaks.mandatory_break_duration_min, sigma: 0.2, max_min: config.breaks.mandatory_break_duration_min * 1.5 };
          const restPois = pois.filter(p => p.location_type === 'REST_STOP');
          const breakPoi = restPois.length > 0 ? restPois[Math.floor(rng() * restPois.length)] : currentOriginPoi;
          dayBatch.push(...emitDwell(lifecycle, config, null, breakDwell, 'DWELL_REST', breakPoi, rng));
          lifecycle.minSinceBreak = 0;
        }

        if (config.breaks?.max_daily_driving_hours && lifecycle.dailyDrivingMin >= config.breaks.max_daily_driving_hours * 60) break;

        if (vt === 'ebike' && config.battery && lifecycle.vehicle.battery_pct <= (config.battery.recharge_threshold_pct || 15)) {
          const rechargeDwell: DwellConfig = { median_min: 20, sigma: 0.3, max_min: 40 };
          dayBatch.push(...emitDwell(lifecycle, config, null, rechargeDwell, 'DWELL_RECHARGE', currentOriginPoi, rng));
          lifecycle.vehicle.battery_pct = 100;
        }

        let destPoi = pickDestination(currentOriginPoi, pois, config, rng);
        const tripId = uuid(rng);
        const tripStartTime = new Date(lifecycle.currentTime);

        const originDwellKey = config.mode === 'food_delivery' ? 'origin' : (currentOriginPoi.location_type === 'WAREHOUSE' ? 'warehouse' : 'origin');
        let originDwell = config.dwell[originDwellKey];
        if (!originDwell || !('median_min' in originDwell)) {
          originDwell = { median_min: 5, sigma: 0.5, max_min: 20 };
        }
        dayBatch.push(...emitDwell(lifecycle, config, tripId, originDwell as DwellConfig, 'DWELL_ORIGIN', currentOriginPoi, rng));

        const detourProb = config.detour?.probability ?? config.routing.detour_probability ?? 0.05;
        const shouldDetour = rng() < detourProb;
        let plannedRoute: RouteGeometry | null = null;
        let actualRoute: RouteGeometry | null = null;
        let isDetour = false;
        let attemptsUnroutable = 0;
        let attemptsHardFail = 0;

        for (let attempt = 0; attempt < MAX_ROUTE_RETRIES; attempt++) {
          const result = await fetchRoute(lifecycle.lat, lifecycle.lng, destPoi.lat, destPoi.lng, config.ors_profile, config.region, snowSql);
          if (result && result !== 'UNROUTABLE') {
            plannedRoute = result;
            break;
          }
          if (result === 'UNROUTABLE') {
            attemptsUnroutable++;
            if (destPoi.location_id) unroutablePoiIds.add(destPoi.location_id);
            if (currentOriginPoi.location_id) unroutablePoiIds.add(currentOriginPoi.location_id);
          } else {
            attemptsHardFail++;
          }
          if (attempt < MAX_ROUTE_RETRIES - 1) {
            const candidatePois = pois.filter(p => !unroutablePoiIds.has(p.location_id));
            const fromPois = candidatePois.length > 10 ? candidatePois : pois;
            destPoi = pickDestination(currentOriginPoi, fromPois, config, rng);
            if (attempt === MAX_ROUTE_RETRIES - 2) {
              const nearbyPoi = pickNearestRoutableNeighbor(currentOriginPoi, fromPois, rng);
              if (nearbyPoi) {
                currentOriginPoi = nearbyPoi;
                lifecycle.lat = nearbyPoi.lat;
                lifecycle.lng = nearbyPoi.lng;
                lifecycle.location_id = nearbyPoi.location_id;
                lifecycle.location_type = nearbyPoi.location_type;
              }
            }
          }
        }

        if (plannedRoute) {
          routeSuccesses++;
          consecutiveFails = 0;
          totalTrips++;
        } else if (attemptsHardFail === 0 && attemptsUnroutable > 0) {
          unroutableSkips++;
          continue;
        } else {
          routeFailures++;
          consecutiveFails++;
          if (consecutiveFails >= RECOVERY_THRESHOLD && Date.now() - lastRecoveryMs > RECOVERY_COOLDOWN_MS) {
            lastRecoveryMs = Date.now();
            log('WARN', 'Studio', `${consecutiveFails} consecutive failures, attempting ORS service recovery...`, {
              detail: { region: config.region, profile: config.ors_profile, routeSuccesses },
            });
            try {
              await snowSql('ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME');
              // v1.1.0: bare ORS_SERVICE removed; resume per-region service for the
              // active region (defaults to SANFRANCISCO when region is missing).
              const recoveryRegion = (config.region || 'SanFrancisco').replace(/\s+/g, '').toUpperCase();
              await snowSql(`ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE_${recoveryRegion} RESUME`);
              await new Promise(resolve => setTimeout(resolve, 30000));
              log('INFO', 'Studio', 'ORS recovery attempt complete, resuming generation');
            } catch (e: any) {
              log('WARN', 'Studio', `ORS recovery failed: ${e.message?.slice(0, 200)}`);
            }
          }
          const totalAttempts = routeSuccesses + routeFailures;
          if (consecutiveFails >= MAX_CONSECUTIVE_FAILURES && totalAttempts >= MIN_ATTEMPTS_BEFORE_STOP && routeSuccesses === 0) {
            log('ERROR', 'Studio', `ORS unavailable: ${routeFailures} consecutive failures, 0 successes`, {
              detail: { region: config.region, profile: config.ors_profile },
            });
            throw new Error(
              `ORS unavailable: ${routeFailures} consecutive route requests failed. ` +
              `Check that ORS is running and "${config.ors_profile}" is built for "${config.region}".`
            );
          }
          if (consecutiveFails >= MAX_CONSECUTIVE_FAILURES && totalAttempts >= MIN_ATTEMPTS_BEFORE_STOP) {
            log('WARN', 'Studio', `Stopping: ${consecutiveFails} consecutive failures after ${routeSuccesses} successes`, {
              detail: { region: config.region, profile: config.ors_profile, totalAttempts },
            });
            totalPoints += dayBatch.length;
            if (dayBatch.length > 0) {
              yield { type: 'telemetry', points: dayBatch } as GenerationEvent;
            }
            yield {
              type: 'stopped',
              reason: `Stopped after ${consecutiveFails} consecutive route failures ` +
                      `(profile=${config.ors_profile}, region=${config.region}, ` +
                      `${routeSuccesses}/${routeSuccesses + routeFailures} routes succeeded). ` +
                      `If ORS is healthy, many POIs may be unroutable for this profile.`,
              completedDays: dayOffset,
              totalDays,
              routeSuccesses,
              routeFailures,
            } as GenerationEvent;
            return;
          }
          break;
        }

        if (shouldDetour && plannedRoute) {
          const waypoint = pickDetourWaypoint(currentOriginPoi, destPoi, pois, rng);
          if (waypoint) {
            const detoured = await fetchDetourRoute(
              lifecycle.lat, lifecycle.lng,
              waypoint.lat, waypoint.lng,
              destPoi.lat, destPoi.lng,
              config.ors_profile, config.region, snowSql
            );
            if (detoured && detoured !== 'UNROUTABLE' && detoured.coordinates.length >= 2) {
              actualRoute = detoured;
              isDetour = true;
            } else if (detoured === 'UNROUTABLE' && waypoint.location_id) {
              unroutablePoiIds.add(waypoint.location_id);
            }
          }
        }

        const routeToFollow = actualRoute || plannedRoute;

        if (routeToFollow && routeToFollow.coordinates.length >= 2) {
          lifecycle.state = 'MOVING';
          dayBatch.push(...interpolateRoute(routeToFollow, config, lifecycle, tripId, destPoi, rng, isDetour));
        } else {
          lifecycle.lat = destPoi.lat;
          lifecycle.lng = destPoi.lng;
          lifecycle.currentTime = new Date(lifecycle.currentTime.getTime() + rngInt(rng, 300, 1200) * 1000);
        }

        const destDwellKey = 'destination';
        let destDwell = config.dwell[destDwellKey];
        if (!destDwell || !('median_min' in destDwell)) {
          destDwell = { median_min: 3, sigma: 0.5, max_min: 15 };
        }
        dayBatch.push(...emitDwell(lifecycle, config, tripId, destDwell as DwellConfig, 'DWELL_DESTINATION', destPoi, rng));

        const tripEndTime = new Date(lifecycle.currentTime);
        const actualDistKm = routeToFollow ? routeToFollow.distance_m / 1000 : haversineKm(currentOriginPoi.lat, currentOriginPoi.lng, destPoi.lat, destPoi.lng);
        const plannedDistKm = plannedRoute ? plannedRoute.distance_m / 1000 : actualDistKm;
        const durationMin = (tripEndTime.getTime() - tripStartTime.getTime()) / 60000;

        if (routeToFollow && routeToFollow.coordinates.length >= 2) {
          const tripRecord: TripRecord = {
            trip_id: tripId,
            vehicle_id: member.vehicle_id,
            driver_id: member.driver_id,
            vehicle_type: vt,
            region: config.region,
            origin_poi_id: currentOriginPoi.location_id,
            destination_poi_id: destPoi.location_id,
            origin_lat: currentOriginPoi.lat,
            origin_lon: currentOriginPoi.lng,
            destination_lat: destPoi.lat,
            destination_lon: destPoi.lng,
            route_coordinates: routeToFollow.coordinates as [number, number][],
            distance_km: Math.round(actualDistKm * 100) / 100,
            duration_minutes: Math.round(durationMin * 100) / 100,
            planned_route_coordinates: isDetour && plannedRoute ? plannedRoute.coordinates as [number, number][] : null,
            planned_distance_km: isDetour ? Math.round(plannedDistKm * 100) / 100 : null,
            is_detour: isDetour,
            detour_distance_km: isDetour ? Math.round((actualDistKm - plannedDistKm) * 100) / 100 : null,
            trip_start: tripStartTime,
            trip_end: tripEndTime,
            status: 'COMPLETED',
            ors_profile: config.ors_profile,
          };
          yield { type: 'trip', record: tripRecord };
        }

        currentOriginPoi = destPoi;
        lifecycle.tripSeq++;
      }

      const idleDwell = config.dwell.idle;
      if (idleDwell && 'median_min' in idleDwell) {
        dayBatch.push(...emitDwell(lifecycle, config, null, idleDwell as DwellConfig, 'IDLE', currentOriginPoi, rng));
      }

      onProgress?.({
        day: dayOffset + 1,
        totalDays,
        vehicleId: member.vehicle_id,
        pointsToday: dayBatch.length,
        totalPoints: totalPoints + dayBatch.length,
        totalTrips,
        routeSuccesses,
        routeFailures,
        unroutableSkips,
        unroutablePois: unroutablePoiIds.size,
        status: `Day ${dayOffset + 1}: ${member.vehicle_id} (${dayBatch.length} pts, ${totalTrips} trips)`,
      });
    }

    totalPoints += dayBatch.length;
    const unroutableSuffix = unroutableSkips > 0 ? `, ${unroutableSkips} unroutable POI skips (${unroutablePoiIds.size} unique)` : '';
    onProgress?.({
      day: dayOffset + 1,
      totalDays,
      pointsToday: dayBatch.length,
      totalPoints,
      totalTrips,
      routeSuccesses,
      routeFailures,
      unroutableSkips,
      unroutablePois: unroutablePoiIds.size,
      status: `Day ${dayOffset + 1}/${totalDays} complete: ${dayBatch.length.toLocaleString()} points, ${totalTrips} trips${unroutableSuffix}`,
    });

    if (dayBatch.length > 0) {
      yield { type: 'telemetry', points: dayBatch };
    }
  }
}
