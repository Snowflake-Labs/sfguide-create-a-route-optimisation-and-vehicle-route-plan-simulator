import {
  GenerationConfig, DwellConfig, haversineKm, lognormalSample,
  calculateHeading, addGpsJitter, createRng, rngInt, rngFloat, uuid,
} from './profiles.js';

export interface TelemetryPoint {
  telemetry_id: string;
  region: string;
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
  vehicle_type: string;
  battery_pct: number | null;
}

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

type VehicleState = 'MOVING' | 'DWELL_ORIGIN' | 'DWELL_DESTINATION' | 'DWELL_REST' | 'IDLE' | 'OVERNIGHT';

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
}

type SnowSqlFn = (sql: string, database?: string, schema?: string) => Promise<any[]>;

export interface GenerationProgress {
  day: number;
  totalDays: number;
  vehicleId?: string;
  pointsToday: number;
  totalPoints: number;
  totalTrips: number;
  status: string;
}

export async function loadPOIs(
  config: GenerationConfig,
  snowSql: SnowSqlFn,
): Promise<POI[]> {
  const { bbox } = config;
  const cats = config.poi_categories || ['restaurant', 'bar', 'hotel', 'office'];
  const catFilter = cats.map(c => `'${c}'`).join(',');
  const sql = `
    SELECT ID AS LOCATION_ID, NAMES::VARIANT:primary AS NAME,
           CATEGORIES::VARIANT[0]::STRING AS CATEGORY,
           ST_Y(GEOMETRY) AS LAT, ST_X(GEOMETRY) AS LNG
    FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
    WHERE ST_Y(GEOMETRY) BETWEEN ${bbox.min_lat} AND ${bbox.max_lat}
      AND ST_X(GEOMETRY) BETWEEN ${bbox.min_lng} AND ${bbox.max_lng}
      AND CATEGORIES::VARIANT[0]::STRING IN (${catFilter})
    LIMIT 5000`;
  try {
    const rows = await snowSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
    if (rows.length > 0) {
      return rows.map((r: any) => ({
        location_id: r.LOCATION_ID || uuid(Math.random),
        name: r.NAME || 'Unknown',
        location_type: mapCategoryToType(r.CATEGORY || '', config.mode),
        lat: Number(r.LAT),
        lng: Number(r.LNG),
        category: r.CATEGORY || '',
      }));
    }
  } catch (e: any) {
    console.log(`[Studio] Overture Maps not available (${e.message?.slice(0, 80)}), generating synthetic POIs`);
  }
  return generateSyntheticPOIs(config);
}

function mapCategoryToType(category: string, mode: string): string {
  if (mode === 'food_delivery') {
    if (['restaurant', 'fast_food', 'cafe', 'bakery', 'pizza', 'sushi'].includes(category)) return 'RESTAURANT';
    return 'ADDRESS';
  }
  if (mode === 'trucking') {
    if (['warehouse', 'industrial', 'logistics'].includes(category)) return 'WAREHOUSE';
    if (['fuel', 'rest_area', 'parking'].includes(category)) return 'REST_STOP';
    return 'DESTINATION';
  }
  return 'LOCATION';
}

function generateSyntheticPOIs(config: GenerationConfig): POI[] {
  const rng = createRng(42);
  const { bbox } = config;
  const pois: POI[] = [];
  const numPois = Math.max(200, config.fleet.num_vehicles * 10);
  const types = config.mode === 'food_delivery'
    ? ['RESTAURANT', 'ADDRESS']
    : config.mode === 'trucking'
      ? ['WAREHOUSE', 'DESTINATION', 'REST_STOP']
      : ['LOCATION'];

  for (let i = 0; i < numPois; i++) {
    const lat = rngFloat(rng, bbox.min_lat, bbox.max_lat);
    const lng = rngFloat(rng, bbox.min_lng, bbox.max_lng);
    const typeIdx = i % types.length;
    pois.push({
      location_id: `POI-${i.toString().padStart(5, '0')}`,
      name: `${types[typeIdx]}-${i}`,
      location_type: types[typeIdx],
      lat, lng,
      category: types[typeIdx].toLowerCase(),
    });
  }
  return pois;
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

  const vehicleType = config.ors_profile === 'cycling-electric' ? 'bicycle'
    : config.ors_profile === 'driving-hgv' ? 'truck' : 'car';

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
    const baseSpeed = vehicleType === 'bicycle' ? rngFloat(rng, 15, 22)
      : vehicleType === 'truck' ? rngFloat(rng, 60, 85)
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
      vehicle_type: vehicleType,
      battery_pct: vehicleType === 'bicycle' ? 100 : -1,
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
    SELECT OPENROUTESERVICE_NATIVE_APP.CORE.DIRECTIONS(
      '${profile}',
      OBJECT_CONSTRUCT('type','Point','coordinates',ARRAY_CONSTRUCT(${originLng},${originLat})),
      OBJECT_CONSTRUCT('type','Point','coordinates',ARRAY_CONSTRUCT(${destLng},${destLat})),
      'geojson'
    ) AS ROUTE`;
  try {
    const rows = await snowSql(sql);
    if (!rows.length) return null;
    const raw = typeof rows[0].ROUTE === 'string' ? JSON.parse(rows[0].ROUTE) : rows[0].ROUTE;
    const feature = raw?.features?.[0];
    if (!feature) return null;
    const coords: [number, number][] = feature.geometry?.coordinates || [];
    const summary = feature.properties?.summary || {};
    return {
      coordinates: coords.map(c => [c[1], c[0]]),
      distance_m: summary.distance || 0,
      duration_sec: summary.duration || 0,
    };
  } catch {
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

function interpolateRoute(
  route: RouteGeometry, config: GenerationConfig,
  lifecycle: VehicleLifecycle, tripId: string,
  destPoi: POI, rng: () => number,
): TelemetryPoint[] {
  const points: TelemetryPoint[] = [];
  const coords = route.coordinates;
  if (coords.length < 2) return points;

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

  while (elapsed < durationSec) {
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

    const heading = calculateHeading(lat, lng,
      coords[Math.min(segIdx + 1, coords.length - 1)][0],
      coords[Math.min(segIdx + 1, coords.length - 1)][1]);

    const jitterM = rng() < jitterCfg.multipath_probability
      ? rngFloat(rng, 50, jitterCfg.multipath_max_m)
      : rngFloat(rng, 2, jitterCfg.typical_m);
    const [jLat, jLng] = addGpsJitter(lat, lng, jitterM, rng);

    const ts = new Date(lifecycle.currentTime.getTime() + elapsed * 1000);

    points.push({
      telemetry_id: uuid(rng),
      region: config.region,
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
      is_hos_violation: false,
      is_detour: rng() < vehicle.detour_prob * 0.1,
      gps_accuracy_m: jitterM,
      location_id: null,
      location_type: null,
      ors_profile: config.ors_profile,
      vehicle_type: vehicle.vehicle_type,
      battery_pct: vehicle.battery_pct > 0 ? Math.max(0, vehicle.battery_pct - (totalDist * (config.battery?.drain_per_km || 0) * progress / 100)) * 100 / 100 : null,
    });

    const interval = Math.max(5, pingMean + (rng() - 0.5) * 2 * pingStd);
    elapsed += interval;
  }

  lifecycle.lat = coords[coords.length - 1][0];
  lifecycle.lng = coords[coords.length - 1][1];
  lifecycle.currentTime = new Date(lifecycle.currentTime.getTime() + durationSec * 1000);
  lifecycle.dailyDrivingMin += durationSec / 60;
  lifecycle.minSinceBreak += durationSec / 60;

  return points;
}

function emitDwell(
  lifecycle: VehicleLifecycle, config: GenerationConfig, tripId: string | null,
  dwellConfig: DwellConfig, status: VehicleState, poi: POI | null,
  rng: () => number,
): TelemetryPoint[] {
  const points: TelemetryPoint[] = [];
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
      vehicle_type: lifecycle.vehicle.vehicle_type,
      battery_pct: lifecycle.vehicle.battery_pct > 0 ? lifecycle.vehicle.battery_pct : null,
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
): AsyncGenerator<TelemetryPoint[], void, void> {
  const rng = createRng(config.time.start_date.length * 31 + config.fleet.num_vehicles);
  console.log(`[Studio] Loading POIs for ${config.region}...`);
  const pois = await loadPOIs(config, snowSql);
  console.log(`[Studio] Loaded ${pois.length} POIs`);

  const fleet = buildFleet(config, pois, rng);
  console.log(`[Studio] Built fleet of ${fleet.length} vehicles`);

  const startDate = new Date(config.time.start_date + 'T00:00:00');
  const endDate = new Date(config.time.end_date + 'T23:59:59');
  const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / 86400000);
  let totalPoints = 0;
  let totalTrips = 0;

  for (let dayOffset = 0; dayOffset < totalDays; dayOffset++) {
    if (abortSignal?.aborted) return;

    const currentDay = new Date(startDate.getTime() + dayOffset * 86400000);
    const isWeekend = currentDay.getDay() === 0 || currentDay.getDay() === 6;
    const dayBatch: TelemetryPoint[] = [];

    for (const member of fleet) {
      if (abortSignal?.aborted) return;

      const operatingRate = config.fleet.daily_operating_rate
        || (isWeekend ? (config.fleet.weekend_operating_rate || 0.4) : (config.fleet.weekday_operating_rate || 0.85));
      if (rng() > operatingRate) continue;

      const shiftStart = member.shift_start;
      const lifecycle: VehicleLifecycle = {
        vehicle: member,
        lat: member.home_poi.lat,
        lng: member.home_poi.lng,
        currentTime: new Date(currentDay.getFullYear(), currentDay.getMonth(), currentDay.getDate(), shiftStart, rngInt(rng, 0, 30)),
        state: 'DWELL_ORIGIN',
        location_id: member.home_poi.location_id,
        location_type: member.home_poi.location_type,
        dailyDrivingMin: 0,
        minSinceBreak: 0,
        tripSeq: 0,
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

        const destPoi = pickDestination(currentOriginPoi, pois, config, rng);
        const tripId = uuid(rng);
        totalTrips++;

        const originDwellKey = config.mode === 'food_delivery' ? 'origin' : (currentOriginPoi.location_type === 'WAREHOUSE' ? 'warehouse' : 'origin');
        let originDwell = config.dwell[originDwellKey];
        if (!originDwell || !('median_min' in originDwell)) {
          originDwell = { median_min: 5, sigma: 0.5, max_min: 20 };
        }
        dayBatch.push(...emitDwell(lifecycle, config, tripId, originDwell as DwellConfig, 'DWELL_ORIGIN', currentOriginPoi, rng));

        const route = await fetchRoute(lifecycle.lat, lifecycle.lng, destPoi.lat, destPoi.lng, config.ors_profile, snowSql);
        if (route && route.coordinates.length >= 2) {
          lifecycle.state = 'MOVING';
          dayBatch.push(...interpolateRoute(route, config, lifecycle, tripId, destPoi, rng));
        } else {
          lifecycle.lat = destPoi.lat;
          lifecycle.lng = destPoi.lng;
          lifecycle.currentTime = new Date(lifecycle.currentTime.getTime() + rngInt(rng, 300, 1200) * 1000);
        }

        const destDwellKey = config.mode === 'food_delivery' ? 'destination' : 'destination';
        let destDwell = config.dwell[destDwellKey];
        if (!destDwell || !('median_min' in destDwell)) {
          destDwell = { median_min: 3, sigma: 0.5, max_min: 15 };
        }
        dayBatch.push(...emitDwell(lifecycle, config, tripId, destDwell as DwellConfig, 'DWELL_DESTINATION', destPoi, rng));

        currentOriginPoi = destPoi;
        lifecycle.tripSeq++;
      }

      const idleDwell = config.dwell.idle;
      if (idleDwell && 'median_min' in idleDwell) {
        dayBatch.push(...emitDwell(lifecycle, config, null, idleDwell as DwellConfig, 'IDLE', currentOriginPoi, rng));
      }
    }

    totalPoints += dayBatch.length;
    onProgress?.({
      day: dayOffset + 1,
      totalDays,
      pointsToday: dayBatch.length,
      totalPoints,
      totalTrips,
      status: `Day ${dayOffset + 1}/${totalDays}: ${dayBatch.length.toLocaleString()} points`,
    });

    if (dayBatch.length > 0) {
      yield dayBatch;
    }
  }
}
