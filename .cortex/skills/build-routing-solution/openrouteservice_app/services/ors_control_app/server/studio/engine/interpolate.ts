// Per-trip route interpolation. Walks the ORS-provided polyline at the
// configured ping cadence, emits a TelemetryPoint for each ping with realistic
// speed variation, GPS jitter, posted-speed/speeding flags, and HOS state.
// Mutates the provided VehicleLifecycle in place (advances time + odometer).

import type { POI, RouteGeometry, TelemetryPoint, VehicleLifecycle } from './types.js';
import {
  GenerationConfig, addGpsJitter, calculateHeading, haversineKm,
  resolveVehicleType, rngFloat, uuid,
} from '../profiles.js';

export function interpolateRoute(
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
