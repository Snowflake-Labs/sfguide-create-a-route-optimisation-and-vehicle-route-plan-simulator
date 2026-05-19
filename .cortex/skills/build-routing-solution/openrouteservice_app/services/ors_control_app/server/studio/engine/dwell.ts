// Dwell + ghost-trailer telemetry emitters. emitDwell drops a stationary
// vehicle for a sampled lognormal duration with sparse pings; emitLongIdleDwell
// emits the multi-day IDLE pings used by ghost trailers.

import type { POI, TelemetryPoint, VehicleLifecycle, VehicleState } from './types.js';
import {
  DwellConfig, GenerationConfig, addGpsJitter, lognormalSample,
  resolveVehicleType, rngFloat, uuid,
} from '../profiles.js';

export function emitDwell(
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
export function emitLongIdleDwell(
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
