import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import MetricCard from '../shared/MetricCard';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, PathLayer, TextLayer } from '@deck.gl/layers';
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
  sfQuery, haversineKm, synthPallets, synthVolumeM3,
  isOrsRegionReady, buildVroomMatrix, computeEmptyLegBaselines,
  fetchVehicleClass, type VehicleClass,
  type EmptyLegBaseline,
} from './backload-matching/helpers';

// Default caps on solve payload size. The matrix budget below is the hard
// guardrail; the three default counts are now editable via UI sliders so
// users can scale up coverage on regions with many idle trailers. The
// clampPayload() helper enforces the matrix budget on Solve regardless of
// what the sliders say, so users cannot accidentally trigger the
// matrix_precompute_failed -> 45 s gateway timeout failure mode
// (see .snowflake/cortex/plans/backload-solve-hang-fix.plan.md).
const BM_DEFAULT_MAX_VEHICLES = 15;
const BM_DEFAULT_MAX_INTERNAL = 30;
const BM_DEFAULT_MAX_EXTERNAL = 15;
// Slider ranges. Upper bounds are intentionally permissive: clampPayload()
// will scale them down at Solve time if the matrix budget would be exceeded.
const BM_VEHICLES_MIN = 1, BM_VEHICLES_MAX = 60;
const BM_INTERNAL_MIN = 0, BM_INTERNAL_MAX = 80;
const BM_EXTERNAL_MIN = 0, BM_EXTERNAL_MAX = 60;

// Proportionally clamp (v, i, e) so that 2v + 2i + 2e <= matrixBudget.
// Returns the clamped triple plus a `clamped` flag so the solver log can
// surface when the guardrail kicked in.
function clampPayload(
  v: number, i: number, e: number, matrixBudget: number,
): { v: number; i: number; e: number; clamped: boolean } {
  const used = 2 * v + 2 * i + 2 * e;
  if (used <= matrixBudget) return { v, i, e, clamped: false };
  const scale = matrixBudget / used;
  return {
    v: Math.max(1, Math.floor(v * scale)),
    i: Math.max(0, Math.floor(i * scale)),
    e: Math.max(0, Math.floor(e * scale)),
    clamped: true,
  };
}
// Hard ceiling on the unique-location count we'll try to precompute a matrix
// for. The gateway pre-compute path has a 45 s timeout
// (ORS_TIMEOUT_MATRIX_PRECOMPUTE in services/gateway/routing_service.py).
// Empirical sweep on Germany continental driving-hgv
// (.snowflake/cortex/plans/benchmark-bm-matrix-cap.plan.md, 2026-05-26):
//   N=400  -> p95  6.1 s
//   N=500  -> p95  9.7 s   <- chosen cap (35 s headroom under 45 s timeout)
//   N=600  -> p95 13.9 s
//   N=750  -> p95 20.3 s
//   N=1000 -> p95 34.1 s   (would breach 45 s under load jitter)
// 500 also comfortably covers the BM slider-max payload of 2*60+2*80+2*60=400.
const BM_MAX_MATRIX_LOCATIONS = 500;
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
  const [vehicleClass, setVehicleClass] = useState<VehicleClass | null>(null);
  const [vehicleClassError, setVehicleClassError] = useState<string | null>(null);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [avoidZones, setAvoidZones] = useState<AvoidZone[]>([]);

  // ---------------- Payload-size sliders (clamped to matrix budget on Solve) ----------------
  const [maxVehicles, setMaxVehicles] = useState(BM_DEFAULT_MAX_VEHICLES);
  const [maxInternal, setMaxInternal] = useState(BM_DEFAULT_MAX_INTERNAL);
  const [maxExternal, setMaxExternal] = useState(BM_DEFAULT_MAX_EXTERNAL);

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
  const [orsProfile, setOrsProfile] = useState<string>('');
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
    // Defensive dedupe by TRAILER_ID — guards against the upstream view
    // regressing and feeding the same trailer to VROOM as multiple vehicles
    // (which produces visually-identical duplicate assignment cards).
    const seenTrailerIds = new Set<string>();
    const tDeduped = (tRows as Trailer[]).filter(r => {
      const id = String(r.TRAILER_ID);
      if (seenTrailerIds.has(id)) return false;
      seenTrailerIds.add(id);
      return true;
    });
    setTrailers(tDeduped);
    // Same defence-in-depth on internal volumes and external offers: the
    // upstream views can regress and emit the same physical shipment under
    // duplicate OFFER_IDs (external) or under different INT-NNNNN IDs but
    // with identical pickup/dropoff coords (internal). Sending duplicates
    // to VROOM produces "2 pickups + 2 dropoffs" for one shipment.
    const seenInt = new Set<string>();
    const iDeduped = (iRows as Volume[]).filter(v => {
      const k = `${Number(v.PICKUP_LON).toFixed(6)},${Number(v.PICKUP_LAT).toFixed(6)}|${Number(v.DROPOFF_LON).toFixed(6)},${Number(v.DROPOFF_LAT).toFixed(6)}|${v.WEIGHT_KG}`;
      if (seenInt.has(k)) return false;
      seenInt.add(k);
      return true;
    });
    setInternal(iDeduped);
    const seenExt = new Set<string>();
    const eDeduped = (eRows as Offer[]).filter(o => {
      const k = String(o.OFFER_ID);
      if (seenExt.has(k)) return false;
      seenExt.add(k);
      return true;
    });
    setExternal(eDeduped);
    const cfg: Record<string, any> = (cRows[0] as any) || {};
    const activeVT = cfg.VEHICLE_TYPE != null ? String(cfg.VEHICLE_TYPE) : '';
    if (activeVT) setVehicleType(activeVT);

    // Load the per-vehicle-class profile (capacity, costs, ORS profile, label).
    // Decision #2 in plan: fail loudly when the active vehicle_type isn't in
    // VEHICLE_CLASS_PROFILE so a custom preset never silently runs with
    // wrong-class defaults.
    let cls: VehicleClass | null = null;
    if (activeVT) {
      try {
        cls = await fetchVehicleClass(activeVT);
      } catch (e: any) {
        cls = null;
        setVehicleClassError(`Failed to load VEHICLE_CLASS_PROFILE: ${e?.message || e}`);
      }
    }
    if (activeVT && !cls) {
      setVehicleClass(null);
      setVehicleClassError(
        `Unknown vehicle_type "${activeVT}". Add a row to ` +
        `OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE before solving.`
      );
      setOrsProfile('');
    } else {
      setVehicleClass(cls);
      setVehicleClassError(null);
      // Bind ORS profile to the active vehicle_type. If the region wasn't
      // provisioned with that profile, refuse to solve and surface the
      // re-provision instruction (was: blindly pick provisioned[0], which
      // is the bug that produced profile=driving-car for an ebike preset).
      const provisionedList = String((profRows[0] as any)?.PROFILES || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (cls) {
        const desired = cls.ORS_PROFILE;
        if (provisionedList.length === 0 || provisionedList.includes(desired)) {
          setOrsProfile(desired);
        } else {
          setOrsProfile('');
          setVehicleClassError(
            `Active preset uses vehicle_type='${activeVT}' which requires ORS ` +
            `profile '${desired}', but region '${regionName}' is provisioned ` +
            `only with [${provisionedList.join(', ')}]. Re-provision the ` +
            `region with the missing profile, or switch the active preset.`
          );
        }
      }
    }
    setAvoidZones((azRows as any[]).map(r => ({
      ZONE_ID: r.ZONE_ID, NAME: r.NAME, CATEGORY: r.CATEGORY,
      POLYGON_GEOJSON: typeof r.POLYGON_GEOJSON === 'string' ? JSON.parse(r.POLYGON_GEOJSON) : r.POLYGON_GEOJSON,
    })));
    if (!tRows.length || !iRows.length || !eRows.length) {
      // Probe upstream coverage so the operator can see exactly which dim/fact
      // is missing (instead of just "Tables are empty"). This identifies the
      // common cause: an active dataset that was generated before
      // DIM_FLEET / DIM_POIS / FACT_FREIGHT_OFFERS were added to Data Studio
      // (so V_FACT_TRIPS_CURRENT is populated but the others are zero).
      const safeRegion = (regionName || '').replace(/'/g, "''");
      let upstreamHint = '';
      try {
        const cov = await sfQuery(
          `SELECT
             (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT          WHERE REGION = '${safeRegion}') AS TRIPS,
             (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_FLEET_CURRENT           WHERE REGION = '${safeRegion}') AS FLEET,
             (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.V_DIM_POIS_CURRENT            WHERE REGION = '${safeRegion}') AS POIS,
             (SELECT COUNT(*) FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_FREIGHT_OFFERS_CURRENT WHERE REGION = '${safeRegion}') AS OFFERS`,
          'SYNTHETIC_DATASETS', 'UNIFIED',
        );
        const c = (cov[0] as any) || {};
        upstreamHint =
          ` Active dataset coverage \u2014 trips: ${c.TRIPS ?? 0}, fleet: ${c.FLEET ?? 0}, ` +
          `POIs: ${c.POIS ?? 0}, offers: ${c.OFFERS ?? 0}.`;
      } catch {
        // best-effort; fall back to the basic hint
      }
      const baseHint =
        `Tables are empty for region "${regionName}" \u2014 trailers: ${tRows.length}, internal: ${iRows.length}, external: ${eRows.length}.`;
      const action = upstreamHint && /fleet:\s*0|POIs:\s*0/.test(upstreamHint)
        ? ' The active dataset is missing fleet or POIs \u2014 the "Generate seed data" button can only fill freight offers, so run a Data Studio job for this region to create a complete dataset.'
        : ' Click "Generate seed data" to populate freight offers, or run a Data Studio job for this region.';
      setSeedHint(baseHint + upstreamHint + action);
    } else {
      setSeedHint(null);
    }
  }, [regionName]);

  useEffect(() => {
    if (!regionName) return;
    // CONFIG.REGION + CONFIG.VEHICLE_TYPE (on both BACKLOAD_MATCHING.CONFIG and
    // ROUTE_OPTIMIZATION.CONFIG) are kept in sync atomically by the dataset
    // picker (`POST /api/datasets/activate`). The page used to issue its own
    // UPDATEs here, but `/api/query` is read-only (SELECT/SHOW/DESCRIBE/CALL/WITH)
    // so those UPDATEs 403'd ("Only read-only queries allowed"). Removed in
    // v1.1 to match the same fix already applied to AssetVelocity.tsx.
    refetch();
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

    // Refuse to solve if vehicleClass isn't loaded — every solver constant
    // (capacity, costs, ORS profile, baseline) is class-derived now.
    if (!vehicleClass) {
      setSolveError(vehicleClassError ||
        `Vehicle class profile not loaded for vehicle_type='${vehicleType}'. ` +
        `Add a row to OPENROUTESERVICE_APP.CORE.VEHICLE_CLASS_PROFILE.`);
      setSolving(false);
      return;
    }
    const cls = vehicleClass;
    const profile = orsProfile || cls.ORS_PROFILE;
    if (!orsProfile) {
      setSolveError(`ORS profile '${cls.ORS_PROFILE}' is not provisioned for region '${regionName}'. Re-provision or switch preset.`);
      setSolving(false);
      return;
    }
    const speedKmh = cls.AVG_SPEED_KMH;
    const homeRangeKm = cls.HOME_RANGE_KM;
    const classCapacityKg = cls.PAYLOAD_KG_MAX;
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
    const effPerKmEur = costPerKmEur + costPerHourEur / speedKmh;
    // Avoid-polygon GeoJSON list (Card F).
    const avoidGeoJSON = selectedAvoidZoneIds
      .map(id => avoidZones.find(z => z.ZONE_ID === id)?.POLYGON_GEOJSON)
      .filter(Boolean);

    // Pick a common shift start (earliest trailer ETA, fallback now).
    const nowSec = Math.floor(Date.now() / 1000);
    const etaSeconds = trailers
      .map(t => Math.floor(new Date(t.ETA_TS || 0).getTime() / 1000))
      .filter(s => Number.isFinite(s) && s > 0);
    // Vehicle shift starts NOW at the earliest, even if the trailer's ETA is
    // in the past (synthetic data routinely backdates LAST_TRIP_END).
    const shiftStartSec = Math.max(
      etaSeconds.length ? Math.min(...etaSeconds) : nowSec,
      nowSec,
    );
    const shiftEndSec   = shiftStartSec + Math.round(shiftLengthHrs * 3600);

    // Score every shipment by haversine distance to the NEAREST idle trailer
    // pickup point. Lower score = better backload candidate. Sorting by score
    // (with id as deterministic tie-break) makes the subset reproducible
    // across solves on the same data, so users see consistent results.
    const nearestTrailerKm = (lon: number, lat: number): number => {
      let best = Infinity;
      for (const t of trailers) {
        const d = haversineKm(Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT), lon, lat);
        if (d < best) best = d;
      }
      return best;
    };

    // Apply the matrix-budget guardrail BEFORE slicing. clampPayload()
    // proportionally scales (maxVehicles, maxInternal, maxExternal) down
    // until 2v + 2i + 2e <= BM_MAX_MATRIX_LOCATIONS. If the user's sliders
    // already fit, the triple is returned unchanged and clamped=false.
    const clamped = clampPayload(
      maxVehicles, maxInternal, maxExternal, BM_MAX_MATRIX_LOCATIONS,
    );
    const effMaxVehicles = clamped.v;
    const effMaxInternal = clamped.i;
    const effMaxExternal = clamped.e;
    if (clamped.clamped) {
      console.warn(
        `[BM] payload clamped to fit ${BM_MAX_MATRIX_LOCATIONS}-location matrix budget: ` +
        `${maxVehicles}/${maxInternal}/${maxExternal} -> ` +
        `${effMaxVehicles}/${effMaxInternal}/${effMaxExternal}`,
      );
    }

    const internalSubset = [...internal]
      .map(v => ({ v, score: nearestTrailerKm(Number(v.PICKUP_LON), Number(v.PICKUP_LAT)) }))
      .sort((a, b) => a.score - b.score || String(a.v.ID).localeCompare(String(b.v.ID)))
      .slice(0, effMaxInternal)
      .map(x => x.v);
    const externalSubset = [...external]
      .map(o => ({ o, score: nearestTrailerKm(Number(o.PICKUP_LON), Number(o.PICKUP_LAT)) }))
      .sort((a, b) => a.score - b.score || String(a.o.OFFER_ID).localeCompare(String(b.o.OFFER_ID)))
      .slice(0, effMaxExternal)
      .map(x => x.o);
    const internalSkipped = Math.max(0, internal.length - internalSubset.length);
    const externalSkipped = Math.max(0, external.length - externalSubset.length);

    // Region-agnostic time/distance budget — per-vehicle empty-leg baselines.
    // For each trailer we compute the shortest-path travel time + distance
    // from its current dropoff to its end point (HOME or shared dest) using
    // the ORS MATRIX TVF. The user's "Detour budget" slider then adds extra
    // hours linearly on top, and "Allowed deviation" scales the distance
    // baseline multiplicatively. This makes both sliders bite per-vehicle
    // instead of being dwarfed by a global envelope tour.
    //
    // Fallbacks (per-trailer):
    //   * MATRIX failure or missing cell -> haversine(start, end) / KMH_HGV.
    //   * Open-end mode (no end point)   -> fixed 200 km / (200/KMH_HGV) h.
    setSolverLog('Computing empty-leg baselines...');
    let baselines: Map<Trailer, EmptyLegBaseline>;
    try {
      baselines = await computeEmptyLegBaselines(
        profile,
        trailers.slice(0, effMaxVehicles),
        trailerEnd,
        regionName,
        { kmh: speedKmh, homeRangeKm },
      );
    } catch (e: any) {
      console.warn('[BM] computeEmptyLegBaselines threw, using haversine for all trailers', e);
      baselines = new Map();
    }
    let baselineMatrixCount = 0;
    let baselineHaversineCount = 0;
    let baselineFixedOpenCount = 0;
    for (const b of baselines.values()) {
      if (b.source === 'matrix')      baselineMatrixCount++;
      else if (b.source === 'haversine') baselineHaversineCount++;
      else if (b.source === 'fixed-open') baselineFixedOpenCount++;
    }

    const FALLBACK_BASELINE: EmptyLegBaseline = {
      durSec:     Math.round((homeRangeKm / speedKmh) * 3600),
      distMeters: homeRangeKm * 1000,
      source:     'fixed-open',
    };

    const vrpVehicles = trailers.slice(0, effMaxVehicles).map((t, i) => {
      const id = i + 1;
      trailerById.set(id, t);
      const endPt = trailerEnd(t);
      const capacityKg = Number(t.MAX_PAYLOAD_KG) || cls.PAYLOAD_KG_TYP;
      const base = baselines.get(t) ?? FALLBACK_BASELINE;

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
        // Time budget = empty-leg baseline + user's detour-slack slider.
        // The slider therefore ADDS hours linearly on top of the empty
        // drive home (or the 200 km fixed baseline in open-end mode).
        max_travel_time: Math.max(
          1800,
          base.durSec + Math.round(detourSlackHrs * 3600),
        ),
        // Distance budget = empty-leg baseline scaled by deviation%.
        // The slider therefore MULTIPLIES the empty drive home: e.g.
        // 200% means "tour may be up to 3x the empty distance".
        max_distance: Math.max(
          10_000,
          Math.round(base.distMeters * (1 + deviationPct / 100)),
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

    for (const v of internalSubset) {
      const id = nextId++;
      offerById.set(id, { kind: 'INTERNAL', row: v });
      const kg = Math.min(Number(v.WEIGHT_KG), classCapacityKg);
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
      const kg = Math.min(Number(o.WEIGHT_KG), classCapacityKg);
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

    // Pre-flight feasibility check (Decision: refuse before VROOM if the
    // payload is structurally infeasible). Catches the two failure modes
    // that historically returned "90x unknown" with no actionable hint:
    //   (a) every shipment exceeds vehicle capacity (wrong-class data); and
    //   (b) no shipment pickup window overlaps the vehicle shift window.
    const median = (arr: number[]): number => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    if (vrpVehicles.length > 0 && vrpShipments.length > 0) {
      const medTrailer = median(trailers.slice(0, effMaxVehicles).map(t => Number(t.MAX_PAYLOAD_KG)));
      const medShip    = median([
        ...internalSubset.map(v => Number(v.WEIGHT_KG)),
        ...externalSubset.map(o => Number(o.WEIGHT_KG)),
      ]);
      if (medTrailer > 0 && medShip > medTrailer * 1.05) {
        setSolveError(
          `Pre-flight: median shipment weight (${Math.round(medShip)} kg) ` +
          `exceeds median ${cls.LABEL_NOUN} capacity (${Math.round(medTrailer)} kg) ` +
          `for vehicle_type='${vehicleType}'. The active preset's shipments don't ` +
          `fit this vehicle class. Switch to a heavier-class preset or wait for ` +
          `class-aware re-seeding.`
        );
        setSolving(false);
        return;
      }
      const anyOverlap = vrpShipments.some(sh => {
        const wins: number[][] | undefined = sh?.pickup?.time_windows;
        if (!Array.isArray(wins) || !wins.length) return true; // no window = always ok
        return wins.some(([a, b]) => Number(b) >= shiftStartSec && Number(a) <= shiftEndSec);
      });
      if (!anyOverlap) {
        const shiftFromIso = new Date(shiftStartSec * 1000).toISOString().slice(11, 16);
        const shiftToIso   = new Date(shiftEndSec   * 1000).toISOString().slice(11, 16);
        setSolveError(
          `Pre-flight: no shipment pickup window overlaps the ${cls.LABEL_NOUN} shift ` +
          `(${shiftFromIso}-${shiftToIso} UTC). Increase "Window slack" hours, ` +
          `enable Multi-window pickups, or extend "Shift length".`
        );
        setSolving(false);
        return;
      }
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
      // Single source of truth for location keys. addLoc and indexFor MUST
      // agree, otherwise some vehicles/shipments will silently fail to get a
      // *_index — and VROOM rejects the payload with
      // "Missing start_index or end_index" when matrices are provided.
      const keyFor = (lon: number, lat: number) =>
        `${Number(lon).toFixed(6)},${Number(lat).toFixed(6)}`;
      const addLoc = (lon: number, lat: number) => {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        const key = keyFor(lon, lat);
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
        // O(1) index lookup keyed identically to addLoc.
        const keyToIndex = new Map<string, number>();
        locs.forEach(([lo, la], i) => keyToIndex.set(keyFor(lo, la), i));
        const indexFor = (lon: number, lat: number) => {
          const v = keyToIndex.get(keyFor(lon, lat));
          return v === undefined ? -1 : v;
        };
        if (precomputedMatrix) {
          // Defence-in-depth: track whether every vehicle/shipment got an
          // index. If not, drop the matrix and let the gateway pre-compute
          // (options.g=true) instead of letting VROOM error out.
          let allIndexed = true;
          const setIdx = (target: any, key: string, lon: number, lat: number) => {
            const i = indexFor(lon, lat);
            if (i >= 0) target[key] = i;
            else allIndexed = false;
          };
          for (const v of vrpVehicles) {
            if (v.start) setIdx(v, 'start_index', Number(v.start[0]), Number(v.start[1]));
            if (v.end)   setIdx(v, 'end_index',   Number(v.end[0]),   Number(v.end[1]));
          }
          for (const sh of vrpShipments) {
            if (sh.pickup?.location)   setIdx(sh.pickup,   'location_index', Number(sh.pickup.location[0]),   Number(sh.pickup.location[1]));
            if (sh.delivery?.location) setIdx(sh.delivery, 'location_index', Number(sh.delivery.location[0]), Number(sh.delivery.location[1]));
          }
          if (!allIndexed) {
            precomputedMatrix = null;
            matrixNote = 'UI matrix pre-compute had unindexed locations; falling back to gateway pre-compute.';
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
    // Use _OPTIMIZATION_RAW (returns the full VROOM JSON as VARIANT) instead
    // of the OPTIMIZATION TVF. The TVF does LATERAL FLATTEN(resp:routes), which
    // strips the row entirely when VROOM (or the gateway) returns an error
    // payload with no `routes` array — manifesting as the misleading
    // "OPTIMIZATION returned 0 rows" overlay. Parsing the raw response keeps
    // routes / unassigned / error / matrix_precompute_failed all visible.
    const sql = `SELECT OPENROUTESERVICE_APP.CORE._OPTIMIZATION_RAW(PARSE_JSON('${jsonStr}'), '${regionName}') AS RESP`;
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
    let respRows: any[] = [];
    try {
      respRows = await sfQuery(sql, 'OPENROUTESERVICE_APP', 'CORE', { signal: ac.signal, throwOnError: true });
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

    // Parse VROOM's raw JSON response. Three things can be present:
    //   routes:[]           — successful tours
    //   unassigned:[]       — shipments VROOM couldn't place (with reasons)
    //   error / message     — gateway / VROOM rejected the payload (e.g.
    //                         matrix_precompute_failed at code 99)
    const rawResp: any = respRows?.[0]?.RESP;
    const respObj: any = (() => {
      if (rawResp == null) return null;
      if (typeof rawResp === 'string') {
        try { return JSON.parse(rawResp); } catch { return null; }
      }
      return rawResp;
    })();
    const vroomRoutes: any[]     = Array.isArray(respObj?.routes)     ? respObj.routes     : [];
    const vroomUnassigned: any[] = Array.isArray(respObj?.unassigned) ? respObj.unassigned : [];
    const vroomError: string | null =
      respObj?.error ||
      (respObj?.code && respObj?.code !== 0 ? (respObj?.message || `VROOM code=${respObj.code}`) : null);

    const newAssignments: Assignment[] = [];
    const newUnassigned: { id: number; reason?: string }[] = [];
    for (const u of vroomUnassigned) {
      const id = Number(u?.id);
      // VROOM v1.14 returns { id, type, location, description } in unassigned[].
      // Older builds used `reason`; accept both, fall back to type only as
      // last resort. The pre-fix code only read `reason` and produced a
      // useless "90x unknown" message on every fresh install.
      if (Number.isFinite(id)) newUnassigned.push({ id, reason: u?.description ?? u?.reason ?? u?.type ?? null });
    }
    for (const route of vroomRoutes) {
      const vehId = Number(route?.vehicle);
      if (!vehId) continue;
      const t = trailerById.get(vehId);
      if (!t) continue;
      const steps: any[] = Array.isArray(route?.steps) ? route.steps : [];
      // route.geometry is a coordinate array; wrap into a GeoJSON LineString
      // for the map layer (matches the TVF's previous shape).
      const routeGeo: any = Array.isArray(route?.geometry)
        ? { type: 'LineString', coordinates: route.geometry }
        : null;

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

      // Post-solve economics — VROOM returns duration (sec); distance may be
      // present as meters depending on solver version.
      const tourSec   = Number(route?.duration) || 0;
      const tourHrs   = tourSec / 3600;
      const tourKmReal = (Number(route?.distance) || (tourSec * speedKmh / 3600 * 1000)) / 1000;
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
        SCORE: Number(route?.duration) || 0,
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
      `caps=${effMaxVehicles}v/${effMaxInternal}i/${effMaxExternal}e` +
      `${clamped.clamped ? ` [clamped from ${maxVehicles}/${maxInternal}/${maxExternal}]` : ''}, ` +
      `intFirst=${internalFirstWeight}, breaks=${enforceDriverBreak ? 'on' : 'off'}, ` +
      `multiDim=${useMultiDimCapacity ? 'on' : 'off'}, end=${endMode}, ` +
      `avoidZones=${selectedAvoidZoneIds.length}; skipped ${internalSkipped} internal, ` +
      `${externalSkipped} external; region=${regionName}, profile=${profile}, ` +
      `matrix=${precomputedMatrix ? `UI ${precomputedMatrix.durations.length}^2` : 'gateway-side'}, ` +
      `baselines=${baselineMatrixCount} matrix/${baselineHaversineCount} haversine/${baselineFixedOpenCount} open-end). ` +
      (matrixNote ? `${matrixNote} ` : '') +
      `Got ${vroomRoutes.length} routes, ${vroomUnassigned.length} unassigned → ` +
      `${newAssignments.length} assigned. ` +
      `Avg detour +${avgDetour} km. Net benefit total €${totalNet.toLocaleString()}.`
    );
    // Surface gateway / VROOM errors verbatim. The most common one this
    // catches is matrix_precompute_failed (gateway 45 s ORS matrix timeout)
    // which the old TVF-based path silently dropped to "0 rows".
    if (vroomError) {
      setSolveError(`Routing gateway / VROOM error: ${vroomError}`);
    } else if (newAssignments.length === 0 && newUnassigned.length > 0) {
      // Solver responded but couldn't place anything. Aggregate VROOM's
      // per-shipment reasons so the user knows which lever to loosen.
      const reasonCounts = newUnassigned.reduce((m: Record<string, number>, u) => {
        const k = u.reason || 'unknown';
        m[k] = (m[k] || 0) + 1;
        return m;
      }, {});
      const summary = Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${n}× ${r}`)
        .join(', ');
      // Class-aware post-mortem: when 100% of shipments fail and the
      // median shipment weight exceeds the median trailer capacity, the
      // root cause is a class mismatch (preset shipments don't fit the
      // active vehicle class). When time windows don't overlap the shift,
      // surface that. Otherwise hint at the standard sliders.
      const medTrailer = median(trailers.slice(0, effMaxVehicles).map(t => Number(t.MAX_PAYLOAD_KG)));
      const medShip    = median([
        ...internalSubset.map(v => Number(v.WEIGHT_KG)),
        ...externalSubset.map(o => Number(o.WEIGHT_KG)),
      ]);
      const classDiag = (medTrailer > 0 && medShip > medTrailer)
        ? ` Median shipment weight ${Math.round(medShip)} kg > ${cls.LABEL_NOUN} capacity ${Math.round(medTrailer)} kg — wrong vehicle class for this preset's payload.`
        : '';
      setSolveError(
        `VROOM placed 0 shipments out of ${newUnassigned.length}. Top reasons: ${summary}.${classDiag} ` +
        `Tweak: raise deviation %, raise detour budget, widen window slack, or relax skill requirements. ` +
        `(profile=${profile} for vehicle_type=${vehicleType})`
      );
    } else if (vroomRoutes.length === 0 && vrpShipments.length > 0) {
      // Compute median per-vehicle bounds for diagnostics, using the same
      // baseline + slider math the vehicles were built with.
      const baseDurArr  = Array.from(baselines.values()).map(b => b.durSec);
      const baseDistArr = Array.from(baselines.values()).map(b => b.distMeters);
      const medDurH  = (median(baseDurArr) / 3600);
      const medDistKm = (median(baseDistArr) / 1000);
      const medMaxTravelH = medDurH + detourSlackHrs;
      const medMaxDistKm  = medDistKm * (1 + deviationPct / 100);
      const baselineSummary =
        `${baselineMatrixCount} matrix, ${baselineHaversineCount} haversine, ${baselineFixedOpenCount} open-end`;
      setSolveError(
        `OPTIMIZATION returned no routes and no unassigned. ` +
        `Per-vehicle limits sent to VROOM (median): ` +
        `max_travel_time≈${medMaxTravelH.toFixed(1)}h, ` +
        `max_distance≈${Math.round(medMaxDistKm)}km ` +
        `(empty-leg baselines: ${baselineSummary}; ` +
        `median baseline=${medDurH.toFixed(1)}h / ${Math.round(medDistKm)}km). ` +
        `If the actual tour exceeds these, raise "Detour budget" or "Allowed deviation" and re-solve. ` +
        `Other checks: (1) ORS_SERVICE_${(regionName || '').toUpperCase()} RUNNING, ` +
        `(2) region='${regionName}' covers your data bbox, ` +
        `(3) profile='${profile}' supported by this region, ` +
        `(4) no unknown vehicle/job fields (e.g. costs.per_hour requires VROOM v1.13+).`
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
    maxVehicles, maxInternal, maxExternal,
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
      if (!a.EMPTY_GEOJSON) return;
      const isSel = a.ASSIGNMENT_ID === selectedAssignment;
      const emptyW = isSel ? 6 : (hasSel ? 2 : 4);
      const emptyAlpha = isSel ? 255 : (hasSel ? 140 : 255);
      result.push(new GeoJsonLayer({
        id: `empty-${i}`,
        data: a.EMPTY_GEOJSON as any,
        stroked: true, getLineColor: [110, 110, 110, emptyAlpha], getDashArray: [10, 6], lineWidthMinPixels: emptyW,
        extensions: [new PathStyleExtension({ dash: true })],
        parameters: { depthTest: false },
      }));
    });
    if (selectedAssignment) {
      const a = visibleAssignments.find(x => x.ASSIGNMENT_ID === selectedAssignment);
      if (a && Array.isArray(a.STOPS) && a.STOPS.length) {
        // Numbered, hoverable stop markers driven directly by selected.STOPS
        // so order/colors/numbers match the Stops/Audit panel 1:1.
        // Palette mirrors KIND_STYLES in components/backload-matching/StopsPanel.tsx.
        const palette: Record<Stop['kind'], { ring: [number, number, number]; halo: [number, number, number, number] }> = {
          start:   { ring: [156, 163, 175], halo: [156, 163, 175, 60] },
          pickup:  { ring: [245, 158, 11],  halo: [245, 158, 11, 60]  },
          dropoff: { ring: [13, 176, 72],   halo: [13, 176, 72, 60]   },
          end:     { ring: [41, 181, 232],  halo: [41, 181, 232, 60]  },
          break:   { ring: [168, 85, 247],  halo: [168, 85, 247, 60]  },
        };
        // Tag each stop with its 1-based index up-front so it survives hover.
        const stopData = a.STOPS.map((s, i) => ({ ...s, _idx: i + 1, _total: a.STOPS.length }));

        result.push(new ScatterplotLayer({
          id: 'sel-stop-halo', data: stopData, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: (d: any) => palette[d.kind as Stop['kind']].halo,
          getRadius: 160, radiusMinPixels: 16, radiusMaxPixels: 50,
          stroked: false, filled: true,
          parameters: { depthTest: false },
        }));
        result.push(new ScatterplotLayer({
          id: 'sel-stop-marker', data: stopData, pickable: true,
          getPosition: (d: any) => [d.lon, d.lat],
          getFillColor: [255, 255, 255, 240],
          getLineColor: (d: any) => {
            const c = palette[d.kind as Stop['kind']].ring;
            return [c[0], c[1], c[2], 255];
          },
          getRadius: 90, radiusMinPixels: 11, radiusMaxPixels: 18,
          lineWidthMinPixels: 2, stroked: true, filled: true,
          parameters: { depthTest: false },
        }));
        result.push(new TextLayer({
          id: 'sel-stop-number', data: stopData, pickable: false,
          getPosition: (d: any) => [d.lon, d.lat],
          getText: (d: any) => String(d._idx),
          getColor: (d: any) => {
            const c = palette[d.kind as Stop['kind']].ring;
            return [c[0], c[1], c[2], 255];
          },
          getSize: 12, sizeUnits: 'pixels',
          fontWeight: 700,
          getAlignmentBaseline: 'center', getTextAnchor: 'middle',
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
    // Stop marker on selected route — matches StopsPanel row info.
    if (object._idx && (object.kind === 'start' || object.kind === 'pickup' ||
                        object.kind === 'dropoff' || object.kind === 'end' ||
                        object.kind === 'break')) {
      const labelMap: Record<string, string> = {
        start: 'START', pickup: 'PICKUP', dropoff: 'DROPOFF', end: 'END', break: 'BREAK',
      };
      const lines: string[] = [];
      lines.push(`<b>#${object._idx} of ${object._total} - ${labelMap[object.kind]}</b>`);
      if (object.city) lines.push(object.city);
      if (object.label && object.label !== object.city) lines.push(object.label);
      if (object.product) {
        const wt = object.weightKg ? ` - ${(object.weightKg / 1000).toFixed(1)} t` : '';
        lines.push(`${object.product}${wt}`);
      }
      if (object.kind === 'break' && object.serviceSec) {
        lines.push(`Driver break - ${Math.round(object.serviceSec / 60)} min`);
      }
      if (object.waitSec) lines.push(`Wait ${Math.round(object.waitSec / 60)} min`);
      return {
        html: lines.filter(Boolean).join('<br/>'),
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
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

      {/* PAYLOAD SIZE ROW */}
      {(() => {
        const used = 2 * maxVehicles + 2 * maxInternal + 2 * maxExternal;
        const overBudget = used > BM_MAX_MATRIX_LOCATIONS;
        const nearBudget = !overBudget && used >= Math.round(BM_MAX_MATRIX_LOCATIONS * 0.8);
        const counterColor = overBudget ? '#dc2626' : nearBudget ? '#d97706' : 'var(--text-secondary)';
        const clampedPreview = overBudget
          ? clampPayload(maxVehicles, maxInternal, maxExternal, BM_MAX_MATRIX_LOCATIONS)
          : null;
        return (
          <>
            <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: 0.5 }}>PAYLOAD SIZE (matrix budget)</div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}>
              <div style={sliderBlock}>
                <label style={labelStyle}>Max trailers: {maxVehicles}<InfoTip text={"How many idle trailers (closest to shipments) get sent to VROOM. Trailers beyond this cap are skipped \u2014 raise this to lift the assignment ratio.\n\nDefault 15. Auto-clamped on Solve so the precomputed ORS matrix stays under " + BM_MAX_MATRIX_LOCATIONS + " unique locations (gateway 45 s timeout protection)."} /></label>
                <input type="range" min={BM_VEHICLES_MIN} max={BM_VEHICLES_MAX} value={maxVehicles} onChange={e => setMaxVehicles(Number(e.target.value))} style={{ width: '100%' }} />
              </div>
              <div style={sliderBlock}>
                <label style={labelStyle}>Max internal volumes: {maxInternal}<InfoTip text="How many internal (own-fleet) shipments enter the solver, sorted by proximity to the nearest idle trailer." /></label>
                <input type="range" min={BM_INTERNAL_MIN} max={BM_INTERNAL_MAX} value={maxInternal} onChange={e => setMaxInternal(Number(e.target.value))} style={{ width: '100%' }} />
              </div>
              <div style={sliderBlock}>
                <label style={labelStyle}>Max external offers: {maxExternal}<InfoTip text="How many external freight-exchange offers enter the solver, sorted by proximity to the nearest idle trailer." /></label>
                <input type="range" min={BM_EXTERNAL_MIN} max={BM_EXTERNAL_MAX} value={maxExternal} onChange={e => setMaxExternal(Number(e.target.value))} style={{ width: '100%' }} />
              </div>
              <div style={{ minWidth: 220, fontSize: 12, color: counterColor }}>
                <div style={{ fontWeight: 600 }}>Locations used: {used} / {BM_MAX_MATRIX_LOCATIONS}</div>
                {overBudget && clampedPreview && (
                  <div style={{ fontSize: 11 }}>
                    Will clamp on Solve to {clampedPreview.v}/{clampedPreview.i}/{clampedPreview.e}
                  </div>
                )}
                {!overBudget && nearBudget && (
                  <div style={{ fontSize: 11 }}>Approaching matrix budget</div>
                )}
              </div>
            </div>
          </>
        );
      })()}

      {/* SOLVER ROW */}
      <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: 0.5 }}>SOLVER (VROOM-native)</div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12, padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 6 }}>
        <div style={sliderBlock}>
          <label style={labelStyle}>Max stops per trailer: {maxStops}<InfoTip text="How many shipments one trailer may collect on a single tour. 1 = pure backload (one extra pickup on the way home). Higher = consolidation tours.\n\nVROOM field: vehicle.max_tasks" /></label>
          <input type="range" min={1} max={6} value={maxStops} onChange={e => setMaxStops(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={sliderBlock}>
          <label style={labelStyle}>Detour budget: +{detourSlackHrs} h<InfoTip text="Extra hours allowed on top of each trailer's empty drive home (shortest-path travel time from current dropoff to its end point). Adds linearly per vehicle. Open-end mode uses a fixed 200 km baseline (~3.3 h).\n\nVROOM field: vehicle.max_travel_time = baseline_sec + slack*3600" /></label>
          <input type="range" min={0} max={12} value={detourSlackHrs} onChange={e => setDetourSlackHrs(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={sliderBlock}>
          <label style={labelStyle}>Allowed deviation: +{deviationPct}%<InfoTip text="Distance cap as a percentage above each trailer's empty drive home (shortest-path distance from current dropoff to its end point). E.g. 200% = tour may be up to 3× the empty distance. Open-end mode uses a fixed 200 km baseline.\n\nVROOM field: vehicle.max_distance = baseline_m * (1 + dev%/100)" /></label>
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
        <button className="btn-primary" onClick={solve} disabled={solving || !trailers.length || !vehicleClass || !orsProfile} style={{ background: '#0DB048', minWidth: 140 }} title={!vehicleClass ? (vehicleClassError || 'Vehicle class profile not loaded') : (!orsProfile ? 'ORS profile not provisioned for this region' : '')}>
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
      {vehicleClassError && (<div style={{ marginBottom: 12, fontSize: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.45)', borderRadius: 4, color: '#b91c1c' }}><b>Vehicle class issue.</b> {vehicleClassError}</div>)}
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
