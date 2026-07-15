// Per-trip route interpolation. Walks the ORS-provided polyline at the
// configured ping cadence, emits a TelemetryPoint for each ping with realistic
// speed variation, GPS jitter, posted-speed/speeding flags, and HOS state.
// Mutates the provided VehicleLifecycle in place (advances time + odometer).

import type { POI, RouteGeometry, TelemetryPoint, VehicleLifecycle, VehicleState } from './types';
import {
  GenerationConfig, addGpsJitter, calculateHeading, haversineKm,
  resolveVehicleType, rngFloat, uuid,
} from '../profiles';

const DEFAULT_OVERNIGHT = {
  enabled: true as const,
  rest_hours_min: 10,
  rest_hours_max: 11,
  ping_interval_min_sec: 300,
  ping_interval_max_sec: 900,
};

function positionAtProgress(
  coords: [number, number][],
  segments: number[],
  totalDist: number,
  progress: number,
): { lat: number; lng: number; segIdx: number } {
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
  return { lat, lng, segIdx };
}

function emitSparseStationaryPings(
  points: TelemetryPoint[],
  lifecycle: VehicleLifecycle,
  config: GenerationConfig,
  tripId: string,
  lat: number,
  lng: number,
  routeStartTime: Date,
  routeElapsedSec: number,
  restOffsetSec: number,
  durationSec: number,
  status: VehicleState,
  pingMinSec: number,
  pingMaxSec: number,
  rng: () => number,
  isDetour: boolean,
): void {
  const vt = resolveVehicleType(config);
  const vehicle = lifecycle.vehicle;
  let restElapsed = 0;
  while (restElapsed < durationSec) {
    const [jLat, jLng] = addGpsJitter(lat, lng, 3, rng);
    const ts = new Date(routeStartTime.getTime() + (routeElapsedSec + restOffsetSec + restElapsed) * 1000);
    points.push({
      telemetry_id: uuid(rng),
      region: config.region,
      vehicle_type: vt,
      vehicle_id: vehicle.vehicle_id,
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
      is_detour: isDetour,
      gps_accuracy_m: 3,
      location_id: null,
      location_type: null,
      ors_profile: config.ors_profile,
      battery_pct: vehicle.battery_pct > 0 ? vehicle.battery_pct : null,
      odometer_km: Math.round(lifecycle.odometerKm * 100) / 100,
      point_index: lifecycle.pointIndex++,
    });
    restElapsed += rngFloat(rng, pingMinSec, pingMaxSec);
  }
}

function interpolateRouteLegacy(
  route: RouteGeometry, config: GenerationConfig,
  lifecycle: VehicleLifecycle, tripId: string,
  destPoi: POI, rng: () => number, isDetour: boolean,
  coords: [number, number][], segments: number[], totalDist: number, durationSec: number,
): TelemetryPoint[] {
  const points: TelemetryPoint[] = [];
  const vt = resolveVehicleType(config);
  const pingMean = config.telemetry.ping_interval_moving.mean_sec;
  const pingStd = config.telemetry.ping_interval_moving.std_sec;
  const jitterCfg = config.telemetry.gps_jitter;
  const postedSpeeds = config.routing.posted_speeds;
  const defaultSpeed = postedSpeeds.default || 30;
  const speedingThreshold = lifecycle.vehicle.speeding_ratio;
  const vehicle = lifecycle.vehicle;
  const hosMaxDriveMin = config.breaks?.max_daily_driving_hours
    ? config.breaks.max_daily_driving_hours * 60 : Infinity;

  let elapsed = 0;
  while (elapsed < durationSec) {
    if (Number.isFinite(hosMaxDriveMin) && lifecycle.dailyDrivingMin >= hosMaxDriveMin) {
      break;
    }

    const progress = Math.min(elapsed / durationSec, 1);
    const { lat, lng, segIdx } = positionAtProgress(coords, segments, totalDist, progress);

    const speedFactor = 1 + (rng() - 0.5) * vehicle.speed_variance * 2;
    let speedKmh = vehicle.base_speed_kmh * speedFactor;
    if (progress < 0.1 || progress > 0.9) speedKmh *= 0.7;
    speedKmh = Math.max(5, Math.min(speedKmh, 130));
    const postedSpeed = defaultSpeed;
    const isSpeeding = rng() < vehicle.speeding_prob && speedKmh > postedSpeed * speedingThreshold;
    if (isSpeeding) speedKmh = postedSpeed * rngFloat(rng, 1.1, 1.25);

    const isHosViolation =
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
    if (config.battery) {
      const kmTraveled = progress * totalDist;
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

  if (config.battery) {
    vehicle.battery_pct = Math.max(0, vehicle.battery_pct - totalDist * config.battery.drain_per_km);
  }

  return points;
}

function interpolateRouteHgvHos(
  route: RouteGeometry, config: GenerationConfig,
  lifecycle: VehicleLifecycle, tripId: string,
  rng: () => number, isDetour: boolean,
  coords: [number, number][], segments: number[], totalDist: number, durationSec: number,
  overnight: NonNullable<GenerationConfig['overnight']>,
): TelemetryPoint[] {
  const points: TelemetryPoint[] = [];
  const breaks = config.breaks!;
  const vt = resolveVehicleType(config);
  const pingMean = config.telemetry.ping_interval_moving.mean_sec;
  const pingStd = config.telemetry.ping_interval_moving.std_sec;
  const jitterCfg = config.telemetry.gps_jitter;
  const postedSpeeds = config.routing.posted_speeds;
  const defaultSpeed = postedSpeeds.default || 30;
  const speedingThreshold = lifecycle.vehicle.speeding_ratio;
  const vehicle = lifecycle.vehicle;
  const routeStartTime = lifecycle.currentTime;

  const breakEveryMin = breaks.driving_hours_between_breaks * 60;
  const maxDriveMin = breaks.max_daily_driving_hours * 60;
  const breakDurationSec = breaks.mandatory_break_duration_min * 60;
  const dwellPingMin = config.telemetry.ping_interval_dwell.min_sec;
  const dwellPingMax = config.telemetry.ping_interval_dwell.max_sec;

  let elapsed = 0;
  let restOffsetSec = 0;
  let dailyDrivingMin = lifecycle.dailyDrivingMin;
  let minSinceBreak = lifecycle.minSinceBreak;

  while (elapsed < durationSec) {
    if (minSinceBreak >= breakEveryMin) {
      const progress = Math.min(elapsed / durationSec, 1);
      const { lat, lng } = positionAtProgress(coords, segments, totalDist, progress);
      emitSparseStationaryPings(
        points, lifecycle, config, tripId, lat, lng,
        routeStartTime, elapsed, restOffsetSec, breakDurationSec,
        'DWELL_REST', dwellPingMin, dwellPingMax, rng, isDetour,
      );
      restOffsetSec += breakDurationSec;
      minSinceBreak = 0;
      continue;
    }

    if (dailyDrivingMin >= maxDriveMin) {
      const progress = Math.min(elapsed / durationSec, 1);
      const { lat, lng } = positionAtProgress(coords, segments, totalDist, progress);
      const overnightHours = rngFloat(rng, overnight.rest_hours_min, overnight.rest_hours_max);
      const overnightSec = overnightHours * 3600;
      emitSparseStationaryPings(
        points, lifecycle, config, tripId, lat, lng,
        routeStartTime, elapsed, restOffsetSec, overnightSec,
        'OVERNIGHT', overnight.ping_interval_min_sec, overnight.ping_interval_max_sec, rng, isDetour,
      );
      restOffsetSec += overnightSec;
      dailyDrivingMin = 0;
      minSinceBreak = 0;
      continue;
    }

    const progress = Math.min(elapsed / durationSec, 1);
    const { lat, lng, segIdx } = positionAtProgress(coords, segments, totalDist, progress);

    const speedFactor = 1 + (rng() - 0.5) * vehicle.speed_variance * 2;
    let speedKmh = vehicle.base_speed_kmh * speedFactor;
    if (progress < 0.1 || progress > 0.9) speedKmh *= 0.7;
    speedKmh = Math.max(5, Math.min(speedKmh, 130));
    const postedSpeed = defaultSpeed;
    const isSpeeding = rng() < vehicle.speeding_prob && speedKmh > postedSpeed * speedingThreshold;
    if (isSpeeding) speedKmh = postedSpeed * rngFloat(rng, 1.1, 1.25);

    const isHosViolation = dailyDrivingMin > maxDriveMin && rng() < vehicle.hos_violation_prob;

    const heading = calculateHeading(lat, lng,
      coords[Math.min(segIdx + 1, coords.length - 1)][0],
      coords[Math.min(segIdx + 1, coords.length - 1)][1]);

    const jitterM = rng() < jitterCfg.multipath_probability
      ? rngFloat(rng, 50, jitterCfg.multipath_max_m)
      : rngFloat(rng, 2, jitterCfg.typical_m);
    const [jLat, jLng] = addGpsJitter(lat, lng, jitterM, rng);

    const ts = new Date(routeStartTime.getTime() + (elapsed + restOffsetSec) * 1000);

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
      battery_pct: vehicle.battery_pct > 0 ? vehicle.battery_pct : null,
      odometer_km: Math.round(lifecycle.odometerKm * 100) / 100,
      point_index: lifecycle.pointIndex++,
    });

    const interval = Math.max(5, pingMean + (rng() - 0.5) * 2 * pingStd);
    elapsed += interval;
    dailyDrivingMin += interval / 60;
    minSinceBreak += interval / 60;
  }

  lifecycle.lat = coords[coords.length - 1][0];
  lifecycle.lng = coords[coords.length - 1][1];
  lifecycle.currentTime = new Date(routeStartTime.getTime() + (durationSec + restOffsetSec) * 1000);
  lifecycle.dailyDrivingMin = dailyDrivingMin;
  lifecycle.minSinceBreak = minSinceBreak;

  return points;
}

export function interpolateRoute(
  route: RouteGeometry, config: GenerationConfig,
  lifecycle: VehicleLifecycle, tripId: string,
  destPoi: POI, rng: () => number, isDetour: boolean,
): TelemetryPoint[] {
  const coords = route.coordinates;
  if (coords.length < 2) return [];

  const segments: number[] = [0];
  let totalDist = 0;
  for (let i = 1; i < coords.length; i++) {
    totalDist += haversineKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    segments.push(totalDist);
  }
  if (totalDist === 0) return [];

  const durationSec = route.duration_sec || (totalDist / (lifecycle.vehicle.base_speed_kmh / 3.6));
  const overnight = config.overnight ?? DEFAULT_OVERNIGHT;
  // Duty-cycle rest (mid-route breaks + overnight) is enabled by the PRESENCE of
  // config.breaks + overnight, not by vehicle type. Any mode that declares these
  // gets the scheduled-rest interpolation path.
  const useScheduledRest = !!config.breaks
    && overnight.enabled !== false;

  if (useScheduledRest) {
    return interpolateRouteHgvHos(
      route, config, lifecycle, tripId, rng, isDetour,
      coords as [number, number][], segments, totalDist, durationSec,
      overnight,
    );
  }

  return interpolateRouteLegacy(
    route, config, lifecycle, tripId, destPoi, rng, isDetour,
    coords as [number, number][], segments, totalDist, durationSec,
  );
}
