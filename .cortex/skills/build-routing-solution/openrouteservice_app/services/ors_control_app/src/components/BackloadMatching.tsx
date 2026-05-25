import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import MetricCard from '../shared/MetricCard';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, PathLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import { useRegion } from '../hooks/useRegion';
import { useFitMap } from '../shared/useFitMap';
import RecenterButton from '../shared/RecenterButton';
import { coordsFromGeoJSON, fitBoundsToData, type LngLat } from '../shared/mapFit';
import AssignmentList from './backload-matching/AssignmentList';
import DecisionsAudit from './backload-matching/DecisionsAudit';
import StopsPanel from './backload-matching/StopsPanel';
import InfoTip from './backload-matching/InfoTip';
import PageContainer from '../shared/PageContainer';
import {
  BM_DB, BM_SCHEMA, CARTO_LIGHT, EUR_PER_LOADED_KM, KMH_HGV, COST_SCALE, ROUTE_COLORS,
  Trailer, Volume, Offer, Assignment, Stop, SvcStatus, AvoidZone,
  sfQuery, haversineKm, profileForVehicleType, synthPallets, synthVolumeM3,
  isOrsRegionReady, buildVroomMatrix,
} from './backload-matching/helpers';

// Hard caps on solve payload size. Picked so that the precomputed matrix
// stays well under ORS's `max_locations` limit (default 3500 cells = 59x59)
// AND so the VROOM search space stays bounded. Raising these without first
// landing OPTIMIZATION_TABULAR + a persistent matrix cache (Card I) is
// known to cause multi-minute hangs at "Calling OPTIMIZATION..." — see
// .snowflake/cortex/plans/backload-solve-hang-fix.plan.md.
const BM_MAX_VEHICLES = 15;
const BM_MAX_INTERNAL = 30;
const BM_MAX_EXTERNAL = 15;
// Hard ceiling on the unique-location count we'll try to precompute a matrix
// for. ORS default is max 3500 cells = sqrt(3500) ≈ 59 locations.
const BM_MAX_MATRIX_LOCATIONS = 50;
// Wall-clock budget for the whole solve, including the in-gateway matrix
// pre-compute and the VROOM call. Past this we abort the fetch and surface
// a precise error instead of an open-ended spinner.
const BM_SOLVE_TIMEOUT_MS = 180_000;

function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap', data: CARTO_LIGHT, minZoom: 0, maxZoom: 19, tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] });
    },
  });
}

type EndMode = 'home' | 'shared' | 'open';

export default function BackloadMatching() {
  const { regionName, center, zoom } = useRegion();
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [internal, setInternal] = useState<Volume[]>([]);
  const [external, setExternal] = useState<Offer[]>([]);
  const [vehicleType, setVehicleType] = useState<string>('hgv');
  const [solveError, setSolveError] = useState<string | null>(null);
  const [avoidZones, setAvoidZones] = useState<AvoidZone[]>([]);

  // ---------------- Solver levers (every one maps 1:1 to VROOM/ORS) ----------------
  const [maxStops, setMaxStops]                   = useState(2);    // vehicle.max_tasks
  const [detourSlackHrs, setDetourSlackHrs]       = useState(4);    // vehicle.max_travel_time
  const [deviationPct, setDeviationPct]           = useState(200);  // vehicle.max_distance
  const [internalFirstWeight, setInternalFirstWeight] = useState(90); // job.priority gap
  const [windowSlackHrs, setWindowSlackHrs]       = useState(2);    // job.time_windows
  const [endMode, setEndMode]                     = useState<EndMode>('home'); // vehicle.end
  const [sharedDestLon, setSharedDestLon]         = useState<number | null>(null);
  const [sharedDestLat, setSharedDestLat]         = useState<number | null>(null);
  const [sharedDestUserEdited, setSharedDestUserEdited] = useState(false);

  // ---------------- Economics levers (€) ----------------
  const [costPerHourEur, setCostPerHourEur]       = useState(45);   // vehicle.costs.per_hour
  const [costPerKmEur, setCostPerKmEur]           = useState(0.85); // folded into per_hour + post-solve
  const [fixedDispatchEur, setFixedDispatchEur]   = useState(120);  // vehicle.costs.fixed
  const [costPerDeliveryEur, setCostPerDeliveryEur] = useState(15); // post-solve only
  const [internalRatePerKm, setInternalRatePerKm] = useState(EUR_PER_LOADED_KM); // revenue
  const [hideUnprofitable, setHideUnprofitable]   = useState(false);

  // ---------------- Engine-feature toggles (Cards A-J) ----------------
  const [showAdvanced, setShowAdvanced]           = useState(false);
  // Card A: vehicle.breaks[]
  const [enforceDriverBreak, setEnforceDriverBreak] = useState(false);
  const [breakAfterHrs, setBreakAfterHrs]         = useState(4.5);
  const [breakLengthMin, setBreakLengthMin]       = useState(45);
  // Card D: vehicle.time_window
  const [enforceShift, setEnforceShift]           = useState(false);
  const [shiftLengthHrs, setShiftLengthHrs]       = useState(9);
  // Card C: multi-dim capacity
  const [useMultiDimCapacity, setUseMultiDimCapacity] = useState(false);
  // Card B: multi-window pickups (synthesise a 2nd window)
  const [useMultiWindow, setUseMultiWindow]       = useState(false);
  // Card F: avoid polygons
  const [selectedAvoidZoneIds, setSelectedAvoidZoneIds] = useState<string[]>([]);
  // Card J: wait-time chips
  const [showWaitTimes, setShowWaitTimes]         = useState(true);

  const [solving, setSolving] = useState(false);
  const solveAbortRef = useRef<AbortController | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const emptyLegCacheRef = useRef<Map<string, any>>(new Map());
  const [unassigned, setUnassigned] = useState<{ id: number; reason?: string }[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<string | null>(null);
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const [rationaleLoading, setRationaleLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [seedHint, setSeedHint] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [solverLog, setSolverLog] = useState<string | null>(null);

  // ORS service status + wake-up
  const requiredServices = useMemo(
    () => ['ROUTING_GATEWAY_SERVICE',
           `ORS_SERVICE_${(regionName || '').toUpperCase()}`,
           `VROOM_SERVICE_${(regionName || '').toUpperCase()}`],
    [regionName]
  );
  const [orsProfile, setOrsProfile] = useState<string>('driving-car');
  const [svcStatus, setSvcStatus] = useState<SvcStatus[]>([]);
  const [wakingUp, setWakingUp] = useState(false);

  const fetchSvcStatus = useCallback(async (): Promise<SvcStatus[]> => {
    const rows = await sfQuery(`SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP`, 'OPENROUTESERVICE_APP', 'CORE');
    const wanted = new Set(requiredServices);
    return rows
      .filter((r: any) => wanted.has(r.name || r.NAME))
      .map((r: any) => ({
        name: r.name || r.NAME,
        status: r.status || r.STATUS,
        cur: Number(r.current_instances ?? r.CURRENT_INSTANCES) || 0,
        tgt: Number(r.target_instances ?? r.TARGET_INSTANCES) || 0,
      }));
  }, [requiredServices]);

  useEffect(() => {
    if (endMode !== 'shared') return;
    if (sharedDestUserEdited) return;
    const t = trailers[0];
    if (!t) return;
    setSharedDestLon(Number(t.HOME_LON));
    setSharedDestLat(Number(t.HOME_LAT));
  }, [endMode, trailers, sharedDestUserEdited]);

  useEffect(() => {
    let active = true;
    const tick = async () => { try { const s = await fetchSvcStatus(); if (active) setSvcStatus(s); } catch {} };
    tick();
    const id = setInterval(tick, 30000);
    return () => { active = false; clearInterval(id); };
  }, [fetchSvcStatus]);


  const wakeUp = useCallback(async () => {
    setWakingUp(true);
    try {
      const initial = await fetchSvcStatus();
      setSvcStatus(initial);
      const suspended = initial.filter(s => s.status === 'SUSPENDED').map(s => s.name);
      if (suspended.length) {
        await Promise.all(suspended.map(n =>
          fetch(`/api/services/${n}/resume`, { method: 'POST' })
        ));
      }
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const next = await fetchSvcStatus();
        setSvcStatus(next);
        if (next.every(r => r.status === 'RUNNING' && r.cur >= r.tgt)) break;
      }
    } finally {
      setWakingUp(false);
    }
  }, [fetchSvcStatus]);

  const refetch = useCallback(async () => {
    const [tRows, iRows, eRows, cRows, profRows, azRows] = await Promise.all([
      sfQuery(`SELECT * FROM ${BM_DB}.${BM_SCHEMA}.VW_TRAILERS LIMIT 100`),
      sfQuery(`SELECT ID, PICKUP_CITY, PICKUP_LON, PICKUP_LAT, DROPOFF_CITY, DROPOFF_LON, DROPOFF_LAT, PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, HAZMAT FROM ${BM_DB}.${BM_SCHEMA}.VW_INTERNAL_VOLUMES LIMIT 200`),
      sfQuery(`SELECT OFFER_ID, SOURCE, PICKUP_CITY, PICKUP_COUNTRY, PICKUP_LON, PICKUP_LAT, DROPOFF_CITY, DROPOFF_COUNTRY, DROPOFF_LON, DROPOFF_LAT, PICKUP_FROM_TS, PICKUP_TO_TS, WEIGHT_KG, PRODUCT, PRICE_EUR, HAZMAT, LISTING_TEXT FROM ${BM_DB}.${BM_SCHEMA}.VW_EXTERNAL_OFFERS LIMIT 500`),
      sfQuery(`SELECT * FROM ${BM_DB}.${BM_SCHEMA}.CONFIG`),
      sfQuery(`SELECT PROFILES FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS WHERE STATUS='COMPLETE' AND REGION='${regionName?.replace(/'/g, "''") || ''}' ORDER BY COMPLETED_AT DESC LIMIT 1`, 'OPENROUTESERVICE_APP', 'CORE'),
      sfQuery(`SELECT ZONE_ID, NAME, CATEGORY, ST_ASGEOJSON(POLYGON)::VARCHAR AS POLYGON_GEOJSON FROM ${BM_DB}.${BM_SCHEMA}.AVOID_ZONES`).catch(() => []),
    ]);
    setTrailers(tRows as Trailer[]);
    setInternal(iRows as Volume[]);
    setExternal(eRows as Offer[]);
    const cfg: Record<string, any> = (cRows[0] as any) || {};
    if (cfg.VEHICLE_TYPE != null) setVehicleType(String(cfg.VEHICLE_TYPE));
    const provProfile = (profRows[0] as any)?.PROFILES;
    if (provProfile) setOrsProfile(provProfile.split(',')[0].trim());
    setAvoidZones((azRows as any[]).map(r => ({
      ZONE_ID: r.ZONE_ID, NAME: r.NAME, CATEGORY: r.CATEGORY,
      POLYGON_GEOJSON: typeof r.POLYGON_GEOJSON === 'string' ? JSON.parse(r.POLYGON_GEOJSON) : r.POLYGON_GEOJSON,
    })));
    if (!tRows.length || !iRows.length || !eRows.length) {
      setSeedHint(`Tables are empty for region "${regionName}". Click "Generate seed data" to populate them, or run a Data Studio job for this region.`);
    } else {
      setSeedHint(null);
    }
  }, [regionName]);

  useEffect(() => {
    if (!regionName) return;
    (async () => {
      try {
        const safeRegion = regionName.replace(/'/g, "''");
        const cfg = await sfQuery(`SELECT REGION, VEHICLE_TYPE FROM ${BM_DB}.${BM_SCHEMA}.CONFIG`);
        const cur = (cfg[0] as any) || {};
        const vtRows = await sfQuery(
          `SELECT VEHICLE_TYPE, COUNT(*) AS N FROM SYNTHETIC_DATASETS.UNIFIED.DIM_FLEET
           WHERE REGION = '${safeRegion}' GROUP BY 1 ORDER BY N DESC LIMIT 1`,
          'SYNTHETIC_DATASETS', 'UNIFIED',
        );
        const detectedVt = (vtRows[0] as any)?.VEHICLE_TYPE;
        const safeVt = (detectedVt && String(detectedVt).replace(/'/g, "''")) || cur.VEHICLE_TYPE || 'hgv';
        if (cur.REGION !== regionName || (detectedVt && cur.VEHICLE_TYPE !== detectedVt)) {
          await sfQuery(
            `UPDATE ${BM_DB}.${BM_SCHEMA}.CONFIG SET REGION = '${safeRegion}', VEHICLE_TYPE = '${safeVt}'`,
          );
        }
        try {
          await sfQuery(
            `UPDATE FLEET_INTELLIGENCE.ROUTE_OPTIMIZATION.CONFIG SET REGION = '${safeRegion}', VEHICLE_TYPE = '${safeVt}'`,
            'FLEET_INTELLIGENCE', 'ROUTE_OPTIMIZATION',
          );
        } catch (e) {
          console.warn('[BM] ROUTE_OPTIMIZATION.CONFIG sync failed', e);
        }
      } catch (e) {
        console.warn('[BM] CONFIG sync failed', e);
      }
      await refetch();
    })();
  }, [regionName, refetch]);

  const seedData = useCallback(async () => {
    if (!regionName || seeding) return;
    setSeeding(true);
    setSeedHint('Generating seed data...');
    try {
      const r = await fetch('/api/backload/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: regionName }),
      });
      const j = await r.json();
      if (j.status !== 'ok') throw new Error(j.error || 'seed failed');
      await refetch();
    } catch (e: any) {
      setSeedHint(`Seed failed: ${e.message?.slice(0, 200)}`);
    } finally {
      setSeeding(false);
    }
  }, [regionName, seeding, refetch]);

  // -----------------------------------------------------------------
  // Solve — every visible knob lands inside the OPTIMIZATION call.
  // -----------------------------------------------------------------
  const solve = useCallback(async () => {
    if (!trailers.length) return;
    setSolving(true); setAssignments([]); setUnassigned([]); setRationale({}); setConfirmMsg(null); setSolverLog(null); setSolveError(null);

    // (1) Fast-fail wake up: if any required service is suspended, kick a resume
    //     and wait up to ~90s for SHOW SERVICES to flip to RUNNING. The flag flips
    //     BEFORE the ORS graph finishes loading though, so step (2) is required.
    const probe = await fetchSvcStatus();
    setSvcStatus(probe);
    if (!probe.every(s => s.status === 'RUNNING' && s.cur >= s.tgt)) {
      setSolverLog('Routing services are suspended/warming. Resuming before solve...');
      await wakeUp();
    }

    // (2) Strong readiness probe: ORS_STATUS reports service_ready=true ONLY
    //     when the routing graph for `regionName` is fully loaded into the
    //     ORS process. Without this check the gateway's matrix pre-compute
    //     hits a half-warm ORS, returns 5xx, and the gateway silently falls
    //     back to per-leg VROOM routing — the canonical "hang for several
    //     minutes" failure mode this Solve button has shown.
    if (regionName) {
      setSolverLog('Verifying ORS graph readiness...');
      const deadline = Date.now() + 60_000;
      let lastReason: string | undefined;
      while (Date.now() < deadline) {
        const r = await isOrsRegionReady(regionName);
        if (r.ready) { lastReason = undefined; break; }
        lastReason = r.reason;
        await new Promise(res => setTimeout(res, 5000));
      }
      if (lastReason) {
        setSolveError(
          `ORS for region "${regionName}" is not ready (${lastReason}). ` +
          `Click "Wake services" or wait for the graph to finish loading and try again.`,
        );
        setSolving(false);
        return;
      }
    }

    const profile = orsProfile || profileForVehicleType(vehicleType);
    const firstTrailer = trailers[0];
    const fallbackLon = firstTrailer ? Number(firstTrailer.HOME_LON) : null;
    const fallbackLat = firstTrailer ? Number(firstTrailer.HOME_LAT) : null;
    const effSharedLon = sharedDestLon ?? fallbackLon;
    const effSharedLat = sharedDestLat ?? fallbackLat;
    const trailerById = new Map<number, Trailer>();
    const trailerEnd = (t: Trailer): [number, number] | null => {
      if (endMode === 'open') return null;
      if (endMode === 'shared' && effSharedLon !== null && effSharedLat !== null) {
        return [effSharedLon, effSharedLat];
      }
      return [Number(t.HOME_LON), Number(t.HOME_LAT)];
    };
    // Effective €/h for VROOM = real €/h + €/km * km/h (folds per-km cost into per-hour).
    // VROOM v1.0.4 (the deployed regional build) does NOT support
    // vehicle.costs.per_hour — that field was added in upstream VROOM v1.13.
    // When present it silently rejects the entire payload (0 rows back). Until
    // the gateway upgrades VROOM, we fold the user's €/h slider into an
    // equivalent €/km via the assumed average HGV speed (60 km/h) and send
    // costs.per_km, which v1.0.4 does honour.
    const effPerKmEur = costPerKmEur + costPerHourEur / KMH_HGV;
    // Avoid-polygon GeoJSON list (Card F).
    const avoidGeoJSON = selectedAvoidZoneIds
      .map(id => avoidZones.find(z => z.ZONE_ID === id)?.POLYGON_GEOJSON)
      .filter(Boolean);

    // Pick a common shift start (earliest trailer ETA, fallback now).
    const nowSec = Math.floor(Date.now() / 1000);
    const etaSeconds = trailers
      .map(t => Math.floor(new Date(t.ETA_TS || 0).getTime() / 1000))
      .filter(s => Number.isFinite(s) && s > 0);
    const shiftStartSec = etaSeconds.length ? Math.min(...etaSeconds) : nowSec;
    const shiftEndSec   = shiftStartSec + Math.round(shiftLengthHrs * 3600);

    const vrpVehicles = trailers.slice(0, BM_MAX_VEHICLES).map((t, i) => {
      const id = i + 1;
      trailerById.set(id, t);
      const endPt = trailerEnd(t);
      const idealEnd = endPt ?? [Number(t.HOME_LON), Number(t.HOME_LAT)];
      const idealKm  = haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, idealEnd[0], idealEnd[1]);
      const idealHrs = idealKm / KMH_HGV;
      const capacityKg = Number(t.MAX_PAYLOAD_KG) || 24000;

      const veh: any = {
        id,
        profile,
        start: [Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)],
        capacity: useMultiDimCapacity
          ? [capacityKg,
             Number(t.MAX_PALLETS) || synthPallets(capacityKg),
             Number(t.MAX_VOLUME_M3) || synthVolumeM3(capacityKg)]
          : [capacityKg],
        skills: t.HAZMAT_CERT ? [1, 2, 3] : [1, 2],
        max_tasks: maxStops,
        max_travel_time: Math.max(1800, Math.round((idealHrs + detourSlackHrs) * 3600)),
        // max_distance is a hard cap on the WHOLE tour (empty + loaded legs).
        // The "ideal empty trip" alone is rarely a useful baseline because the
        // tour with a backload always exceeds it. Use a generous baseline:
        //   max(2 × idealEmptyKm, 200 km) × (1 + dev%/100)
        // and floor at 100 km so VROOM never sees a degenerate value.
        max_distance: Math.max(
          100_000,
          Math.round(Math.max(idealKm * 2, 200) * (1 + deviationPct / 100) * 1000),
        ),
        costs: {
          fixed:  Math.round(fixedDispatchEur * COST_SCALE),
          per_km: Math.round(effPerKmEur      * COST_SCALE),
        },
      };

      if (endPt) veh.end = endPt;

      // Card D: vehicle shift / hours-of-service.
      if (enforceShift) veh.time_window = [shiftStartSec, shiftEndSec];

      // Card A: EU driver break (45 min after 4.5h, by default).
      if (enforceDriverBreak) {
        const breakStart = shiftStartSec + Math.round(breakAfterHrs * 3600);
        const breakLatest = shiftStartSec + Math.round((breakAfterHrs + 1.5) * 3600);
        veh.breaks = [{
          id: 1,
          service: Math.round(breakLengthMin * 60),
          time_windows: [[breakStart, breakLatest]],
        }];
      }

      // Card F (avoid polygons): the routing gateway does not yet forward
      // `vehicle.profile_options.avoid_polygons` to the ORS matrix call, so
      // we must not stuff this into the VROOM payload (some VROOM builds
      // reject unknown vehicle fields). The polygons are still drawn on the
      // map for visual context until the gateway is extended.
      // TODO: extend routing_gateway to honour avoid_polygons during matrix
      // pre-computation, then re-enable the payload field below.
      // if (avoidGeoJSON.length) {
      //   veh.profile_options = { avoid_polygons: { ... } };
      // }

      return veh;
    });

    const offerById = new Map<number, { kind: 'INTERNAL' | string; row: any }>();
    let nextId = 1000;
    const vrpShipments: any[] = [];

    const widenSec = Math.round(windowSlackHrs * 3600);
    const tw = (fromIso: string | null | undefined, toIso: string | null | undefined): number[][] | undefined => {
      if (!fromIso || !toIso) return undefined;
      const a = Math.floor(new Date(fromIso).getTime() / 1000);
      const b = Math.ceil(new Date(toIso).getTime() / 1000);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return undefined;
      const win1: number[] = [a - widenSec, b + widenSec];
      if (!useMultiWindow) return [win1];
      // Card B: synthesise an evening window 8 hours later.
      const win2: number[] = [win1[0] + 8 * 3600, win1[1] + 8 * 3600];
      return [win1, win2];
    };

    const internalSubset = internal.slice(0, BM_MAX_INTERNAL);
    const externalSubset = external.slice(0, BM_MAX_EXTERNAL);
    const internalSkipped = Math.max(0, internal.length - internalSubset.length);
    const externalSkipped = Math.max(0, external.length - externalSubset.length);

    for (const v of internalSubset) {
      const id = nextId++;
      offerById.set(id, { kind: 'INTERNAL', row: v });
      const kg = Math.min(Number(v.WEIGHT_KG), 24000);
      const amount = useMultiDimCapacity
        ? [kg, Number(v.PALLETS) || synthPallets(kg), Number(v.VOLUME_M3) || synthVolumeM3(kg)]
        : [kg];
      const windows = tw(v.PICKUP_FROM_TS, v.PICKUP_TO_TS);
      vrpShipments.push({
        pickup:   { id, location: [Number(v.PICKUP_LON),  Number(v.PICKUP_LAT)],  service: 1800, time_windows: windows },
        delivery: { id, location: [Number(v.DROPOFF_LON), Number(v.DROPOFF_LAT)], service: 600 },
        amount,
        skills: v.HAZMAT ? [1, 3] : [1],
        priority: internalFirstWeight,
      });
    }
    for (const o of externalSubset) {
      const id = nextId++;
      offerById.set(id, { kind: o.SOURCE, row: o });
      const kg = Math.min(Number(o.WEIGHT_KG), 24000);
      const amount = useMultiDimCapacity
        ? [kg, Number(o.PALLETS) || synthPallets(kg), Number(o.VOLUME_M3) || synthVolumeM3(kg)]
        : [kg];
      const windows = tw(o.PICKUP_FROM_TS, o.PICKUP_TO_TS);
      vrpShipments.push({
        pickup:   { id, location: [Number(o.PICKUP_LON),  Number(o.PICKUP_LAT)],  service: 1800, time_windows: windows },
        delivery: { id, location: [Number(o.DROPOFF_LON), Number(o.DROPOFF_LAT)], service: 600 },
        amount,
        skills: o.HAZMAT ? [2, 3] : [2],
        priority: Math.max(0, 100 - internalFirstWeight),
      });
    }

    // (3) Build a setup an AbortController + wall-clock deadline so the user
    //     can cancel and so we surface a precise error instead of waiting
    //     forever. Server-side polling caps at 600s and the browser had no
    //     way to break out before this fix.
    const ac = new AbortController();
    solveAbortRef.current = ac;
    const deadlineHandle = setTimeout(() => ac.abort(), BM_SOLVE_TIMEOUT_MS);

    // (4) Pre-compute the VROOM matrix from the UI rather than relying on the
    //     gateway's hidden in-request pre-compute. This makes each step
    //     observable, lets us cap location count up-front, and avoids the
    //     silent fallback to per-leg VROOM routing when the in-gateway
    //     matrix call exceeds its 120s timeout on continental graphs.
    let precomputedMatrix: { durations: number[][]; costs: number[][] } | null = null;
    let matrixNote = '';
    try {
      const uniq = new Map<string, [number, number]>();
      const addLoc = (lon: number, lat: number) => {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
        if (!uniq.has(key)) uniq.set(key, [lon, lat]);
      };
      for (const v of vrpVehicles) {
        if (v.start) addLoc(Number(v.start[0]), Number(v.start[1]));
        if (v.end)   addLoc(Number(v.end[0]),   Number(v.end[1]));
      }
      for (const sh of vrpShipments) {
        if (sh?.pickup?.location)   addLoc(Number(sh.pickup.location[0]),   Number(sh.pickup.location[1]));
        if (sh?.delivery?.location) addLoc(Number(sh.delivery.location[0]), Number(sh.delivery.location[1]));
      }
      const locs: [number, number][] = Array.from(uniq.values());
      if (locs.length > BM_MAX_MATRIX_LOCATIONS) {
        matrixNote = `Skipped UI matrix pre-compute (${locs.length} locations > cap ${BM_MAX_MATRIX_LOCATIONS}); falling back to gateway pre-compute.`;
      } else if (locs.length >= 2) {
        setSolverLog(`Pre-computing ${locs.length}x${locs.length} matrix...`);
        precomputedMatrix = await buildVroomMatrix(profile, locs, regionName || null, { signal: ac.signal });
        // Re-key shipment / vehicle locations into matrix indices.
        const indexFor = (lon: number, lat: number) =>
          locs.findIndex(([lo, la]) => Math.abs(lo - lon) < 1e-9 && Math.abs(la - lat) < 1e-9);
        if (precomputedMatrix) {
          for (const v of vrpVehicles) {
            if (v.start) {
              const i = indexFor(Number(v.start[0]), Number(v.start[1]));
              if (i >= 0) (v as any).start_index = i;
            }
            if (v.end) {
              const i = indexFor(Number(v.end[0]), Number(v.end[1]));
              if (i >= 0) (v as any).end_index = i;
            }
          }
          for (const sh of vrpShipments) {
            if (sh.pickup?.location) {
              const i = indexFor(Number(sh.pickup.location[0]), Number(sh.pickup.location[1]));
              if (i >= 0) sh.pickup.location_index = i;
            }
            if (sh.delivery?.location) {
              const i = indexFor(Number(sh.delivery.location[0]), Number(sh.delivery.location[1]));
              if (i >= 0) sh.delivery.location_index = i;
            }
          }
        } else {
          matrixNote = 'UI matrix pre-compute returned no data; gateway will retry inline.';
        }
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        clearTimeout(deadlineHandle);
        setSolveError('Solve cancelled.');
        setSolving(false);
        solveAbortRef.current = null;
        return;
      }
      matrixNote = `UI matrix pre-compute failed (${e?.message || e}); gateway will retry inline.`;
    }

    const challenge: any = { vehicles: vrpVehicles, shipments: vrpShipments };
    if (precomputedMatrix) {
      challenge.matrices = { [profile]: precomputedMatrix };
      challenge.options = { g: false };
    } else {
      challenge.options = { g: true };
    }
    const jsonStr = JSON.stringify(challenge).replace(/'/g, "''");
    const sql = `SELECT * FROM TABLE(OPENROUTESERVICE_APP.CORE.OPTIMIZATION(PARSE_JSON('${jsonStr}'), '${regionName}'))`;
    console.log('[BM] OPTIMIZATION challenge:',
      'vehicles=', vrpVehicles.length,
      'shipments=', vrpShipments.length,
      'region=', regionName,
      'maxStops=', maxStops,
      'devPct=', deviationPct,
      'eurPerKm(eff)=', effPerKmEur,
      'breaks=', enforceDriverBreak,
      'avoid=', avoidGeoJSON.length,
      'matrix=', precomputedMatrix ? `${precomputedMatrix.durations.length}^2 (UI pre-computed)` : 'gateway-side');
    let rows: any[] = [];
    try {
      rows = await sfQuery(sql, 'OPENROUTESERVICE_APP', 'CORE', { signal: ac.signal, throwOnError: true });
    } catch (e: any) {
      clearTimeout(deadlineHandle);
      solveAbortRef.current = null;
      if (e?.name === 'AbortError') {
        setSolveError(
          `Solve cancelled or timed out after ${Math.round(BM_SOLVE_TIMEOUT_MS / 1000)}s. ` +
          `Try lowering Max stops, deviation %, or disabling Multi-window pickups.`,
        );
      } else {
        setSolveError(`OPTIMIZATION call failed: ${e?.message || e}`);
      }
      setSolving(false);
      return;
    }
    clearTimeout(deadlineHandle);
    solveAbortRef.current = null;

    const newAssignments: Assignment[] = [];
    const newUnassigned: { id: number; reason?: string }[] = [];
    for (const r of rows) {
      const vehId = Number(r.VEHICLE);
      if (!vehId) {
        try {
          const ua = typeof r.UNASSIGNED === 'string' ? JSON.parse(r.UNASSIGNED) : r.UNASSIGNED;
          if (Array.isArray(ua)) for (const u of ua) newUnassigned.push({ id: Number(u.id), reason: u.reason });
        } catch {}
        continue;
      }
      const t = trailerById.get(vehId);
      if (!t) continue;
      let steps: any[] = [];
      try { steps = typeof r.STEPS === 'string' ? JSON.parse(r.STEPS) : (r.STEPS || []); } catch {}
      let routeGeo: any = null;
      try { routeGeo = typeof r.GEOJSON === 'string' ? JSON.parse(r.GEOJSON) : r.GEOJSON; } catch {}

      const taskSteps = steps.filter((s: any) =>
        s.type === 'pickup' || s.type === 'delivery' || s.type === 'job' || s.type === 'break');
      if (!taskSteps.length) continue;
      const firstPick = taskSteps.find((s: any) => s.type === 'pickup' || s.type === 'job');
      if (!firstPick) continue;
      const firstId = Number(firstPick.id ?? firstPick.job);
      const ent = offerById.get(firstId);
      if (!ent) continue;
      const row: any = ent.row;
      const empty = haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, row.PICKUP_LON, row.PICKUP_LAT);
      const loaded = haversineKm(row.PICKUP_LON, row.PICKUP_LAT, row.DROPOFF_LON, row.DROPOFF_LAT);

      // Build STOPS list (Card J wait-time + Card A breaks included).
      const stops: Stop[] = [];
      stops.push({
        kind: 'start',
        label: 'Trailer idle location',
        city: t.DROPOFF_CITY,
        lon: Number(t.DROPOFF_LON),
        lat: Number(t.DROPOFF_LAT),
      });
      let totalLoadedKm = 0;
      let prevLon: number | null = null, prevLat: number | null = null;
      for (const ts of taskSteps) {
        const sid = Number(ts.id ?? ts.job);
        const wait = Number(ts.waiting_time) || 0;
        if (ts.type === 'break') {
          // Card A: a break has no location returned in some VROOM versions;
          // if the previous step's location is known, anchor it there, else
          // skip drawing a marker but still display in StopsPanel.
          const lon = Number(ts.location?.[0]) || prevLon || Number(t.DROPOFF_LON);
          const lat = Number(ts.location?.[1]) || prevLat || Number(t.DROPOFF_LAT);
          stops.push({
            kind: 'break',
            label: `Driver break (${Math.round((Number(ts.service) || breakLengthMin * 60) / 60)} min)`,
            lon, lat,
            waitSec: wait,
            serviceSec: Number(ts.service) || breakLengthMin * 60,
          });
          continue;
        }
        const je = offerById.get(sid);
        if (!je) continue;
        const jr: any = je.row;
        const offerId = je.kind === 'INTERNAL' ? jr.ID : jr.OFFER_ID;
        if (ts.type === 'delivery') {
          if (prevLon !== null && prevLat !== null) {
            totalLoadedKm += haversineKm(prevLon, prevLat, Number(jr.DROPOFF_LON), Number(jr.DROPOFF_LAT));
          }
          stops.push({
            kind: 'dropoff',
            label: `${je.kind} ${offerId}`,
            city: jr.DROPOFF_CITY,
            lon: Number(jr.DROPOFF_LON),
            lat: Number(jr.DROPOFF_LAT),
            jobId: sid, offerId, source: je.kind, product: jr.PRODUCT,
            weightKg: Number(jr.WEIGHT_KG) || undefined,
            waitSec: wait,
          });
          prevLon = Number(jr.DROPOFF_LON); prevLat = Number(jr.DROPOFF_LAT);
        } else {
          stops.push({
            kind: 'pickup',
            label: `${je.kind} ${offerId}`,
            city: jr.PICKUP_CITY,
            lon: Number(jr.PICKUP_LON),
            lat: Number(jr.PICKUP_LAT),
            jobId: sid, offerId, source: je.kind, product: jr.PRODUCT,
            weightKg: Number(jr.WEIGHT_KG) || undefined,
            waitSec: wait,
          });
          prevLon = Number(jr.PICKUP_LON); prevLat = Number(jr.PICKUP_LAT);
          if (ts.type === 'job') {
            // legacy fallback: synthesise a dropoff after a job step
            stops.push({
              kind: 'dropoff',
              label: `${je.kind} ${offerId}`,
              city: jr.DROPOFF_CITY,
              lon: Number(jr.DROPOFF_LON),
              lat: Number(jr.DROPOFF_LAT),
              jobId: sid, offerId, source: je.kind, product: jr.PRODUCT,
              weightKg: Number(jr.WEIGHT_KG) || undefined,
            });
            prevLon = Number(jr.DROPOFF_LON); prevLat = Number(jr.DROPOFF_LAT);
          }
        }
      }
      const endPt = endMode === 'open'
        ? null
        : (endMode === 'shared' && effSharedLon !== null && effSharedLat !== null
            ? [effSharedLon, effSharedLat] as [number, number]
            : [Number(t.HOME_LON), Number(t.HOME_LAT)] as [number, number]);
      const endLon = endPt ? endPt[0] : (prevLon ?? Number(t.HOME_LON));
      const endLat = endPt ? endPt[1] : (prevLat ?? Number(t.HOME_LAT));
      stops.push({
        kind: 'end',
        label: endMode === 'open'
          ? 'Tour ends here (open-ended)'
          : (endMode === 'shared' ? 'Shared destination' : 'Home depot'),
        city: endMode === 'home' ? t.HOME_DEPOT : undefined,
        lon: endLon,
        lat: endLat,
      });

      const offerIdFirst = ent.kind === 'INTERNAL' ? row.ID : row.OFFER_ID;
      const directHomeKm = haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, endLon, endLat);
      const tourKm =
        haversineKm(t.DROPOFF_LON, t.DROPOFF_LAT, row.PICKUP_LON, row.PICKUP_LAT) +
        haversineKm(row.PICKUP_LON, row.PICKUP_LAT, row.DROPOFF_LON, row.DROPOFF_LAT) +
        haversineKm(row.DROPOFF_LON, row.DROPOFF_LAT, endLon, endLat);
      const detourKm = Math.max(0, tourKm - directHomeKm);
      const savedKm  = Math.max(0, directHomeKm - detourKm);

      // Post-solve economics — VROOM returns DURATION (sec); DISTANCE may be
      // present as meters depending on solver version.
      const tourSec   = Number(r.DURATION) || 0;
      const tourHrs   = tourSec / 3600;
      const tourKmReal = (Number(r.DISTANCE) || (tourSec * KMH_HGV / 3600 * 1000)) / 1000;
      const waitSec   = taskSteps.reduce((s: number, ts: any) => s + (Number(ts.waiting_time) || 0), 0);
      const nDeliv    = taskSteps.filter((s: any) => s.type === 'delivery' || s.type === 'job').length;

      // Revenue: external offers carry PRICE_EUR; internal volumes price by
      // €/loaded-km × allocated loaded km (= sum of loaded segments inside
      // this trailer's tour). For the demo we approximate per-shipment loaded
      // km with the haversine pickup→dropoff for the first shipment only.
      let revenue = 0;
      for (const ts of taskSteps) {
        if (ts.type !== 'pickup' && ts.type !== 'job') continue;
        const sid = Number(ts.id ?? ts.job);
        const je = offerById.get(sid);
        if (!je) continue;
        const jr: any = je.row;
        const segLoadedKm = haversineKm(Number(jr.PICKUP_LON), Number(jr.PICKUP_LAT), Number(jr.DROPOFF_LON), Number(jr.DROPOFF_LAT));
        if (je.kind === 'INTERNAL') revenue += segLoadedKm * internalRatePerKm;
        else revenue += Number(jr.PRICE_EUR) || segLoadedKm * internalRatePerKm;
      }
      const cost = fixedDispatchEur
                 + tourHrs * costPerHourEur
                 + tourKmReal * costPerKmEur
                 + nDeliv * costPerDeliveryEur;
      const netBenefit = revenue - cost;

      newAssignments.push({
        ASSIGNMENT_ID: `${t.TRAILER_ID}|${offerIdFirst}`,
        TRAILER_ID: t.TRAILER_ID,
        OFFER_ID: offerIdFirst,
        SOURCE: ent.kind,
        PICKUP_LON: row.PICKUP_LON, PICKUP_LAT: row.PICKUP_LAT,
        DROPOFF_LON: row.DROPOFF_LON, DROPOFF_LAT: row.DROPOFF_LAT,
        TRAILER_DROPOFF_LON: t.DROPOFF_LON, TRAILER_DROPOFF_LAT: t.DROPOFF_LAT,
        HOME_LON: t.HOME_LON, HOME_LAT: t.HOME_LAT,
        EMPTY_KM: empty, LOADED_KM: totalLoadedKm || loaded,
        DETOUR_KM: detourKm, SAVED_KM: savedKm,
        SCORE: Number(r.DURATION) || 0,
        PRODUCT: row.PRODUCT,
        PICKUP_CITY: row.PICKUP_CITY,
        PROPOSAL_DROPOFF_CITY: row.DROPOFF_CITY,
        ROUTE_GEOJSON: routeGeo,
        STOPS: stops,
        TOUR_KM: tourKmReal,
        TOUR_HRS: tourHrs,
        WAIT_SEC: waitSec,
        N_DELIVERIES: nDeliv,
        COST_EUR: cost,
        REVENUE_EUR: revenue,
        NET_BENEFIT_EUR: netBenefit,
      });
    }
    setAssignments(newAssignments);
    setUnassigned(newUnassigned);
    const avgDetour = newAssignments.length
      ? Math.round(newAssignments.reduce((s, a) => s + (a.DETOUR_KM || 0), 0) / newAssignments.length)
      : 0;
    const totalNet = Math.round(newAssignments.reduce((s, a) => s + (a.NET_BENEFIT_EUR || 0), 0));
    setSolverLog(
      `Sent ${vrpVehicles.length} vehicles, ${vrpShipments.length} shipments ` +
      `(maxStops=${maxStops}, dev=${deviationPct}%, slack=+${detourSlackHrs}h, ` +
      `intFirst=${internalFirstWeight}, breaks=${enforceDriverBreak ? 'on' : 'off'}, ` +
      `multiDim=${useMultiDimCapacity ? 'on' : 'off'}, end=${endMode}, ` +
      `avoidZones=${selectedAvoidZoneIds.length}; skipped ${internalSkipped} internal, ` +
      `${externalSkipped} external; region=${regionName}, profile=${profile}, ` +
      `matrix=${precomputedMatrix ? `UI ${precomputedMatrix.durations.length}^2` : 'gateway-side'}). ` +
      (matrixNote ? `${matrixNote} ` : '') +
      `Got ${rows.length} rows → ${newAssignments.length} assigned, ${newUnassigned.length} unassigned. ` +
      `Avg detour +${avgDetour} km. Net benefit total €${totalNet.toLocaleString()}.`
    );
    // When VROOM rejects the payload (e.g. unknown vehicle field), the
    // OPTIMIZATION TVF returns rows whose RESPONSE column carries an
    // {error, code} object even though VEHICLE is null. Surface that text
    // verbatim so we don't masquerade real errors as "0 rows".
    let vroomErr: string | null = null;
    for (const r of rows) {
      const resp: any = (r as any).RESPONSE;
      try {
        const obj = typeof resp === 'string' ? JSON.parse(resp) : resp;
        if (obj && (obj.error || (obj.code && obj.message))) {
          vroomErr = String(obj.error || obj.message);
          break;
        }
      } catch {}
    }
    if (vroomErr) {
      setSolveError(`VROOM rejected the request: ${vroomErr}`);
    } else if (rows.length === 0 && vrpShipments.length > 0) {
      setSolveError(
        `OPTIMIZATION returned 0 rows. Check: (1) all required ORS services RUNNING, ` +
        `(2) region='${regionName}' covers your data bbox, ` +
        `(3) profile='${profile}' is supported by ORS_SERVICE_${(regionName || '').toUpperCase()}, ` +
        `(4) constraints aren't too tight (try raising deviation %, detour slack, or window slack), ` +
        `(5) no unknown vehicle/job fields (e.g. costs.per_hour requires VROOM v1.13+).`
      );
    }

    Promise.all(newAssignments.map(async (a) => {
      const key = `${a.TRAILER_ID}|${a.OFFER_ID}`;
      const cached = emptyLegCacheRef.current.get(key);
      if (cached) { a.EMPTY_GEOJSON = cached; return; }
      const dirSql = `SELECT ST_ASGEOJSON(GEOJSON)::VARCHAR AS GEOJSON FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS('${profile}', ARRAY_CONSTRUCT(${a.TRAILER_DROPOFF_LON}::FLOAT, ${a.TRAILER_DROPOFF_LAT}::FLOAT), ARRAY_CONSTRUCT(${a.PICKUP_LON}::FLOAT, ${a.PICKUP_LAT}::FLOAT), '${regionName}'))`;
      const dirRows = await sfQuery(dirSql, 'OPENROUTESERVICE_APP', 'CORE');
      try {
        const geo = dirRows[0]?.GEOJSON ? (typeof dirRows[0].GEOJSON === 'string' ? JSON.parse(dirRows[0].GEOJSON) : dirRows[0].GEOJSON) : null;
        if (geo) { emptyLegCacheRef.current.set(key, geo); a.EMPTY_GEOJSON = geo; }
      } catch (e) { console.warn('[BM] empty-leg DIRECTIONS parse failed', e); }
    })).then(() => setAssignments([...newAssignments]));

    setSolving(false);
  }, [
    trailers, internal, external, regionName, vehicleType, orsProfile,
    maxStops, detourSlackHrs, deviationPct, internalFirstWeight, windowSlackHrs,
    endMode, sharedDestLon, sharedDestLat,
    costPerHourEur, costPerKmEur, fixedDispatchEur, costPerDeliveryEur, internalRatePerKm,
    enforceDriverBreak, breakAfterHrs, breakLengthMin,
    enforceShift, shiftLengthHrs,
    useMultiDimCapacity, useMultiWindow, selectedAvoidZoneIds, avoidZones,
    fetchSvcStatus, wakeUp,
  ]);

  const askRationale = useCallback(async (a: Assignment) => {
    setRationaleLoading(true);
    const prompt = `You are a fleet dispatcher coach. In two short sentences, explain why trailer ${a.TRAILER_ID} (idle in ${trailers.find(t=>t.TRAILER_ID===a.TRAILER_ID)?.DROPOFF_CITY || ''}) is a good match for ${a.SOURCE} offer ${a.OFFER_ID} (${a.PICKUP_CITY} -> ${a.PROPOSAL_DROPOFF_CITY}, ${Math.round(a.EMPTY_KM)} km empty, net €${Math.round(a.NET_BENEFIT_EUR || 0)}, ${a.PRODUCT}). Mention empty km saved, profitability, and direction-to-home if relevant.`;
    const sql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${prompt.replace(/'/g, "''")}') AS RESULT`;
    const rows = await sfQuery(sql, 'SNOWFLAKE', 'CORTEX');
    const text = (rows[0]?.RESULT || '').toString().trim();
    setRationale(prev => ({ ...prev, [a.ASSIGNMENT_ID]: text || '(no rationale returned)' }));
    setRationaleLoading(false);
  }, [trailers]);

  const confirmPlan = useCallback(async () => {
    if (!assignments.length) return;
    setConfirming(true); setConfirmMsg(null);
    await sfQuery(`CREATE SCHEMA IF NOT EXISTS ${BM_DB}.${BM_SCHEMA}`);
    await sfQuery(`CREATE TABLE IF NOT EXISTS ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS (
      DECISION_ID    VARCHAR DEFAULT UUID_STRING() PRIMARY KEY,
      TRAILER_ID     VARCHAR,
      OFFER_ID       VARCHAR,
      SOURCE         VARCHAR,
      SCORE          FLOAT,
      EMPTY_KM       FLOAT,
      NET_BENEFIT_EUR FLOAT,
      DECIDED_BY     VARCHAR,
      DECIDED_AT     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
      RATIONALE      VARCHAR
    ) COMMENT = '{"origin":"sf_sit-is-fleet","name":"oss-backload-matching","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`);
    // Best-effort add column for older deployments.
    try { await sfQuery(`ALTER TABLE ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS ADD COLUMN IF NOT EXISTS NET_BENEFIT_EUR FLOAT`); } catch {}
    const values = assignments.map(a => {
      const r = (rationale[a.ASSIGNMENT_ID] || '').replace(/'/g, "''").slice(0, 500);
      const net = (a.NET_BENEFIT_EUR ?? 0).toFixed(2);
      return `('${a.TRAILER_ID}', '${a.OFFER_ID}', '${a.SOURCE}', ${a.SCORE.toFixed(2)}, ${a.EMPTY_KM.toFixed(2)}, ${net}, 'demo-user', '${r}')`;
    }).join(',\n');
    const insertSql = `INSERT INTO ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS (TRAILER_ID, OFFER_ID, SOURCE, SCORE, EMPTY_KM, NET_BENEFIT_EUR, DECIDED_BY, RATIONALE) VALUES\n${values}`;
    await sfQuery(insertSql);
    setConfirmMsg(`Wrote ${assignments.length} decisions to ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS.`);
    setConfirming(false);
  }, [assignments, rationale]);

  const [auditRows, setAuditRows] = useState<any[]>([]);
  const loadAudit = useCallback(async () => {
    const sql = `SELECT TO_VARCHAR(DECIDED_AT, 'YYYY-MM-DD HH24:MI') AS DECIDED_AT, TRAILER_ID, OFFER_ID, SOURCE, ROUND(EMPTY_KM,1) AS EMPTY_KM, ROUND(COALESCE(NET_BENEFIT_EUR, EMPTY_KM * ${EUR_PER_LOADED_KM}), 0) AS EUR_RECLAIMED FROM ${BM_DB}.${BM_SCHEMA}.PROPOSAL_DECISIONS ORDER BY DECIDED_AT DESC LIMIT 25`;
    const rows = await sfQuery(sql);
    setAuditRows(rows);
  }, []);
  useEffect(() => { loadAudit(); }, [loadAudit, confirmMsg]);

  // Hide-unprofitable filter applies to list AND map.
  const visibleAssignments = useMemo(() => {
    const base = hideUnprofitable
      ? assignments.filter(a => (a.NET_BENEFIT_EUR ?? 0) >= 0)
      : assignments;
    return [...base].sort(
      (a, b) => (b.NET_BENEFIT_EUR ?? -Infinity) - (a.NET_BENEFIT_EUR ?? -Infinity),
    );
  }, [assignments, hideUnprofitable]);

  const totalEmptyKm = useMemo(() => visibleAssignments.reduce((s, a) => s + a.EMPTY_KM, 0), [visibleAssignments]);
  const totalLoadedKm = useMemo(() => visibleAssignments.reduce((s, a) => s + a.LOADED_KM, 0), [visibleAssignments]);
  const totalNetBenefit = useMemo(() => Math.round(visibleAssignments.reduce((s, a) => s + (a.NET_BENEFIT_EUR || 0), 0)), [visibleAssignments]);
  const internalCount = useMemo(() => visibleAssignments.filter(a => a.SOURCE === 'INTERNAL').length, [visibleAssignments]);
  const internalPct = visibleAssignments.length ? Math.round((internalCount / visibleAssignments.length) * 100) : 0;
  const trailersAssignedPct = trailers.length ? Math.round((visibleAssignments.length / Math.min(trailers.length, 30)) * 100) : 0;

  const basemap = useMemo(() => cartoBasemap(), []);
  const layers = useMemo(() => {
    const result: any[] = [basemap];
    // Card F: render selected avoid polygons.
    if (selectedAvoidZoneIds.length) {
      const zones = avoidZones.filter(z => selectedAvoidZoneIds.includes(z.ZONE_ID));
      if (zones.length) {
        result.push(new GeoJsonLayer({
          id: 'avoid-zones',
          data: { type: 'FeatureCollection', features: zones.map(z => ({ type: 'Feature', properties: { name: z.NAME }, geometry: z.POLYGON_GEOJSON })) },
          stroked: true, filled: true,
          getFillColor: [239, 68, 68, 40], getLineColor: [239, 68, 68, 220],
          lineWidthMinPixels: 2, pickable: true,
        }));
      }
    }
    if (external.length) {
      result.push(new ScatterplotLayer({
        id: 'ext-offers', data: external, getPosition: (d: Offer) => [Number(d.PICKUP_LON), Number(d.PICKUP_LAT)],
        getFillColor: [200, 200, 200, 160], getLineColor: [120, 120, 120, 220],
        stroked: true, lineWidthMinPixels: 1, getRadius: 600, radiusMinPixels: 3, radiusMaxPixels: 5, pickable: true,
      }));
    }
    if (internal.length) {
      result.push(new ScatterplotLayer({
        id: 'int-vols', data: internal, getPosition: (d: Volume) => [Number(d.PICKUP_LON), Number(d.PICKUP_LAT)],
        getFillColor: [41, 181, 232, 220], getRadius: 800, radiusMinPixels: 4, radiusMaxPixels: 6, pickable: true,
      }));
    }
    if (trailers.length) {
      result.push(new ScatterplotLayer({
        id: 'trailers', data: trailers, getPosition: (d: Trailer) => [Number(d.DROPOFF_LON), Number(d.DROPOFF_LAT)],
        getFillColor: [13, 176, 72, 240], getLineColor: [255, 255, 255, 255],
        stroked: true, lineWidthMinPixels: 1, getRadius: 1200, radiusMinPixels: 5, radiusMaxPixels: 9, pickable: true,
      }));
    }
    const hasSel = !!selectedAssignment;
    const loadedPaths = visibleAssignments
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => !!a.ROUTE_GEOJSON)
      .map(({ a, i }) => ({
        idx: i,
        path: coordsFromGeoJSON(a.ROUTE_GEOJSON),
        isSel: a.ASSIGNMENT_ID === selectedAssignment,
      }));
    result.push(new PathLayer({
      id: 'loaded-routes',
      data: loadedPaths,
      getPath: (d: any) => d.path,
      getColor: (d: any) => {
        const c = ROUTE_COLORS[d.idx % ROUTE_COLORS.length];
        const a = d.isSel ? 255 : (hasSel ? 80 : 110);
        return [c[0], c[1], c[2], a];
      },
      getWidth: (d: any) => (d.isSel ? 6 : (hasSel ? 2 : 3)),
      widthUnits: 'pixels',
      widthMinPixels: 2,
      parameters: { depthTest: false },
      pickable: true,
      updateTriggers: {
        getColor: [selectedAssignment, hasSel],
        getWidth: [selectedAssignment, hasSel],
      },
    }));
    visibleAssignments.forEach((a, i) => {
      const isSel = a.ASSIGNMENT_ID === selectedAssignment;
      const emptyW = isSel ? 6 : (hasSel ? 2 : 4);
      const emptyAlpha = isSel ? 255 : (hasSel ? 140 : 255);
      result.push(new GeoJsonLayer({
        id: `empty-${i}`,
        data: (a.EMPTY_GEOJSON ? a.EMPTY_GEOJSON : { type:'Feature', geometry:{ type:'LineString', coordinates:[[a.TRAILER_DROPOFF_LON,a.TRAILER_DROPOFF_LAT],[a.PICKUP_LON,a.PICKUP_LAT]] } }) as any,
        stroked: true, getLineColor: [110, 110, 110, emptyAlpha], getDashArray: [10, 6], lineWidthMinPixels: emptyW,
        extensions: [new PathStyleExtension({ dash: true })],
        parameters: { depthTest: false },
      }));
    });
    if (selectedAssignment) {
      const a = visibleAssignments.find(x => x.ASSIGNMENT_ID === selectedAssignment);
      if (a) {
        const pickup = [{ lon: Number(a.PICKUP_LON), lat: Number(a.PICKUP_LAT) }];
        const lastStop = (a.STOPS && a.STOPS.length) ? a.STOPS[a.STOPS.length - 1] : null;
        const endLon = lastStop ? lastStop.lon : Number(a.DROPOFF_LON);
        const endLat = lastStop ? lastStop.lat : Number(a.DROPOFF_LAT);
        const dropoff = [{ lon: endLon, lat: endLat }];
        result.push(new ScatterplotLayer({
          id: 'sel-pickup-halo', data: pickup, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: [245, 158, 11, 50], getRadius: 160,
          radiusMinPixels: 18, radiusMaxPixels: 60, stroked: false, filled: true,
          parameters: { depthTest: false },
        }));
        result.push(new ScatterplotLayer({
          id: 'sel-pickup-marker', data: pickup, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: [255, 255, 255, 230], getLineColor: [245, 158, 11, 255],
          getRadius: 80, radiusMinPixels: 8, radiusMaxPixels: 30,
          lineWidthMinPixels: 3, stroked: true, filled: true,
          parameters: { depthTest: false },
        }));
        result.push(new ScatterplotLayer({
          id: 'sel-dropoff-halo', data: dropoff, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: [13, 176, 72, 50], getRadius: 160,
          radiusMinPixels: 18, radiusMaxPixels: 60, stroked: false, filled: true,
          parameters: { depthTest: false },
        }));
        result.push(new ScatterplotLayer({
          id: 'sel-dropoff-marker', data: dropoff, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: [255, 255, 255, 230], getLineColor: [13, 176, 72, 255],
          getRadius: 80, radiusMinPixels: 8, radiusMaxPixels: 30,
          lineWidthMinPixels: 3, stroked: true, filled: true,
          parameters: { depthTest: false },
        }));
      }
    }
    return result;
  }, [basemap, external, internal, trailers, visibleAssignments, selectedAssignment, avoidZones, selectedAvoidZoneIds]);

  const fitCoords = useMemo<LngLat[]>(() => {
    const out: LngLat[] = [];
    for (const t of trailers) {
      if (t.DROPOFF_LON != null && t.DROPOFF_LAT != null) out.push([Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)]);
    }
    for (const i of internal) {
      if (i.PICKUP_LON != null && i.PICKUP_LAT != null) out.push([Number(i.PICKUP_LON), Number(i.PICKUP_LAT)]);
      if ((i as any).DROPOFF_LON != null && (i as any).DROPOFF_LAT != null) out.push([Number((i as any).DROPOFF_LON), Number((i as any).DROPOFF_LAT)]);
    }
    for (const e of external) {
      if (e.PICKUP_LON != null && e.PICKUP_LAT != null) out.push([Number(e.PICKUP_LON), Number(e.PICKUP_LAT)]);
    }
    for (const a of visibleAssignments) {
      if (a.ROUTE_GEOJSON) out.push(...coordsFromGeoJSON(a.ROUTE_GEOJSON));
      if (a.EMPTY_GEOJSON) out.push(...coordsFromGeoJSON(a.EMPTY_GEOJSON));
    }
    return out;
  }, [trailers, internal, external, visibleAssignments]);

  const fallback = useMemo(() => ({ longitude: center.lng, latitude: center.lat, zoom, pitch: 0, bearing: 0 }), [center.lng, center.lat, zoom]);
  const { containerRef: mapContainerRef, dims: mapDims, viewState, setViewState, onViewStateChange, recenter } = useFitMap(fitCoords, { fallback, regionKey: regionName });

  useEffect(() => {
    if (!selectedAssignment || !mapDims) return;
    const a = visibleAssignments.find(x => x.ASSIGNMENT_ID === selectedAssignment);
    if (!a) return;
    const coords: LngLat[] = [
      [Number(a.TRAILER_DROPOFF_LON), Number(a.TRAILER_DROPOFF_LAT)],
      [Number(a.PICKUP_LON), Number(a.PICKUP_LAT)],
      [Number(a.DROPOFF_LON), Number(a.DROPOFF_LAT)],
      ...coordsFromGeoJSON(a.ROUTE_GEOJSON),
      ...coordsFromGeoJSON(a.EMPTY_GEOJSON),
    ];
    const fitted = fitBoundsToData({
      width: mapDims.width, height: mapDims.height,
      coords, padding: 60, maxZoom: 12, fallback: viewState,
    });
    if (fitted) setViewState({ ...viewState, ...fitted });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAssignment, visibleAssignments, mapDims]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.TRAILER_ID) return { html: `<b>${object.TRAILER_ID}</b><br/>Idle in: ${object.DROPOFF_CITY}<br/>Home: ${object.HOME_DEPOT}<br/>HAZMAT: ${object.HAZMAT_CERT ? 'yes' : 'no'}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    if (object.OFFER_ID) return { html: `<b>${object.SOURCE} ${object.OFFER_ID}</b><br/>${object.PICKUP_CITY} -> ${object.DROPOFF_CITY}<br/>${object.WEIGHT_KG} kg - ${object.PRODUCT}<br/>EUR ${object.PRICE_EUR}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    if (object.ID) return { html: `<b>Internal ${object.ID}</b><br/>${object.PICKUP_CITY} -> ${object.DROPOFF_CITY}<br/>${object.WEIGHT_KG} kg - ${object.PRODUCT}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    if (object.properties?.name) return { html: `<b>Avoid zone: ${object.properties.name}</b>`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
    return null;
  }, []);

  const selected = visibleAssignments.find(a => a.ASSIGNMENT_ID === selectedAssignment);
  const stopsPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected && stopsPanelRef.current) {
      stopsPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selected?.ASSIGNMENT_ID]);

  // Common slider/input style helpers.
  const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2, display: 'block' };
  const sliderBlock: React.CSSProperties = { minWidth: 170 };

  return (
    <PageContainer width="wide" padded={false}>
    <div className="panel" style={{ padding: 16 }}>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Backload Matching Engine</h2>
      <p className="subtitle">Fleet-wide VRP solve with VROOM + ORS — every visible knob maps 1:1 to a solver field.</p>

      {seedHint && (
        <div className="info-box" style={{ background: 'rgba(245,158,11,0.12)', color: '#a16207', border: '1px solid rgba(245,158,11,0.4)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{seedHint}</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" disabled={seeding} onClick={seedData}
                    style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid rgba(245,158,11,0.6)', background: '#fff', color: '#a16207', cursor: seeding ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
              {seeding ? 'Generating...' : 'Generate seed data'}
            </button>
            <button type="button" disabled={seeding} onClick={() => refetch()}
                    style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid rgba(245,158,11,0.4)', background: 'transparent', color: '#a16207', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Refresh
            </button>
          </span>
        </div>
      )}

      <div className="metric-grid" style={{ marginBottom: 12 }}>
        <MetricCard label="Trailers" value={trailers.length} />
        <MetricCard label="Internal volumes" value={internal.length} />
        <MetricCard label="External offers" value={external.length} />
        <MetricCard label="% trailers assigned" value={`${trailersAssignedPct}%`} />
        <MetricCard label="% internal coverage" value={`${internalPct}%`} />
        <MetricCard label="Net benefit (€)" value={`€${totalNetBenefit.toLocaleString()}`} />
      </div>

      {/* SOLVER ROW */}
      <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: 0.5 }}>SOLVER (VROOM-native)</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}>
        <div style={sliderBlock}>
          <label style={labelStyle}>Max stops per trailer: {maxStops}<InfoTip text="How many shipments one trailer may collect on a single tour. 1 = pure backload (one extra pickup on the way home). Higher = consolidation tours.\n\nVROOM field: vehicle.max_tasks" /></label>
          <input type="range" min={1} max={6} value={maxStops} onChange={e => setMaxStops(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={sliderBlock}>
          <label style={labelStyle}>Detour budget: +{detourSlackHrs} h<InfoTip text="Extra hours allowed on top of the direct trailer→end empty trip. Hard cap on total tour driving time.\n\nVROOM field: vehicle.max_travel_time" /></label>
          <input type="range" min={0} max={12} value={detourSlackHrs} onChange={e => setDetourSlackHrs(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={sliderBlock}>
          <label style={labelStyle}>Allowed deviation: +{deviationPct}%<InfoTip text="Hard distance cap on the tour, expressed as a % above a generous baseline (max of 2× the empty trip or 200 km). Raise to allow more far-flung pickups.\n\nVROOM field: vehicle.max_distance" /></label>
          <input type="range" min={0} max={500} step={10} value={deviationPct} onChange={e => setDeviationPct(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={sliderBlock}>
          <label style={labelStyle}>Internal-first: {internalFirstWeight}<InfoTip text="Bias toward internal volumes vs external offers. 100 = always pick internal first when in conflict, 50 = treat them equally, 0 = always pick external first.\n\nVROOM field: job.priority" /></label>
          <input type="range" min={0} max={100} value={internalFirstWeight} onChange={e => setInternalFirstWeight(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={sliderBlock}>
          <label style={labelStyle}>Window slack: ±{windowSlackHrs} h<InfoTip text="Widens every pickup/delivery time window by ±N hours so the solver has more flexibility to fit the shipment in.\n\nVROOM field: job.time_windows" /></label>
          <input type="range" min={0} max={12} value={windowSlackHrs} onChange={e => setWindowSlackHrs(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 220 }}>
          <label style={labelStyle}>Trailer end<InfoTip text="Where the trailer must finish: Home depot, a Shared destination you pick, or Open-ended (no return — useful for asset rebalancing).\n\nVROOM field: vehicle.end (omitted for open-ended)" /></label>
          <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="radio" name="endMode" checked={endMode === 'home'} onChange={() => setEndMode('home')} />Home</label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="radio" name="endMode" checked={endMode === 'shared'} onChange={() => setEndMode('shared')} />Shared</label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="radio" name="endMode" checked={endMode === 'open'} onChange={() => setEndMode('open')} />Open</label>
          </div>
          {endMode === 'shared' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input type="number" step="0.0001" value={sharedDestLon ?? ''}
                     onChange={e => { setSharedDestUserEdited(true); setSharedDestLon(e.target.value === '' ? null : Number(e.target.value)); }}
                     placeholder="lon" style={{ width: '50%', fontSize: 11 }} />
              <input type="number" step="0.0001" value={sharedDestLat ?? ''}
                     onChange={e => { setSharedDestUserEdited(true); setSharedDestLat(e.target.value === '' ? null : Number(e.target.value)); }}
                     placeholder="lat" style={{ width: '50%', fontSize: 11 }} />
            </div>
          )}
        </div>
      </div>

      {/* ECONOMICS ROW */}
      <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: 0.5 }}>ECONOMICS (€)</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}>
        <div style={{ minWidth: 130 }}>
          <label style={labelStyle}>Cost €/h<InfoTip text="Driver hour cost. Folded into VROOM's per-km cost via the assumed 60 km/h average so the solver minimises a single time+distance objective." /></label>
          <input type="number" min={0} step={1} value={costPerHourEur} onChange={e => setCostPerHourEur(Number(e.target.value) || 0)} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 130 }}>
          <label style={labelStyle}>Cost €/km<InfoTip text="Distance cost (fuel, wear). Combined with €/h to form vehicle.costs.per_km that VROOM uses to score every candidate route." /></label>
          <input type="number" min={0} step={0.05} value={costPerKmEur} onChange={e => setCostPerKmEur(Number(e.target.value) || 0)} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 130 }}>
          <label style={labelStyle}>Dispatch (€)<InfoTip text="Fixed cost paid every time a trailer is dispatched. High values discourage adding trailers for marginal gains.\n\nVROOM field: vehicle.costs.fixed" /></label>
          <input type="number" min={0} step={5} value={fixedDispatchEur} onChange={e => setFixedDispatchEur(Number(e.target.value) || 0)} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 130 }}>
          <label style={labelStyle}>€/delivery<InfoTip text="Per-stop overhead added in the post-solve net-benefit calculation only (e.g. paperwork, unloading admin). Does not influence the solver itself." /></label>
          <input type="number" min={0} step={1} value={costPerDeliveryEur} onChange={e => setCostPerDeliveryEur(Number(e.target.value) || 0)} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 150 }}>
          <label style={labelStyle}>Internal €/loaded-km<InfoTip text="Synthetic revenue rate for internal volumes (external offers carry their real PRICE_EUR). Matches the EU freight-exchange convention of pricing per loaded km." /></label>
          <input type="number" min={0} step={0.05} value={internalRatePerKm} onChange={e => setInternalRatePerKm(Number(e.target.value) || 0)} style={{ width: '100%' }} />
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={hideUnprofitable} onChange={e => setHideUnprofitable(e.target.checked)} />
          Hide unprofitable
        </label>
        <button className="btn-primary" onClick={solve} disabled={solving || !trailers.length} style={{ background: '#0DB048', minWidth: 140 }}>
          {solving ? 'Solving...' : 'Solve Backloads'}
        </button>
        {solving && (
          <button type="button"
                  onClick={() => solveAbortRef.current?.abort()}
                  style={{ minWidth: 100, padding: '6px 12px', fontSize: 12, borderRadius: 4, border: '1px solid rgba(239,68,68,0.6)', background: '#fff', color: '#b91c1c', cursor: 'pointer' }}>
            Cancel
          </button>
        )}
        <button className="btn-primary" onClick={confirmPlan} disabled={confirming || !visibleAssignments.length} style={{ minWidth: 140 }}>
          {confirming ? 'Saving...' : 'Confirm Plan'}
        </button>
      </div>

      {/* ENGINE FEATURES (collapsible) */}
      <div style={{ marginBottom: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
        <button onClick={() => setShowAdvanced(s => !s)} type="button"
                style={{ width: '100%', padding: '8px 12px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: 0.5 }}>
          <span>ENGINE FEATURES (VROOM + ORS) — {showAdvanced ? 'hide' : 'show'}</span>
          <span>{showAdvanced ? '▴' : '▾'}</span>
        </button>
        {showAdvanced && (
          <div style={{ padding: '8px 12px 12px', borderTop: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12 }}>
            {/* Card A */}
            <div style={{ minWidth: 220 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={enforceDriverBreak} onChange={e => setEnforceDriverBreak(e.target.checked)} />
                <b>Driver break</b><InfoTip text="Inserts a mandatory rest stop into the tour. Default mimics EU rules: 45 min after 4.5 h of driving. The solver picks the best moment within the window.\n\nVROOM field: vehicle.breaks" />
              </label>
              {enforceDriverBreak && (
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  After {breakAfterHrs} h:
                  <input type="range" min={2} max={6} step={0.5} value={breakAfterHrs} onChange={e => setBreakAfterHrs(Number(e.target.value))} style={{ width: '60%', marginLeft: 6 }} />
                  <br/>{breakLengthMin} min:
                  <input type="range" min={15} max={90} step={5} value={breakLengthMin} onChange={e => setBreakLengthMin(Number(e.target.value))} style={{ width: '60%', marginLeft: 6 }} />
                </div>
              )}
            </div>
            {/* Card D */}
            <div style={{ minWidth: 200 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={enforceShift} onChange={e => setEnforceShift(e.target.checked)} />
                <b>Shift / hours-of-service</b><InfoTip text="Forces the whole tour to fit inside a single driver shift starting at the trailer's earliest ETA.\n\nVROOM field: vehicle.time_window" />
              </label>
              {enforceShift && (
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  Shift = {shiftLengthHrs} h
                  <input type="range" min={4} max={13} value={shiftLengthHrs} onChange={e => setShiftLengthHrs(Number(e.target.value))} style={{ width: '70%', marginLeft: 6 }} />
                </div>
              )}
            </div>
            {/* Card C */}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={useMultiDimCapacity} onChange={e => setUseMultiDimCapacity(e.target.checked)} />
              <b>Multi-dim capacity</b><InfoTip text="Adds pallets and m³ alongside kg. The solver enforces all three simultaneously — a shipment that fits by weight may still be rejected on volume.\n\nVROOM fields: vehicle.capacity[] / shipment.amount[]" />
            </label>
            {/* Card B */}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={useMultiWindow} onChange={e => setUseMultiWindow(e.target.checked)} />
              <b>Multi-window pickups</b><InfoTip text="Adds a synthetic second pickup window at +8 h. Shows that VROOM can pick the better of multiple windows per trailer.\n\nVROOM field: pickup.time_windows[[a,b],[c,d]]" />
            </label>
            {/* Card J */}
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={showWaitTimes} onChange={e => setShowWaitTimes(e.target.checked)} />
              <b>Show wait times</b><InfoTip text="Display a 'wait N min' chip per stop when the trailer arrives early and idles before the time window opens. Computed from VROOM step.waiting_time." />
            </label>
            {/* Card F */}
            {avoidZones.length > 0 && (
              <div style={{ minWidth: 240 }}>
                <label style={{ display: 'block', marginBottom: 4 }}>
                  <b>Avoid zones</b><InfoTip text="Polygons forwarded to ORS as routing avoid_polygons. Currently rendered on the map only — routing-gateway propagation to ORS matrix pre-computation is a TODO." />
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 100, overflowY: 'auto' }}>
                  {avoidZones.map(z => (
                    <label key={z.ZONE_ID} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                      <input type="checkbox"
                             checked={selectedAvoidZoneIds.includes(z.ZONE_ID)}
                             onChange={e => setSelectedAvoidZoneIds(prev => e.target.checked
                                ? [...prev, z.ZONE_ID]
                                : prev.filter(x => x !== z.ZONE_ID))} />
                      {z.NAME} <span style={{ color: 'var(--text-secondary)' }}>({z.CATEGORY})</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginBottom: 12, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11, color: 'var(--text-secondary)', background: 'rgba(0,0,0,0.02)' }}>
        <b style={{ color: 'var(--text-primary)' }}>Legend</b>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(200,200,200)', border: '1px solid rgb(120,120,120)', display: 'inline-block' }} />
          External offer
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(41,181,232)', display: 'inline-block' }} />
          Internal volume
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(13,176,72)', border: '1px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.15)', display: 'inline-block' }} />
          Idle trailer
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 24, height: 0, borderTop: '3px dashed rgb(110,110,110)', display: 'inline-block' }} />
          Empty leg
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 12, background: 'rgba(239,68,68,0.4)', border: '1px solid rgb(239,68,68)', display: 'inline-block' }} />
          Avoid zone
        </span>
      </div>

      {confirmMsg && (<div className="info-box success" style={{ marginBottom: 12 }}>{confirmMsg}</div>)}
      {solverLog && (<div style={{ marginBottom: 12, fontSize: 11, fontFamily: 'monospace', padding: '6px 10px', background: 'rgba(0,0,0,0.04)', borderRadius: 4, color: 'var(--text-secondary)' }}>{solverLog}</div>)}
      {solveError && (<div style={{ marginBottom: 12, fontSize: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.45)', borderRadius: 4, color: '#b91c1c' }}><b>Solve returned no assignments.</b> {solveError}</div>)}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 12 }}>
        <div ref={mapContainerRef} style={{ height: 560, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
          {solving && (
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: '#fff', zIndex: 10, fontSize: 14 }}>
              <div>{solverLog || 'Calling OPTIMIZATION...'}</div>
              <button type="button" onClick={() => solveAbortRef.current?.abort()}
                      style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, border: '1px solid rgba(255,255,255,0.6)', background: 'transparent', color: '#fff', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          )}
          {mapDims && (
            <DeckGL width={mapDims.width} height={mapDims.height}
                    viewState={viewState} onViewStateChange={onViewStateChange}
                    controller={true} layers={layers} getTooltip={getTooltip}
                    style={{ position: 'absolute', top: '0', left: '0', width: `${mapDims.width}px`, height: `${mapDims.height}px` }} />
          )}
          <RecenterButton onClick={recenter} disabled={!fitCoords.length} />
          {selected && (
            <button type="button" onClick={() => stopsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    style={{ position: 'absolute', top: 12, right: 140, zIndex: 5, padding: '6px 10px', fontSize: 12, borderRadius: 4, border: '1px solid var(--border)', background: 'rgba(255,255,255,0.92)', color: 'var(--text-primary)', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}>
              Stops ↓
            </button>
          )}
        </div>

        <AssignmentList
          assignments={visibleAssignments}
          unassigned={unassigned}
          selectedAssignment={selectedAssignment}
          onSelect={setSelectedAssignment}
          rationale={rationale}
          rationaleLoading={rationaleLoading}
          onAskRationale={askRationale}
        />
      </div>

      {selected && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-secondary)' }}>
          Selected trailer: <b>{selected.TRAILER_ID}</b> · duration {selected.SCORE.toFixed(0)}s · empty {Math.round(selected.EMPTY_KM)} km · net €{Math.round(selected.NET_BENEFIT_EUR || 0)}
        </div>
      )}

      <div ref={stopsPanelRef}>
        <StopsPanel assignment={selected || null} showWaitTimes={showWaitTimes} />
      </div>

      <DecisionsAudit rows={auditRows} onRefresh={loadAudit} />
    </div>
    </PageContainer>
  );
}
