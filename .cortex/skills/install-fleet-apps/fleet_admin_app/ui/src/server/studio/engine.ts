// Studio synthetic telemetry orchestrator. The pure helpers
// (POI loading, routing, interpolation, dwell emission, fleet build, freight
// offers) live in engine/*; this file only hosts the day-by-day generateTelemetry
// async generator that ties them together and emits SSE events to jobs.ts.
//
// Per-day execution is parallelised: up to `config.parallelism` (default 8)
// vehicles run their ORS-bound day simultaneously, and telemetry is streamed in
// 2k-point batches as workers complete instead of one giant flush per day.

import {
  GenerationConfig, DwellConfig, createRng, rngInt, resolveVehicleType, uuid,
  haversineKm,
} from './profiles';
import { log } from '../diagnostics';

import type {
  POI, RouteGeometry, TelemetryPoint, TripRecord, GenerationEvent,
  GenerationProgress, SnowSqlFn, VehicleLifecycle, FleetMember,
} from './engine/types';

import { buildFleet } from './engine/fleet';
import { loadPOIs } from './engine/routability';
import {
  fetchRoute, fetchDetourRoute, pickDestination,
  pickNearestRoutableNeighbor, pickDetourWaypoint, probeRoutability,
} from './engine/routing';
import { interpolateRoute } from './engine/interpolate';
import { emitDwell, emitLongIdleDwell } from './engine/dwell';

export type {
  TelemetryPoint, TripRecord, GenerationEvent, POI, RouteGeometry,
  FleetMember, GenerationProgress, RouteFetchResult, Offer, DeliveryOffer,
  Partner, PartnerHistoryRow,
} from './engine/types';

// Re-exports kept for backwards-compatibility with jobs.ts and tests.
export { generateOffers } from './engine/offers';
/** @deprecated Use generateOffers */
export { generateOffers as generateDeliveries } from './engine/offers';
export { generatePartners, generatePartnerHistory } from './engine/partners';
export { buildFleet } from './engine/fleet';
export { loadPOIs } from './engine/routability';
export { probeRoutability } from './engine/routing';
// Universal-generation engines (Overture + free Marketplace). Each writes a
// region-scoped, JOB_ID-versioned SYNTHETIC_DATASETS.UNIFIED entity table.
export { generateAnchors } from './engine/anchors';
export { generateParticipants } from './engine/participants';
export { generateDemographics } from './engine/demographics';
export { generateHazardZones } from './engine/hazard';
export { generateDemandCatalog } from './engine/demand';

interface VehicleDayResult {
  vehicleId: string;
  points: TelemetryPoint[];
  trips: TripRecord[];
  successes: number;
  failures: number;
  unroutable: number;
  busyUntilDayOffset?: number;
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
  const PARALLELISM = Math.max(1, Math.floor(config.parallelism ?? 8));
  const STREAM_FLUSH_THRESHOLD = 2000;

  log('INFO', 'Studio', `Starting generation for ${config.region}`, {
    detail: {
      vehicleType: vt, profile: config.ors_profile, mode: config.mode,
      vehicles: config.fleet.num_vehicles, tripsPerDay: config.fleet.trips_per_day,
      days: config.time.start_date + ' to ' + config.time.end_date,
      bbox: config.bbox,
      driverProfiles: Object.keys(config.driver_profiles),
      parallelism: PARALLELISM,
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
  log('INFO', 'Studio', `Built fleet of ${fleet.length} ${vt} vehicles (parallelism=${PARALLELISM})`, {
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
  const busyUntil = new Map<string, number>();
  const MAX_CONSECUTIVE_FAILURES = 25;
  const MIN_ATTEMPTS_BEFORE_STOP = 20;
  const MAX_ROUTE_RETRIES = 3;
  const RECOVERY_THRESHOLD = 10;
  const RECOVERY_COOLDOWN_MS = 5 * 60 * 1000;
  let lastRecoveryMs = 0;
  let recoveryInFlight: Promise<void> | null = null;

  // Single-flight ORS recovery shared across all parallel workers.
  async function tryRecover() {
    if (recoveryInFlight) return recoveryInFlight;
    if (Date.now() - lastRecoveryMs <= RECOVERY_COOLDOWN_MS) return;
    lastRecoveryMs = Date.now();
    log('WARN', 'Studio', `${consecutiveFails} consecutive failures, attempting ORS service recovery...`, {
      detail: { region: config.region, profile: config.ors_profile, routeSuccesses },
    });
    recoveryInFlight = (async () => {
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
      } finally {
        recoveryInFlight = null;
      }
    })();
    return recoveryInFlight;
  }

  // Per-vehicle day simulation. Pure local state apart from the shared
  // unroutablePoiIds set (Set.add is safe under JS event-loop concurrency).
  // Returns accumulated points/trips/stats; the parent generator yields them.
  async function simulateMemberDay(
    member: FleetMember,
    dayOffset: number,
    currentDay: Date,
    isWeekend: boolean,
    memberRng: () => number,
  ): Promise<VehicleDayResult> {
    const points: TelemetryPoint[] = [];
    const trips: TripRecord[] = [];
    let successes = 0;
    let failures = 0;
    let unroutable = 0;
    let busyUntilDayOffset: number | undefined;

    // Ghost trailer handling - vehicle is parked at home for several days.
    const inGhostWindow = member.ghost_start_day !== undefined
      && member.ghost_end_day !== undefined
      && dayOffset >= member.ghost_start_day
      && dayOffset <= member.ghost_end_day;
    if (inGhostWindow) {
      // On any ghost day other than the first, the long-idle pings were
      // already emitted on the start day - skip silently.
      if (dayOffset !== member.ghost_start_day) {
        return { vehicleId: member.vehicle_id, points, trips, successes, failures, unroutable };
      }
      const ghostCfg = config.ghost_trailer!;
      const totalGhostDays = (member.ghost_end_day! - member.ghost_start_day!) + 1;
      const ghostStartTime = new Date(Date.UTC(currentDay.getUTCFullYear(), currentDay.getUTCMonth(), currentDay.getUTCDate(), 0, rngInt(memberRng, 0, 30)));
      const ghostLifecycle: VehicleLifecycle = {
        vehicle: { ...member, battery_pct: config.battery ? 100 : -1 },
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
      points.push(...emitLongIdleDwell(
        ghostLifecycle, config, member.home_poi,
        durationSec, ghostCfg.ping_interval_min_sec, ghostCfg.ping_interval_max_sec, memberRng,
      ));
      return { vehicleId: member.vehicle_id, points, trips, successes, failures, unroutable };
    }

    if ((busyUntil.get(member.vehicle_id) ?? -1) >= dayOffset) {
      return { vehicleId: member.vehicle_id, points, trips, successes, failures, unroutable };
    }

    const operatingRate = config.fleet.daily_operating_rate
      || (isWeekend ? (config.fleet.weekend_operating_rate || 0.4) : (config.fleet.weekday_operating_rate || 0.85));
    if (memberRng() > operatingRate) {
      return { vehicleId: member.vehicle_id, points, trips, successes, failures, unroutable };
    }

    const shiftStart = member.shift_start;
    const lifecycle: VehicleLifecycle = {
      vehicle: { ...member, battery_pct: config.battery ? 100 : -1 },
      lat: member.home_poi.lat,
      lng: member.home_poi.lng,
      currentTime: new Date(Date.UTC(currentDay.getUTCFullYear(), currentDay.getUTCMonth(), currentDay.getUTCDate(), shiftStart, rngInt(memberRng, 0, 30))),
      state: 'DWELL_ORIGIN',
      location_id: member.home_poi.location_id,
      location_type: member.home_poi.location_type,
      dailyDrivingMin: 0,
      minSinceBreak: 0,
      tripSeq: 0,
      odometerKm: 0,
      pointIndex: 0,
    };

    const numTrips = rngInt(memberRng, config.fleet.trips_per_day.min, config.fleet.trips_per_day.max);
    let currentOriginPoi = member.home_poi;

    // Empty-leg / deadhead modeling (all vehicle types, default on). Routes a
    // repositioning leg from the vehicle's current location to `toPoi`, emitting
    // MOVING pings and a TRIP_KIND='EMPTY' trip row. Returns true when the
    // vehicle actually moved; false when unroutable (vehicle stays put - never
    // teleports). Used between jobs (drop-off -> next pickup) and at end of day
    // (last drop-off -> home base), so the path stays continuous and empty miles
    // (EMPTY km / total km) are measurable.
    const emptyLegsEnabled = config.empty_legs?.enabled ?? true;
    async function emitEmptyLeg(toPoi: POI): Promise<boolean> {
      if (!toPoi || toPoi.location_id === lifecycle.location_id) return false;
      let route: RouteGeometry | null = null;
      for (let attempt = 0; attempt < MAX_ROUTE_RETRIES; attempt++) {
        const r = await fetchRoute(lifecycle.lat, lifecycle.lng, toPoi.lat, toPoi.lng, config.ors_profile, config.region, snowSql);
        if (r && r !== 'UNROUTABLE') { route = r; break; }
        if (r === 'UNROUTABLE' && toPoi.location_id) unroutablePoiIds.add(toPoi.location_id);
      }
      if (!route || route.coordinates.length < 2) return false;
      const legTripId = uuid(memberRng);
      const legStart = new Date(lifecycle.currentTime);
      const fromPoiId = lifecycle.location_id ?? currentOriginPoi.location_id;
      const fromLat = lifecycle.lat;
      const fromLon = lifecycle.lng;
      lifecycle.state = 'MOVING';
      points.push(...interpolateRoute(route, config, lifecycle, legTripId, toPoi, memberRng, false));
      lifecycle.location_id = toPoi.location_id;
      lifecycle.location_type = toPoi.location_type;
      const legEnd = new Date(lifecycle.currentTime);
      trips.push({
        trip_id: legTripId,
        vehicle_id: member.vehicle_id,
        driver_id: member.driver_id,
        vehicle_type: vt,
        region: config.region,
        origin_poi_id: fromPoiId,
        destination_poi_id: toPoi.location_id,
        origin_lat: fromLat,
        origin_lon: fromLon,
        destination_lat: toPoi.lat,
        destination_lon: toPoi.lng,
        route_coordinates: route.coordinates as [number, number][],
        distance_km: Math.round((route.distance_m / 1000) * 100) / 100,
        duration_minutes: Math.round(((legEnd.getTime() - legStart.getTime()) / 60000) * 100) / 100,
        planned_route_coordinates: null,
        planned_distance_km: null,
        is_detour: false,
        detour_distance_km: null,
        trip_start: legStart,
        trip_end: legEnd,
        status: 'COMPLETED',
        ors_profile: config.ors_profile,
        trip_kind: 'EMPTY',
      });
      return true;
    }

    for (let t = 0; t < numTrips; t++) {
      if (abortSignal?.aborted) break;
      const shiftEnd = member.shift_end < member.shift_start ? member.shift_end + 24 : member.shift_end;
      const currentHour = lifecycle.currentTime.getHours() + (lifecycle.currentTime.getHours() < member.shift_start ? 24 : 0);
      if (currentHour >= shiftEnd) break;

      if (config.breaks && lifecycle.minSinceBreak >= config.breaks.driving_hours_between_breaks * 60) {
        const breakDwell: DwellConfig = { median_min: config.breaks.mandatory_break_duration_min, sigma: 0.2, max_min: config.breaks.mandatory_break_duration_min * 1.5 };
        const restPois = pois.filter(p => p.location_type === 'REST_STOP');
        const breakPoi = restPois.length > 0 ? restPois[Math.floor(memberRng() * restPois.length)] : currentOriginPoi;
        points.push(...emitDwell(lifecycle, config, null, breakDwell, 'DWELL_REST', breakPoi, memberRng));
        lifecycle.minSinceBreak = 0;
      }

      if (config.breaks?.max_daily_driving_hours && lifecycle.dailyDrivingMin >= config.breaks.max_daily_driving_hours * 60) break;

      if (config.battery && lifecycle.vehicle.battery_pct <= (config.battery.recharge_threshold_pct || 15)) {
        const rechargeDwell: DwellConfig = { median_min: 20, sigma: 0.3, max_min: 40 };
        points.push(...emitDwell(lifecycle, config, null, rechargeDwell, 'DWELL_RECHARGE', currentOriginPoi, memberRng));
        lifecycle.vehicle.battery_pct = 100;
      }

      // Reposition to the next pickup as an EMPTY leg (deadhead). The pickup is
      // chosen independently of the previous drop-off so the move is a visible
      // routed movement, not a teleport. The first job (t===0) starts at home.
      if (emptyLegsEnabled && t > 0) {
        const pickupPoi = pickDestination(currentOriginPoi, pois, config, memberRng);
        if (await emitEmptyLeg(pickupPoi)) {
          currentOriginPoi = pickupPoi;
        }
      }

      let destPoi = pickDestination(currentOriginPoi, pois, config, memberRng);
      const tripId = uuid(memberRng);
      const tripStartTime = new Date(lifecycle.currentTime);

      const originDwellKey = currentOriginPoi.location_type === 'WAREHOUSE' ? 'warehouse' : 'origin';
      let originDwell = config.dwell[originDwellKey];
      if (!originDwell || !('median_min' in originDwell)) {
        originDwell = { median_min: 5, sigma: 0.5, max_min: 20 };
      }
      points.push(...emitDwell(lifecycle, config, tripId, originDwell as DwellConfig, 'DWELL_ORIGIN', currentOriginPoi, memberRng));

      const detourProb = config.detour?.probability ?? config.routing.detour_probability ?? 0.05;
      const shouldDetour = memberRng() < detourProb;
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
          destPoi = pickDestination(currentOriginPoi, fromPois, config, memberRng);
          if (attempt === MAX_ROUTE_RETRIES - 2) {
            const nearbyPoi = pickNearestRoutableNeighbor(currentOriginPoi, fromPois, memberRng);
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
        successes++;
      } else if (attemptsHardFail === 0 && attemptsUnroutable > 0) {
        unroutable++;
        continue;
      } else {
        failures++;
        // Recovery + hard-stop checks happen in the parent loop after this
        // worker resolves; we just bail out of this vehicle's day here.
        break;
      }

      if (shouldDetour && plannedRoute) {
        const waypoint = pickDetourWaypoint(currentOriginPoi, destPoi, pois, memberRng);
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
        points.push(...interpolateRoute(routeToFollow, config, lifecycle, tripId, destPoi, memberRng, isDetour));
      } else {
        lifecycle.lat = destPoi.lat;
        lifecycle.lng = destPoi.lng;
        lifecycle.currentTime = new Date(lifecycle.currentTime.getTime() + rngInt(memberRng, 300, 1200) * 1000);
      }

      const destDwellKey = 'destination';
      let destDwell = config.dwell[destDwellKey];
      if (!destDwell || !('median_min' in destDwell)) {
        destDwell = { median_min: 3, sigma: 0.5, max_min: 15 };
      }
      points.push(...emitDwell(lifecycle, config, tripId, destDwell as DwellConfig, 'DWELL_DESTINATION', destPoi, memberRng));

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
          trip_kind: 'LADEN',
        };
        trips.push(tripRecord);
      }

      const dayStartMidnight = Date.UTC(
        currentDay.getUTCFullYear(), currentDay.getUTCMonth(), currentDay.getUTCDate(),
      );
      const daysConsumed = Math.floor(
        (lifecycle.currentTime.getTime() - dayStartMidnight) / 86400000,
      );
      if (daysConsumed > 0) {
        busyUntilDayOffset = dayOffset + daysConsumed;
        break;
      }

      currentOriginPoi = destPoi;
      lifecycle.tripSeq++;
    }

    // Return-to-base: close the operating day with an EMPTY leg from the last
    // drop-off back to the home POI, so the day ends where the next one starts
    // (and where ghost/idle pings are emitted) - removing the home_poi teleport.
    if (emptyLegsEnabled && currentOriginPoi.location_id !== member.home_poi.location_id) {
      if (await emitEmptyLeg(member.home_poi)) {
        currentOriginPoi = member.home_poi;
      }
    }

    const idleDwell = config.dwell.idle;
    if (idleDwell && 'median_min' in idleDwell) {
      points.push(...emitDwell(lifecycle, config, null, idleDwell as DwellConfig, 'IDLE', currentOriginPoi, memberRng));
    }

    return {
      vehicleId: member.vehicle_id, points, trips, successes, failures, unroutable,
      busyUntilDayOffset,
    };
  }

  // Day loop: dispatch up to PARALLELISM vehicle-day workers concurrently and
  // drain results race-style. Mid-day flushes keep the SSE stream alive and
  // overlap inserts with subsequent ORS calls.
  for (let dayOffset = 0; dayOffset < totalDays; dayOffset++) {
    if (abortSignal?.aborted) return;

    const currentDay = new Date(startDate.getTime() + dayOffset * 86400000);
    const isWeekend = currentDay.getUTCDay() === 0 || currentDay.getUTCDay() === 6;
    const dayBatch: TelemetryPoint[] = [];

    // Pre-derive a stable per-vehicle RNG seed so worker order does not change
    // any single vehicle's emitted sequence (the global rng state still drifts
    // non-deterministically across runs because of concurrency, but at least
    // each vehicle's day stays self-consistent).
    const memberRngs = fleet.map(() =>
      createRng(Math.floor(rng() * Number.MAX_SAFE_INTEGER) ^ (dayOffset * 2654435761)),
    );

    type Pending = Promise<{ idx: number; result: VehicleDayResult }>;
    const inFlight = new Map<number, Pending>();
    let nextIdx = 0;
    let stopRequested = false;

    const launchNext = () => {
      while (!stopRequested && inFlight.size < PARALLELISM && nextIdx < fleet.length) {
        const idx = nextIdx++;
        const member = fleet[idx];
        const p = simulateMemberDay(member, dayOffset, currentDay, isWeekend, memberRngs[idx])
          .then(result => ({ idx, result }));
        inFlight.set(idx, p);
      }
    };

    launchNext();

    while (inFlight.size > 0) {
      if (abortSignal?.aborted) return;
      const { idx, result } = await Promise.race(inFlight.values());
      inFlight.delete(idx);

      // Accumulate counters
      routeSuccesses += result.successes;
      routeFailures += result.failures;
      unroutableSkips += result.unroutable;
      totalTrips += result.trips.length;
      if (result.successes > 0) {
        consecutiveFails = 0;
      } else       if (result.failures > 0) {
        consecutiveFails += result.failures;
      }

      if (result.busyUntilDayOffset != null) {
        busyUntil.set(result.vehicleId, result.busyUntilDayOffset);
      }

      // Emit trips immediately (they are small; consumer batches them at 50)
      for (const trip of result.trips) {
        yield { type: 'trip', record: trip };
      }

      // Buffer telemetry; flush incrementally to keep memory bounded and the
      // UI alive between days.
      dayBatch.push(...result.points);
      if (dayBatch.length >= STREAM_FLUSH_THRESHOLD) {
        const flush = dayBatch.splice(0);
        totalPoints += flush.length;
        yield { type: 'telemetry', points: flush };
      }

      // ORS recovery (single-flight across all parallel workers)
      if (consecutiveFails >= RECOVERY_THRESHOLD && Date.now() - lastRecoveryMs > RECOVERY_COOLDOWN_MS) {
        await tryRecover();
      }

      // Hard-fail if the engine never managed a single success
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
      // Soft-stop after partial success
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILURES && totalAttempts >= MIN_ATTEMPTS_BEFORE_STOP) {
        log('WARN', 'Studio', `Stopping: ${consecutiveFails} consecutive failures after ${routeSuccesses} successes`, {
          detail: { region: config.region, profile: config.ors_profile, totalAttempts },
        });
        stopRequested = true;
        // Drain remaining in-flight workers (they cannot be cancelled, but
        // their results still flow through this loop on the next iterations).
        if (dayBatch.length > 0) {
          totalPoints += dayBatch.length;
          yield { type: 'telemetry', points: dayBatch.splice(0) };
        }
        // Wait for the rest to settle before yielding the stopped event
        if (inFlight.size > 0) {
          const remaining = await Promise.all(inFlight.values());
          inFlight.clear();
          for (const { result: rest } of remaining) {
            if (rest.busyUntilDayOffset != null) {
              busyUntil.set(rest.vehicleId, rest.busyUntilDayOffset);
            }
            for (const trip of rest.trips) yield { type: 'trip', record: trip };
            if (rest.points.length > 0) {
              totalPoints += rest.points.length;
              yield { type: 'telemetry', points: rest.points };
            }
            totalTrips += rest.trips.length;
            routeSuccesses += rest.successes;
            routeFailures += rest.failures;
            unroutableSkips += rest.unroutable;
          }
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

      onProgress?.({
        day: dayOffset + 1,
        totalDays,
        vehicleId: result.vehicleId,
        pointsToday: dayBatch.length,
        totalPoints: totalPoints + dayBatch.length,
        totalTrips,
        routeSuccesses,
        routeFailures,
        unroutableSkips,
        unroutablePois: unroutablePoiIds.size,
        status: `Day ${dayOffset + 1}: ${result.vehicleId} (${dayBatch.length} pts buffered, ${totalTrips} trips)`,
      });

      launchNext();
    }

    // End-of-day flush of whatever is left in dayBatch.
    if (dayBatch.length > 0) {
      totalPoints += dayBatch.length;
      yield { type: 'telemetry', points: dayBatch.splice(0) };
    }

    const unroutableSuffix = unroutableSkips > 0 ? `, ${unroutableSkips} unroutable POI skips (${unroutablePoiIds.size} unique)` : '';
    onProgress?.({
      day: dayOffset + 1,
      totalDays,
      pointsToday: 0,
      totalPoints,
      totalTrips,
      routeSuccesses,
      routeFailures,
      unroutableSkips,
      unroutablePois: unroutablePoiIds.size,
      status: `Day ${dayOffset + 1}/${totalDays} complete: ${totalTrips} trips total${unroutableSuffix}`,
    });
  }
}
