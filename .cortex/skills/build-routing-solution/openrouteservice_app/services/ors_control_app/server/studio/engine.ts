// Studio synthetic telemetry orchestrator. The pure helpers
// (POI loading, routing, interpolation, dwell emission, fleet build, freight
// offers) live in engine/*; this file only hosts the day-by-day generateTelemetry
// async generator that ties them together and emits SSE events to jobs.ts.

import {
  GenerationConfig, DwellConfig, createRng, rngInt, resolveVehicleType, uuid,
  haversineKm,
} from './profiles.js';
import { log } from '../diagnostics.js';

import type {
  POI, RouteGeometry, TelemetryPoint, TripRecord, GenerationEvent,
  GenerationProgress, SnowSqlFn, VehicleLifecycle,
} from './engine/types.js';

import { buildFleet } from './engine/fleet.js';
import { loadPOIs } from './engine/routability.js';
import {
  fetchRoute, fetchDetourRoute, pickDestination,
  pickNearestRoutableNeighbor, pickDetourWaypoint, probeRoutability,
} from './engine/routing.js';
import { interpolateRoute } from './engine/interpolate.js';
import { emitDwell, emitLongIdleDwell } from './engine/dwell.js';

export type {
  TelemetryPoint, TripRecord, GenerationEvent, POI, RouteGeometry,
  FleetMember, GenerationProgress, RouteFetchResult, FreightOffer,
} from './engine/types.js';

// Re-exports kept for backwards-compatibility with jobs.ts and tests.
export { generateFreightOffers } from './engine/freight.js';
export { buildFleet } from './engine/fleet.js';
export { loadPOIs } from './engine/routability.js';
export { probeRoutability } from './engine/routing.js';

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
