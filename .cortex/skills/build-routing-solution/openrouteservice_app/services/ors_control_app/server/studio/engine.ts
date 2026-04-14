import {
  GenerationConfig, DwellConfig, haversineKm, lognormalSample,
  calculateHeading, addGpsJitter, createRng, rngInt, rngFloat, uuid,
  resolveVehicleType, VehicleType,
} from './profiles.js';
import { log } from '../diagnostics.js';

export interface TelemetryPoint {
  telemetry_id: string;
  region: string;
  vehicle_type: string;
  vehicle_id: string;
  trip_id: string | null;
  ts: Date;
  latitude: number;
  longitude: number;
  speed_kmh: number;
  heading_deg: number;
  posted_speed_kmh: number;
  status: string;
  is_speeding: boolean;
  is_hos_violation: boolean;
  is_detour: boolean;
  gps_accuracy_m: number;
  location_id: string | null;
  location_type: string | null;
  ors_profile: string;
  battery_pct: number | null;
  odometer_km: number | null;
  point_index: number | null;
}

export interface TripRecord {
  trip_id: string;
  vehicle_id: string;
  driver_id: string;
  vehicle_type: string;
  region: string;
  origin_poi_id: string;
  destination_poi_id: string;
  origin_lat: number;
  origin_lon: number;
  destination_lat: number;
  destination_lon: number;
  route_coordinates: [number, number][];
  distance_km: number;
  duration_minutes: number;
  planned_route_coordinates: [number, number][] | null;
  planned_distance_km: number | null;
  is_detour: boolean;
  detour_distance_km: number | null;
  trip_start: Date;
  trip_end: Date;
  status: string;
  ors_profile: string;
}

export type GenerationEvent =
  | { type: 'telemetry'; points: TelemetryPoint[] }
  | { type: 'trip'; record: TripRecord }
  | { type: 'stopped'; reason: string; completedDays: number; totalDays: number; routeSuccesses: number; routeFailures: number };

export interface POI {
  location_id: string;
  name: string;
  location_type: string;
  lat: number;
  lng: number;
  category: string;
}

export interface RouteGeometry {
  coordinates: [number, number][];
  distance_m: number;
  duration_sec: number;
}

export interface FleetMember {
  vehicle_id: string;
  driver_id: string;
  home_poi: POI;
  shift_start: number;
  shift_end: number;
  profile_type: string;
  detour_prob: number;
  speeding_prob: number;
  hos_violation_prob: number;
  speed_variance: number;
  base_speed_kmh: number;
  vehicle_type: string;
  battery_pct: number;
}

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

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

export interface GenerationProgress {
  day: number;
  totalDays: number;
  vehicleId?: string;
  pointsToday: number;
  totalPoints: number;
  totalTrips: number;
  routeSuccesses: number;
  routeFailures: number;
  status: string;
}

export async function loadPOIs(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
): Promise<POI[]> {
  const { bbox } = config;
  const cats = config.poi_categories || ['restaurant', 'bar', 'hotel', 'corporate_or_business_office'];
  const catFilter = cats.map(c => `'${c}'`).join(',');
  const sql = `
    SELECT ID AS LOCATION_ID, NAMES::VARIANT:primary AS NAME,
           BASIC_CATEGORY AS CATEGORY,
           ST_Y(GEOMETRY) AS LAT, ST_X(GEOMETRY) AS LNG
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
    WHERE ST_Y(GEOMETRY) BETWEEN ${bbox.min_lat} AND ${bbox.max_lat}
      AND ST_X(GEOMETRY) BETWEEN ${bbox.min_lng} AND ${bbox.max_lng}
      AND BASIC_CATEGORY IN (${catFilter})
    LIMIT 5000`;
  log('INFO', 'Studio', `Loading POIs from Overture Maps`, {
    detail: { categories: cats, bbox, mode: config.mode, sql: sql.trim().replace(/\s+/g, ' ') },
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
      return pois;
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
  return fleet;
}

async function fetchRoute(
  originLat: number, originLng: number,
  destLat: number, destLng: number,
  profile: string,
  snowSql: SnowSqlFn,
): Promise<RouteGeometry | null> {
  const sql = `
    SELECT TO_VARCHAR(ST_ASGEOJSON(GEOJSON)) AS GEO_STR, DISTANCE, DURATION
    FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS(
      '${profile}',
      ARRAY_CONSTRUCT(${originLng},${originLat}),
      ARRAY_CONSTRUCT(${destLng},${destLat})
    ))`;
  try {
    const rows = await snowSql(sql);
    if (!rows.length) {
      log('WARN', 'Studio', 'Route returned empty result', {
        detail: { origin: [originLat, originLng], dest: [destLat, destLng], profile },
      });
      return null;
    }
    const geo = typeof rows[0].GEO_STR === 'string' ? JSON.parse(rows[0].GEO_STR) : rows[0].GEO_STR;
    const coords: [number, number][] = geo?.coordinates || [];
    if (coords.length < 2) return null;
    return {
      coordinates: coords.map(c => [c[1], c[0]]),
      distance_m: Number(rows[0].DISTANCE) || 0,
      duration_sec: Number(rows[0].DURATION) || 0,
    };
  } catch (e: any) {
    log('WARN', 'Studio', `Route fetch failed: ${e.message?.slice(0, 300)}`, {
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
  snowSql: SnowSqlFn,
): Promise<RouteGeometry | null> {
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
      PARSE_JSON('${coordsJson}')::VARIANT
    ))`;
  try {
    const rows = await snowSql(sql);
    if (!rows.length) return null;
    const geo = typeof rows[0].GEO_STR === 'string' ? JSON.parse(rows[0].GEO_STR) : rows[0].GEO_STR;
    const coords: [number, number][] = geo?.coordinates || [];
    if (coords.length < 2) return null;
    return {
      coordinates: coords.map(c => [c[1], c[0]]),
      distance_m: Number(rows[0].DISTANCE) || 0,
      duration_sec: Number(rows[0].DURATION) || 0,
    };
  } catch (e: any) {
    log('WARN', 'Studio', `Detour route fetch failed: ${e.message?.slice(0, 300)}`, {
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

export async function* generateTelemetry(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
  onProgress?: (p: GenerationProgress) => void,
  abortSignal?: { aborted: boolean },
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
  const pois = await loadPOIs(config, snowSql);

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
  const MAX_CONSECUTIVE_FAILURES = 25;
  const MIN_ATTEMPTS_BEFORE_STOP = 20;
  const MAX_ROUTE_RETRIES = 3;
  const RECOVERY_THRESHOLD = 10;
  let recoveryAttempted = false;

  for (let dayOffset = 0; dayOffset < totalDays; dayOffset++) {
    if (abortSignal?.aborted) return;

    const currentDay = new Date(startDate.getTime() + dayOffset * 86400000);
    const isWeekend = currentDay.getUTCDay() === 0 || currentDay.getUTCDay() === 6;
    const dayBatch: TelemetryPoint[] = [];

    for (const member of fleet) {
      if (abortSignal?.aborted) return;

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

        for (let attempt = 0; attempt < MAX_ROUTE_RETRIES; attempt++) {
          plannedRoute = await fetchRoute(lifecycle.lat, lifecycle.lng, destPoi.lat, destPoi.lng, config.ors_profile, snowSql);
          if (plannedRoute) break;
          if (attempt < MAX_ROUTE_RETRIES - 1) {
            destPoi = pickDestination(currentOriginPoi, pois, config, rng);
          }
        }

        if (plannedRoute) {
          routeSuccesses++;
          consecutiveFails = 0;
          totalTrips++;
        } else {
          routeFailures++;
          consecutiveFails++;
          if (consecutiveFails === RECOVERY_THRESHOLD && !recoveryAttempted) {
            recoveryAttempted = true;
            log('WARN', 'Studio', `${consecutiveFails} consecutive failures, attempting ORS service recovery...`, {
              detail: { region: config.region, profile: config.ors_profile, routeSuccesses },
            });
            try {
              await snowSql('ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE RESUME');
              await snowSql('ALTER SERVICE IF EXISTS OPENROUTESERVICE_APP.CORE.ORS_SERVICE RESUME');
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
              reason: `ORS became unavailable after ${consecutiveFails} consecutive route failures`,
              completedDays: dayOffset,
              totalDays,
              routeSuccesses,
              routeFailures,
            } as GenerationEvent;
            return;
          }
        }

        if (shouldDetour && plannedRoute) {
          const waypoint = pickDetourWaypoint(currentOriginPoi, destPoi, pois, rng);
          if (waypoint) {
            const detoured = await fetchDetourRoute(
              lifecycle.lat, lifecycle.lng,
              waypoint.lat, waypoint.lng,
              destPoi.lat, destPoi.lng,
              config.ors_profile, snowSql
            );
            if (detoured && detoured.coordinates.length >= 2) {
              actualRoute = detoured;
              isDetour = true;
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
        status: `Day ${dayOffset + 1}: ${member.vehicle_id} (${dayBatch.length} pts, ${totalTrips} trips)`,
      });
    }

    totalPoints += dayBatch.length;
    onProgress?.({
      day: dayOffset + 1,
      totalDays,
      pointsToday: dayBatch.length,
      totalPoints,
      totalTrips,
      routeSuccesses,
      routeFailures,
      status: `Day ${dayOffset + 1}/${totalDays} complete: ${dayBatch.length.toLocaleString()} points, ${totalTrips} trips`,
    });

    if (dayBatch.length > 0) {
      yield { type: 'telemetry', points: dayBatch };
    }
  }
}
