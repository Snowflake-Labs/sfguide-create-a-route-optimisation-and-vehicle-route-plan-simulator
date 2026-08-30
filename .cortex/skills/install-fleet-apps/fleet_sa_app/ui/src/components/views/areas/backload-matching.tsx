'use client';

// Backload Matching Engine (neutral, industry-agnostic, USD).
//
// Fleet-wide VRP solve: idle trailers as capacitated vehicles anchored at their
// idle drop-off (ending home / a shared dest / open), internal loads + external
// offers as shipments (internal ranked first via priority). Every visible knob
// maps 1:1 to a VROOM/ORS field. Reads go through /api/query (SELECT-only);
// solves through /api/backload/solve (the neutral ROUTING_PLATFORM.CONTRACT
// seam); decisions through /api/backload/decide; per-vehicle empty-leg baselines
// + empty-leg polylines through the live routing seam. No vendor branding.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { ScatterplotLayer, GeoJsonLayer, PathLayer, TextLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { Layer } from '@deck.gl/core';
import MapView from './map-view';
import { coordsFromGeoJSON, type LngLat } from '@/lib/map/map-fit';
import { useAppStore } from '@/lib/store';
import { useRegionCamera } from '@/hooks/use-region-camera';
import { describeDeckLayers, usePublishMapState } from '@/lib/agent-memo';
import { escapeHtml } from '@/lib/html';
import type { ViewProps } from '@/lib/types';
import AssignmentList from './backload-matching/AssignmentList';
import StopsPanel from './backload-matching/StopsPanel';
import DecisionsAudit from './backload-matching/DecisionsAudit';
import InfoTip from './backload-matching/InfoTip';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';
import { isSuspendedBody, type SuspendedInfo } from '@/lib/routing-suspend';
import {
  BM, COST_SCALE, USD_PER_LOADED_KM, KMH_DEFAULT, ROUTE_COLORS,
  sfRead, sqlLiteral, haversineKm, synthPallets, synthVolumeM3,
  fetchVehicleClass, computeEmptyLegBaselines, fetchEmptyLeg, fetchTourPath, trimPathAt,
  findUnroutablePoints, coordKey,
  type Trailer, type Volume, type Offer, type Assignment, type Stop,
  type VehicleClass, type EmptyLegBaseline,
} from './backload-matching/helpers';

// Cached ORS empty-leg result (geometry + real road km) keyed by
// `<trailer>|<offer>` for the outbound leg and `<trailer>|<offer>|ret` for the
// return reposition.
type EmptyLegCacheEntry = { geo: unknown; km: number | null };

// Default payload caps (editable via sliders). clampPayload enforces the matrix
// budget on Solve so the precomputed ORS matrix stays under the location cap.
const BM_DEFAULT_MAX_VEHICLES = 15;
const BM_DEFAULT_MAX_INTERNAL = 30;
const BM_DEFAULT_MAX_EXTERNAL = 15;
const BM_VEHICLES_MIN = 1, BM_VEHICLES_MAX = 60;
const BM_INTERNAL_MIN = 0, BM_INTERNAL_MAX = 80;
const BM_EXTERNAL_MIN = 0, BM_EXTERNAL_MAX = 60;
const BM_MAX_MATRIX_LOCATIONS = 500;
const BM_SOLVE_TIMEOUT_MS = 180_000;
// A single VROOM code-3 unroutable location aborts the whole solve. A bulk
// bidirectional MATRIX pre-filter (findUnroutablePoints) removes the bulk of
// unroutable points before the first solve; this loop is the thin safety net
// for the rare point that snaps leniently in MATRIX yet still aborts the solve.
// Cap the retries so a pathological dataset can never loop forever.
const BM_MAX_UNROUTABLE_RETRIES = 16;

// VROOM echoes the failing coordinate rounded to ~6dp, so match with a small
// epsilon rather than exact equality.
function coordNear(a: number, b: number): boolean { return Math.abs(a - b) < 1e-4; }
function locMatchesCoord(loc: unknown, lon: number, lat: number): boolean {
  return Array.isArray(loc) && coordNear(Number(loc[0]), lon) && coordNear(Number(loc[1]), lat);
}

type EndMode = 'home' | 'shared' | 'open';

function clampPayload(v: number, i: number, e: number, budget: number): { v: number; i: number; e: number; clamped: boolean } {
  const used = 2 * v + 2 * i + 2 * e;
  if (used <= budget) return { v, i, e, clamped: false };
  const scale = budget / used;
  return { v: Math.max(1, Math.floor(v * scale)), i: Math.max(0, Math.floor(i * scale)), e: Math.max(0, Math.floor(e * scale)), clamped: true };
}

export function BackloadMatchingView({ onStateChange }: Partial<ViewProps> = {}) {
  const region = useAppStore((s) => s.context['region']) as string | undefined;
  // Region bbox: frames the map on the active region immediately on a context
  // change, before any trailers/offers for that region have loaded.
  const regionCoords = useRegionCamera(region);

  const [cfg, setCfg] = useState<{ vehicleType: string; region: string } | null>(null);
  const [vehicleClass, setVehicleClass] = useState<VehicleClass | null>(null);
  const [vehicleClassError, setVehicleClassError] = useState<string | null>(null);
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [internal, setInternal] = useState<Volume[]>([]);
  const [external, setExternal] = useState<Offer[]>([]);
  const [seedHint, setSeedHint] = useState<string | null>(null);

  // Payload-size sliders (clamped to matrix budget on Solve).
  const [maxVehicles, setMaxVehicles] = useState(BM_DEFAULT_MAX_VEHICLES);
  const [maxInternal, setMaxInternal] = useState(BM_DEFAULT_MAX_INTERNAL);
  const [maxExternal, setMaxExternal] = useState(BM_DEFAULT_MAX_EXTERNAL);

  // Solver levers (each maps 1:1 to VROOM/ORS).
  const [maxStops, setMaxStops] = useState(2);
  const [detourSlackHrs, setDetourSlackHrs] = useState(4);
  const [deviationPct, setDeviationPct] = useState(200);
  const [internalFirstWeight, setInternalFirstWeight] = useState(90);
  const [windowSlackHrs, setWindowSlackHrs] = useState(2);
  const [endMode, setEndMode] = useState<EndMode>('home');
  const [sharedDestLon, setSharedDestLon] = useState<number | null>(null);
  const [sharedDestLat, setSharedDestLat] = useState<number | null>(null);
  const [sharedDestUserEdited, setSharedDestUserEdited] = useState(false);

  // Economics levers (USD).
  const [costPerHourUsd, setCostPerHourUsd] = useState(28);
  const [costPerKmUsd, setCostPerKmUsd] = useState(0.80);
  const [fixedDispatchUsd, setFixedDispatchUsd] = useState(140);
  const [costPerDeliveryUsd, setCostPerDeliveryUsd] = useState(15);
  const [internalRatePerKm, setInternalRatePerKm] = useState(USD_PER_LOADED_KM);
  const [hideUnprofitable, setHideUnprofitable] = useState(false);

  // Engine-feature toggles.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [enforceDriverBreak, setEnforceDriverBreak] = useState(false);
  const [breakAfterHrs, setBreakAfterHrs] = useState(4.5);
  const [breakLengthMin, setBreakLengthMin] = useState(45);
  const [enforceShift, setEnforceShift] = useState(false);
  const [shiftLengthHrs, setShiftLengthHrs] = useState(9);
  const [useMultiDimCapacity, setUseMultiDimCapacity] = useState(false);
  const [useMultiWindow, setUseMultiWindow] = useState(false);
  const [showWaitTimes, setShowWaitTimes] = useState(true);

  const [solving, setSolving] = useState(false);
  const solveAbortRef = useRef<AbortController | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const emptyLegCacheRef = useRef<Map<string, EmptyLegCacheEntry>>(new Map());
  // Cached ORS loaded-tour polyline keyed by `<trailer>|<offer>|tour`.
  const tourCacheRef = useRef<Map<string, unknown>>(new Map());
  const [unassigned, setUnassigned] = useState<{ id: number; reason?: string }[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<string | null>(null);
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const [rationaleLoading, setRationaleLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  const [solverLog, setSolverLog] = useState<string | null>(null);
  // How many vehicles the last solve actually submitted to VROOM. This is the
  // only honest denominator for "% dispatched assigned" - the idle pool is much
  // larger than what clampPayload / the routable pre-filter let through.
  const [solveStats, setSolveStats] = useState<{ vehiclesSent: number } | null>(null);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [suspended, setSuspended] = useState<SuspendedInfo | null>(null);
  const [auditRows, setAuditRows] = useState<Record<string, unknown>[]>([]);

  const recenterRef = useRef<(() => void) | null>(null);

  // Auto-fill shared destination from the first trailer's home when not edited.
  useEffect(() => {
    if (endMode !== 'shared' || sharedDestUserEdited) return;
    const t = trailers[0];
    if (!t) return;
    setSharedDestLon(Number(t.HOME_LON));
    setSharedDestLat(Number(t.HOME_LAT));
  }, [endMode, trailers, sharedDestUserEdited]);

  const refetch = useCallback(async () => {
    setVehicleClassError(null);
    try {
      const cfgRows = await sfRead(`SELECT VEHICLE_TYPE, REGION FROM ${BM}.VW_CONFIG LIMIT 1`);
      const c = cfgRows[0] as { VEHICLE_TYPE?: string; REGION?: string } | undefined;
      const vehicleType = String(c?.VEHICLE_TYPE ?? 'hgv');
      const cfgRegion = String(c?.REGION ?? region ?? 'SanFrancisco');
      setCfg({ vehicleType, region: cfgRegion });

      const [tRows, iRows, oRows] = await Promise.all([
        sfRead(`SELECT * FROM ${BM}.VW_TRAILERS`),
        sfRead(`SELECT * FROM ${BM}.VW_INTERNAL_VOLUMES`),
        sfRead(`SELECT * FROM ${BM}.VW_EXTERNAL_OFFERS`),
      ]);

      // Defensive dedupe (guards against upstream view regressions feeding VROOM
      // duplicate vehicles / shipments -> visually-identical duplicate cards).
      const seenT = new Set<string>();
      const tDeduped = (tRows as unknown as Trailer[]).filter((r) => {
        const id = String(r.TRAILER_ID);
        if (seenT.has(id)) return false; seenT.add(id); return true;
      });
      const seenI = new Set<string>();
      const iDeduped = (iRows as unknown as Volume[]).filter((v) => {
        const k = `${Number(v.PICKUP_LON).toFixed(6)},${Number(v.PICKUP_LAT).toFixed(6)}|${Number(v.DROPOFF_LON).toFixed(6)},${Number(v.DROPOFF_LAT).toFixed(6)}|${v.WEIGHT_KG}`;
        if (seenI.has(k)) return false; seenI.add(k); return true;
      });
      const seenO = new Set<string>();
      const oDeduped = (oRows as unknown as Offer[]).filter((o) => {
        const k = String(o.OFFER_ID);
        if (seenO.has(k)) return false; seenO.add(k); return true;
      });
      setTrailers(tDeduped);
      setInternal(iDeduped);
      setExternal(oDeduped);
      // A data reload invalidates the previous solve: drop the results and the
      // dispatch stats together so the KPI denominator can never be paired with
      // assignments from a different preset / region.
      setAssignments([]); setUnassigned([]); setSelectedAssignment(null);
      setSolveStats(null); setSolverLog(null);

      let cls: VehicleClass | null = null;
      try { cls = await fetchVehicleClass(vehicleType); }
      catch (e) { setVehicleClassError(`Failed to load vehicle class: ${e instanceof Error ? e.message : e}`); }
      setVehicleClass(cls);
      if (!cls) setVehicleClassError(`Unknown vehicle_type "${vehicleType}". Add a row to the vehicle class profile before solving.`);
      else {
        // Seed economics defaults from the class the first time it loads.
        if (Number.isFinite(cls.COST_PER_KM)) setCostPerKmUsd(cls.COST_PER_KM);
        if (Number.isFinite(cls.COST_PER_HR)) setCostPerHourUsd(cls.COST_PER_HR);
      }

      if (!tDeduped.length || !iDeduped.length || !oDeduped.length) {
        setSeedHint(`Tables are empty for the active preset (${vehicleType} / ${cfgRegion}) - trailers: ${tDeduped.length}, internal: ${iDeduped.length}, external: ${oDeduped.length}. Run a Data Studio job for this preset to populate the freight data.`);
      } else {
        setSeedHint(null);
      }
    } catch (e) {
      setSeedHint(e instanceof Error ? e.message : 'Failed to load backload data');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region]);

  useEffect(() => { refetch(); }, [refetch]);

  // -----------------------------------------------------------------
  // Solve - every visible knob lands inside the OPTIMIZATION call.
  // -----------------------------------------------------------------
  const solve = useCallback(async () => {
    if (!trailers.length || !cfg) return;
    if (!vehicleClass) {
      setSolveError(vehicleClassError || 'Vehicle class profile not loaded.');
      return;
    }
    setSolving(true); setAssignments([]); setUnassigned([]); setRationale({});
    setConfirmMsg(null); setSolverLog(null); setSolveError(null); setSelectedAssignment(null);
    setSolveStats(null);

    const cls = vehicleClass;
    const profile = cls.ORS_PROFILE;
    const speedKmh = cls.AVG_SPEED_KMH || KMH_DEFAULT;
    const homeRangeKm = cls.HOME_RANGE_KM || 50;
    const classCapacityKg = cls.PAYLOAD_KG_MAX || cls.PAYLOAD_KG_TYP || 1000;

    const firstTrailer = trailers[0];
    const fallbackLon = firstTrailer ? Number(firstTrailer.HOME_LON) : null;
    const fallbackLat = firstTrailer ? Number(firstTrailer.HOME_LAT) : null;
    const effSharedLon = sharedDestLon ?? fallbackLon;
    const effSharedLat = sharedDestLat ?? fallbackLat;
    const trailerById = new Map<number, Trailer>();
    const trailerEnd = (t: Trailer): [number, number] | null => {
      if (endMode === 'open') return null;
      if (endMode === 'shared' && effSharedLon !== null && effSharedLat !== null) return [effSharedLon, effSharedLat];
      return [Number(t.HOME_LON), Number(t.HOME_LAT)];
    };
    // Fold per-hour cost into per-km via avg speed (deployed VROOM honours per_km).
    const effPerKmUsd = costPerKmUsd + costPerHourUsd / speedKmh;

    const nowSec = Math.floor(Date.now() / 1000);
    const etaSeconds = trailers
      .map((t) => Math.floor(new Date(t.ETA_TS || 0).getTime() / 1000))
      .filter((s) => Number.isFinite(s) && s > 0);
    const shiftStartSec = Math.max(etaSeconds.length ? Math.min(...etaSeconds) : nowSec, nowSec);
    const shiftEndSec = shiftStartSec + Math.round(shiftLengthHrs * 3600);

    const nearestTrailerKm = (lon: number, lat: number): number => {
      let best = Infinity;
      for (const t of trailers) {
        const d = haversineKm(Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT), lon, lat);
        if (d < best) best = d;
      }
      return best;
    };

    const clamped = clampPayload(maxVehicles, maxInternal, maxExternal, BM_MAX_MATRIX_LOCATIONS);
    const effMaxVehicles = clamped.v, effMaxInternal = clamped.i, effMaxExternal = clamped.e;

    const internalSubset = [...internal]
      .map((v) => ({ v, score: nearestTrailerKm(Number(v.PICKUP_LON), Number(v.PICKUP_LAT)) }))
      .sort((a, b) => a.score - b.score || String(a.v.ID).localeCompare(String(b.v.ID)))
      .slice(0, effMaxInternal).map((x) => x.v);
    const externalSubset = [...external]
      .map((o) => ({ o, score: nearestTrailerKm(Number(o.PICKUP_LON), Number(o.PICKUP_LAT)) }))
      .sort((a, b) => a.score - b.score || String(a.o.OFFER_ID).localeCompare(String(b.o.OFFER_ID)))
      .slice(0, effMaxExternal).map((x) => x.o);
    const internalSkipped = Math.max(0, internal.length - internalSubset.length);
    const externalSkipped = Math.max(0, external.length - externalSubset.length);

    // Per-vehicle empty-leg baselines (real ORS via CONTRACT.MATRIX, haversine
    // fallback) so Detour budget / Allowed deviation sliders bite per-vehicle.
    setSolverLog('Computing empty-leg baselines...');
    let baselines: Map<Trailer, EmptyLegBaseline>;
    try {
      baselines = await computeEmptyLegBaselines(profile, trailers.slice(0, effMaxVehicles), trailerEnd, cfg.region, { kmh: speedKmh, homeRangeKm });
    } catch { baselines = new Map(); }
    const FALLBACK_BASELINE: EmptyLegBaseline = { durSec: Math.round((homeRangeKm / speedKmh) * 3600), distMeters: homeRangeKm * 1000, source: 'fixed-open' };

    const vrpVehicles = trailers.slice(0, effMaxVehicles).map((t, i) => {
      const id = i + 1;
      trailerById.set(id, t);
      const endPt = trailerEnd(t);
      const capacityKg = Number(t.MAX_PAYLOAD_KG) || cls.PAYLOAD_KG_TYP;
      const base = baselines.get(t) ?? FALLBACK_BASELINE;
      const veh: Record<string, unknown> = {
        id, profile,
        start: [Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)],
        capacity: useMultiDimCapacity
          ? [capacityKg, Number(t.MAX_PALLETS) || synthPallets(capacityKg), Number(t.MAX_VOLUME_M3) || synthVolumeM3(capacityKg)]
          : [capacityKg],
        skills: t.HAZMAT_CERT ? [1, 2, 3] : [1, 2],
        max_tasks: maxStops,
        max_travel_time: Math.max(1800, base.durSec + Math.round(detourSlackHrs * 3600)),
        max_distance: Math.max(10_000, Math.round(base.distMeters * (1 + deviationPct / 100))),
        costs: { fixed: Math.round(fixedDispatchUsd * COST_SCALE), per_km: Math.round(effPerKmUsd * COST_SCALE) },
      };
      if (endPt) veh.end = endPt;
      if (enforceShift) veh.time_window = [shiftStartSec, shiftEndSec];
      if (enforceDriverBreak) {
        const breakStart = shiftStartSec + Math.round(breakAfterHrs * 3600);
        const breakLatest = shiftStartSec + Math.round((breakAfterHrs + 1.5) * 3600);
        veh.breaks = [{ id: 1, service: Math.round(breakLengthMin * 60), time_windows: [[breakStart, breakLatest]] }];
      }
      return veh;
    });

    const offerById = new Map<number, { kind: 'INTERNAL' | string; row: Volume | Offer }>();
    let nextId = 1000;
    const vrpShipments: Record<string, unknown>[] = [];
    const widenSec = Math.round(windowSlackHrs * 3600);
    const tw = (fromIso?: string | null, toIso?: string | null): number[][] | undefined => {
      if (!fromIso || !toIso) return undefined;
      const a = Math.floor(new Date(fromIso).getTime() / 1000);
      const b = Math.ceil(new Date(toIso).getTime() / 1000);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return undefined;
      const win1: number[] = [a - widenSec, b + widenSec];
      if (!useMultiWindow) return [win1];
      const win2: number[] = [win1[0] + 8 * 3600, win1[1] + 8 * 3600];
      return [win1, win2];
    };

    for (const v of internalSubset) {
      const id = nextId++;
      offerById.set(id, { kind: 'INTERNAL', row: v });
      const kg = Math.min(Number(v.WEIGHT_KG), classCapacityKg);
      const amount = useMultiDimCapacity ? [kg, Number(v.PALLETS) || synthPallets(kg), Number(v.VOLUME_M3) || synthVolumeM3(kg)] : [kg];
      vrpShipments.push({
        pickup: { id, location: [Number(v.PICKUP_LON), Number(v.PICKUP_LAT)], service: 1800, time_windows: tw(v.PICKUP_FROM_TS, v.PICKUP_TO_TS) },
        delivery: { id, location: [Number(v.DROPOFF_LON), Number(v.DROPOFF_LAT)], service: 600 },
        amount, skills: v.HAZMAT ? [1, 3] : [1], priority: internalFirstWeight,
      });
    }
    for (const o of externalSubset) {
      const id = nextId++;
      offerById.set(id, { kind: o.SOURCE, row: o });
      const kg = Math.min(Number(o.WEIGHT_KG), classCapacityKg);
      const amount = useMultiDimCapacity ? [kg, Number(o.PALLETS) || synthPallets(kg), Number(o.VOLUME_M3) || synthVolumeM3(kg)] : [kg];
      vrpShipments.push({
        pickup: { id, location: [Number(o.PICKUP_LON), Number(o.PICKUP_LAT)], service: 1800, time_windows: tw(o.PICKUP_FROM_TS, o.PICKUP_TO_TS) },
        delivery: { id, location: [Number(o.DROPOFF_LON), Number(o.DROPOFF_LAT)], service: 600 },
        amount, skills: o.HAZMAT ? [2, 3] : [2], priority: Math.max(0, 100 - internalFirstWeight),
      });
    }

    if (!vrpVehicles.length || !vrpShipments.length) {
      setSolveError('No trailers or loads available for the active preset.');
      setSolving(false);
      return;
    }

    const ac = new AbortController();
    solveAbortRef.current = ac;
    setSuspended(null);

    // Solve, dropping any VROOM code-3 unroutable location and re-solving the
    // remainder. A single point snapped onto a disconnected road component (or
    // farther than the region snap radius) otherwise aborts the whole solve
    // ("Unfound route(s) from location [lon,lat]" / "could not find routable
    // point within a radius of Xm"). VROOM names only ONE offending coordinate
    // per solve, so a dataset with many unroutable points would need one failed
    // solve per point. To avoid exhausting the retry cap on large regions
    // (Europe seeds freight across the whole bbox incl. islands / ocean-edge),
    // we first bulk-remove unroutable points via a bidirectional MATRIX probe,
    // then use the loop below only as a safety net.
    const excludedLabels: string[] = [];
    const droppedCoords: string[] = [];
    let workVehicles = vrpVehicles;
    let workShipments = vrpShipments;

    // Anchor for the routability probe: the trailer start with the most
    // neighbours within 300km (densest continental cluster centre) is on the
    // main road graph, so probing every point to/from it flags island /
    // off-road / disconnected points up front.
    const vehStarts = vrpVehicles
      .map((v) => (Array.isArray(v.start) ? (v.start as number[]) : null))
      .filter((s): s is number[] => s != null && s.length >= 2);
    let anchor: [number, number] | null = null;
    if (vehStarts.length) {
      let bestCount = -1;
      for (const cand of vehStarts) {
        let cnt = 0;
        for (const other of vehStarts) if (haversineKm(cand[0], cand[1], other[0], other[1]) <= 300) cnt++;
        if (cnt > bestCount) { bestCount = cnt; anchor = [cand[0], cand[1]]; }
      }
    }

    if (anchor) {
      setSolverLog('Checking stop routability...');
      const uniq = new Map<string, [number, number]>();
      const addPt = (loc: unknown) => {
        if (Array.isArray(loc) && loc.length >= 2) {
          const p: [number, number] = [Number(loc[0]), Number(loc[1])];
          if (Number.isFinite(p[0]) && Number.isFinite(p[1])) uniq.set(coordKey(p[0], p[1]), p);
        }
      };
      for (const v of vrpVehicles) { addPt(v.start); addPt(v.end); }
      for (const s of vrpShipments) {
        addPt((s.pickup as { location?: unknown }).location);
        addPt((s.delivery as { location?: unknown }).location);
      }
      let badKeys = new Set<string>();
      try { badKeys = await findUnroutablePoints(profile, [...uniq.values()], anchor, cfg.region, { signal: ac.signal }); }
      catch { badKeys = new Set(); }
      if (badKeys.size) {
        const locBad = (loc: unknown): boolean =>
          Array.isArray(loc) && loc.length >= 2 && badKeys.has(coordKey(Number(loc[0]), Number(loc[1])));
        workVehicles = vrpVehicles.filter((veh) => {
          const hit = locBad(veh.start) || locBad(veh.end);
          if (hit) { const t = trailerById.get(Number(veh.id)); excludedLabels.push(`${t?.TRAILER_ID ?? `vehicle ${veh.id}`} location`); }
          return !hit;
        });
        workShipments = vrpShipments.filter((s) => {
          const pu = (s.pickup as { location?: unknown }).location;
          const dl = (s.delivery as { location?: unknown }).location;
          const hitPickup = locBad(pu);
          const hitDelivery = locBad(dl);
          if (hitPickup || hitDelivery) {
            const sid = Number((s.pickup as { id?: unknown }).id);
            const ent = offerById.get(sid);
            const oid = ent ? (ent.kind === 'INTERNAL' ? (ent.row as unknown as Volume).ID : (ent.row as Offer).OFFER_ID) : `job ${sid}`;
            excludedLabels.push(`${ent?.kind ?? ''} ${oid} ${hitPickup ? 'pickup' : 'dropoff'}`.trim());
          }
          return !(hitPickup || hitDelivery);
        });
        for (const k of badKeys) droppedCoords.push(k);
      }
    }

    // Belt-and-suspenders: a pre-filter must never zero out the whole solve. If
    // it did (untrustworthy probe that slipped past the helper's own backoff),
    // discard it and solve the full set - the solve path detects a suspended
    // engine and the retry loop shears any real code-3 point. Do NOT surface an
    // "all unroutable" error here; that hides a live-but-degraded engine.
    if (!workVehicles.length || !workShipments.length) {
      workVehicles = vrpVehicles;
      workShipments = vrpShipments;
      excludedLabels.length = 0;
      droppedCoords.length = 0;
    }

    let respObj: Record<string, unknown> | null = null;
    let fatal: string | null = null;

    for (let attempt = 0; attempt <= BM_MAX_UNROUTABLE_RETRIES; attempt++) {
      const deadlineHandle = setTimeout(() => ac.abort(), BM_SOLVE_TIMEOUT_MS);
      // Solve for assignments and steps only. options.g=false tells the gateway
      // to strip VROOM's per-route road geometry: decoded, it blows the 20MB
      // _OPTIMIZATION_RAW external-function cap on large regions (Snowflake
      // 100335). The map fetches each tour's road path lazily via ORS
      // DIRECTIONS in the enrichment pass below.
      const challenge = { vehicles: workVehicles, shipments: workShipments, options: { g: false } };
      setSolverLog(attempt === 0
        ? (excludedLabels.length ? `Excluded ${excludedLabels.length} unroutable stop(s); calling OPTIMIZATION...` : 'Calling OPTIMIZATION...')
        : `Re-solving without ${excludedLabels.length} unroutable stop(s)...`);
      let body: { ok?: boolean; result?: unknown; error?: string; unroutable?: { lon: number; lat: number } };
      let ok = false;
      try {
        const res = await fetch('/api/backload/solve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge, region: cfg.region }), signal: ac.signal,
        });
        body = await res.json();
        ok = res.ok;
        // Suspended routing engine: server has triggered a resume. Show the
        // shared notice with a Retry instead of a raw solver error.
        if (res.status === 503 && isSuspendedBody(body)) {
          clearTimeout(deadlineHandle);
          solveAbortRef.current = null;
          setSuspended(body);
          setSolving(false);
          return;
        }
      } catch (e) {
        clearTimeout(deadlineHandle);
        solveAbortRef.current = null;
        const err = e as { name?: string; message?: string };
        setSolveError(err?.name === 'AbortError'
          ? `Solve cancelled or timed out after ${Math.round(BM_SOLVE_TIMEOUT_MS / 1000)}s. Try lowering Max stops, deviation %, or disabling Multi-window pickups.`
          : `OPTIMIZATION call failed: ${err?.message || e}`);
        setSolving(false);
        return;
      }
      clearTimeout(deadlineHandle);

      if (ok) { respObj = body.result as Record<string, unknown>; break; }

      // Extract the unroutable coordinate (structured field, else parse the msg).
      let bad = body.unroutable ?? null;
      if (!bad && typeof body.error === 'string') {
        const m = /location\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/i.exec(body.error);
        if (m) bad = { lon: Number(m[1]), lat: Number(m[2]) };
      }
      const badKey = bad ? `${bad.lon.toFixed(4)},${bad.lat.toFixed(4)}` : null;
      if (!bad || (badKey && droppedCoords.includes(badKey))) {
        // Not a parseable unroutable point, or dropping it made no progress.
        fatal = body.error || 'Solver returned an error.';
        break;
      }
      droppedCoords.push(badKey!);

      // Drop every vehicle (start/end) and shipment (pickup/delivery) that sits
      // on the offending coordinate, recording a human label for each.
      workVehicles = workVehicles.filter((veh) => {
        const hit = locMatchesCoord(veh.start, bad!.lon, bad!.lat) || locMatchesCoord(veh.end, bad!.lon, bad!.lat);
        if (hit) { const t = trailerById.get(Number(veh.id)); excludedLabels.push(`${t?.TRAILER_ID ?? `vehicle ${veh.id}`} location`); }
        return !hit;
      });
      workShipments = workShipments.filter((s) => {
        const pu = (s.pickup as { location?: unknown } | undefined)?.location;
        const dl = (s.delivery as { location?: unknown } | undefined)?.location;
        const hitPickup = locMatchesCoord(pu, bad!.lon, bad!.lat);
        const hitDelivery = locMatchesCoord(dl, bad!.lon, bad!.lat);
        if (hitPickup || hitDelivery) {
          const sid = Number((s.pickup as { id?: unknown } | undefined)?.id);
          const ent = offerById.get(sid);
          const oid = ent ? (ent.kind === 'INTERNAL' ? (ent.row as unknown as Volume).ID : (ent.row as Offer).OFFER_ID) : `job ${sid}`;
          excludedLabels.push(`${ent?.kind ?? ''} ${oid} ${hitPickup ? 'pickup' : 'dropoff'}`.trim());
        }
        return !(hitPickup || hitDelivery);
      });

      if (!workVehicles.length) { fatal = 'All trailers are at unroutable locations for this region. Regenerate the preset data or pick another region.'; break; }
      if (!workShipments.length) { fatal = 'Every load pickup/dropoff is unroutable for this region. Regenerate the preset data or pick another region.'; break; }
    }
    solveAbortRef.current = null;

    if (!respObj) {
      setSolveError(fatal || `Solver could not find a routable plan after excluding ${excludedLabels.length} stop(s).`);
      setSolving(false);
      return;
    }

    const vroomRoutes = Array.isArray(respObj?.routes) ? (respObj!.routes as Record<string, unknown>[]) : [];
    const vroomUnassigned = Array.isArray(respObj?.unassigned) ? (respObj!.unassigned as Record<string, unknown>[]) : [];
    const vroomError: string | null = (respObj?.error as string) ||
      (respObj?.code && respObj?.code !== 0 ? ((respObj?.message as string) || `VROOM code=${respObj.code}`) : null);

    const newAssignments: Assignment[] = [];
    const newUnassigned: { id: number; reason?: string }[] = [];
    for (const u of vroomUnassigned) {
      const id = Number(u?.id);
      if (Number.isFinite(id)) newUnassigned.push({ id, reason: (u?.description ?? u?.type ?? undefined) as string | undefined });
    }

    for (const route of vroomRoutes) {
      const vehId = Number(route?.vehicle);
      if (!vehId) continue;
      const t = trailerById.get(vehId);
      if (!t) continue;
      const steps = Array.isArray(route?.steps) ? (route.steps as Record<string, unknown>[]) : [];
      // Normally null: the solve requests no geometry (options.g=false) and the
      // enrichment pass below fills ROUTE_GEOJSON from ORS DIRECTIONS. Kept as a
      // defensive read so a geometry-bearing response is still honoured.
      const routeGeo = Array.isArray(route?.geometry) && (route.geometry as unknown[]).length > 1
        ? { type: 'LineString', coordinates: route.geometry } : null;
      const taskSteps = steps.filter((s) => s.type === 'pickup' || s.type === 'delivery' || s.type === 'job' || s.type === 'break');
      if (!taskSteps.length) continue;
      const firstPick = taskSteps.find((s) => s.type === 'pickup' || s.type === 'job');
      if (!firstPick) continue;
      const ent = offerById.get(Number(firstPick.id ?? firstPick.job));
      if (!ent) continue;
      const row = ent.row as Offer;
      const empty = haversineKm(Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT), Number(row.PICKUP_LON), Number(row.PICKUP_LAT));
      const loaded = haversineKm(Number(row.PICKUP_LON), Number(row.PICKUP_LAT), Number(row.DROPOFF_LON), Number(row.DROPOFF_LAT));

      const stops: Stop[] = [];
      stops.push({ kind: 'start', label: 'Vehicle idle location', city: t.DROPOFF_CITY, lon: Number(t.DROPOFF_LON), lat: Number(t.DROPOFF_LAT) });
      let totalLoadedKm = 0;
      let prevLon: number | null = null, prevLat: number | null = null;
      for (const ts of taskSteps) {
        const sid = Number(ts.id ?? ts.job);
        const wait = Number(ts.waiting_time) || 0;
        if (ts.type === 'break') {
          const lon = Number((ts.location as number[] | undefined)?.[0]) || prevLon || Number(t.DROPOFF_LON);
          const lat = Number((ts.location as number[] | undefined)?.[1]) || prevLat || Number(t.DROPOFF_LAT);
          stops.push({ kind: 'break', label: `Driver break (${Math.round((Number(ts.service) || breakLengthMin * 60) / 60)} min)`, lon, lat, waitSec: wait, serviceSec: Number(ts.service) || breakLengthMin * 60 });
          continue;
        }
        const je = offerById.get(sid);
        if (!je) continue;
        const jr = je.row as Offer;
        const offerId = je.kind === 'INTERNAL' ? (jr as unknown as Volume).ID : jr.OFFER_ID;
        if (ts.type === 'delivery') {
          if (prevLon !== null && prevLat !== null) totalLoadedKm += haversineKm(prevLon, prevLat, Number(jr.DROPOFF_LON), Number(jr.DROPOFF_LAT));
          stops.push({ kind: 'dropoff', label: `${je.kind} ${offerId}`, city: jr.DROPOFF_CITY, lon: Number(jr.DROPOFF_LON), lat: Number(jr.DROPOFF_LAT), jobId: sid, offerId, source: je.kind, product: jr.PRODUCT, weightKg: Number(jr.WEIGHT_KG) || undefined, waitSec: wait });
          prevLon = Number(jr.DROPOFF_LON); prevLat = Number(jr.DROPOFF_LAT);
        } else {
          stops.push({ kind: 'pickup', label: `${je.kind} ${offerId}`, city: jr.PICKUP_CITY, lon: Number(jr.PICKUP_LON), lat: Number(jr.PICKUP_LAT), jobId: sid, offerId, source: je.kind, product: jr.PRODUCT, weightKg: Number(jr.WEIGHT_KG) || undefined, waitSec: wait });
          prevLon = Number(jr.PICKUP_LON); prevLat = Number(jr.PICKUP_LAT);
          if (ts.type === 'job') {
            stops.push({ kind: 'dropoff', label: `${je.kind} ${offerId}`, city: jr.DROPOFF_CITY, lon: Number(jr.DROPOFF_LON), lat: Number(jr.DROPOFF_LAT), jobId: sid, offerId, source: je.kind, product: jr.PRODUCT, weightKg: Number(jr.WEIGHT_KG) || undefined });
            prevLon = Number(jr.DROPOFF_LON); prevLat = Number(jr.DROPOFF_LAT);
          }
        }
      }
      const endPt = endMode === 'open' ? null
        : (endMode === 'shared' && effSharedLon !== null && effSharedLat !== null ? [effSharedLon, effSharedLat] as [number, number] : [Number(t.HOME_LON), Number(t.HOME_LAT)] as [number, number]);
      const endLon = endPt ? endPt[0] : (prevLon ?? Number(t.HOME_LON));
      const endLat = endPt ? endPt[1] : (prevLat ?? Number(t.HOME_LAT));
      stops.push({ kind: 'end', label: endMode === 'open' ? 'Tour ends here (open-ended)' : (endMode === 'shared' ? 'Shared destination' : 'Home depot'), city: endMode === 'home' ? t.HOME_DEPOT : undefined, lon: endLon, lat: endLat });

      const offerIdFirst = ent.kind === 'INTERNAL' ? (row as unknown as Volume).ID : row.OFFER_ID;

      const tourSec = Number(route?.duration) || 0;
      const tourHrs = tourSec / 3600;
      const tourKmReal = (Number(route?.distance) || (tourSec * speedKmh / 3600 * 1000)) / 1000;

      // Deadhead accounting. Two empty legs exist on every closed tour: the
      // outbound reposition (idle location -> first pickup) and the return
      // reposition (last task stop -> tour end). Both are real empty km; the
      // return leg used to be omitted entirely, which understated EMPTY_KM and
      // let the tour polyline paint the reposition home as if it were loaded.
      // Haversine here is the seed value - the lazy ORS fetch below replaces
      // both with real road distance when the routing seam answers.
      const emptyOutKm = empty;
      const emptyBackKm = endMode === 'open' || prevLon === null || prevLat === null
        ? 0
        : haversineKm(prevLon, prevLat, endLon, endLat);
      const emptyKm = emptyOutKm + emptyBackKm;

      // Baseline = what this vehicle would have driven EMPTY anyway to get from
      // its idle location to its end point (real ORS distance from
      // computeEmptyLegBaselines, haversine/fixed fallback). "Deadhead avoided"
      // is that baseline minus the empty km actually driven on the tour, so it
      // can never exceed the reposition the vehicle was going to make. The old
      // formula (directHomeKm - detourKm) reported almost the entire straight-line
      // distance to a far-away home depot as a saving, which is why it routinely
      // came out larger than the loaded distance.
      const baseline = baselines.get(t);
      const baselineEmptyKm = baseline ? baseline.distMeters / 1000 : undefined;
      const baselineSource = baseline ? baseline.source : undefined;
      const savedKm = baselineEmptyKm !== undefined && baselineSource !== 'fixed-open'
        ? Math.max(0, baselineEmptyKm - emptyKm)
        : undefined;
      // Marginal distance added versus that same baseline, in real road km so the
      // card stops mixing haversine and ORS distances.
      const detourKm = baselineEmptyKm !== undefined ? Math.max(0, tourKmReal - baselineEmptyKm) : undefined;

      const waitSec = taskSteps.reduce((s, ts) => s + (Number(ts.waiting_time) || 0), 0);

      const nDeliv = taskSteps.filter((s) => s.type === 'delivery' || s.type === 'job').length;

      let revenue = 0;
      for (const ts of taskSteps) {
        if (ts.type !== 'pickup' && ts.type !== 'job') continue;
        const je = offerById.get(Number(ts.id ?? ts.job));
        if (!je) continue;
        const jr = je.row as Offer;
        const segLoadedKm = haversineKm(Number(jr.PICKUP_LON), Number(jr.PICKUP_LAT), Number(jr.DROPOFF_LON), Number(jr.DROPOFF_LAT));
        if (je.kind === 'INTERNAL') revenue += segLoadedKm * internalRatePerKm;
        else revenue += Number(jr.PRICE_USD) || segLoadedKm * internalRatePerKm;
      }
      const cost = fixedDispatchUsd + tourHrs * costPerHourUsd + tourKmReal * costPerKmUsd + nDeliv * costPerDeliveryUsd;

      newAssignments.push({
        ASSIGNMENT_ID: `${t.TRAILER_ID}|${offerIdFirst}`,
        TRAILER_ID: t.TRAILER_ID, OFFER_ID: offerIdFirst, SOURCE: ent.kind,
        PICKUP_LON: Number(row.PICKUP_LON), PICKUP_LAT: Number(row.PICKUP_LAT),
        DROPOFF_LON: Number(row.DROPOFF_LON), DROPOFF_LAT: Number(row.DROPOFF_LAT),
        TRAILER_DROPOFF_LON: Number(t.DROPOFF_LON), TRAILER_DROPOFF_LAT: Number(t.DROPOFF_LAT),
        HOME_LON: Number(t.HOME_LON), HOME_LAT: Number(t.HOME_LAT),
        EMPTY_KM: emptyKm, LOADED_KM: totalLoadedKm || loaded, DETOUR_KM: detourKm, SAVED_KM: savedKm,
        EMPTY_OUT_KM: emptyOutKm, EMPTY_BACK_KM: emptyBackKm,
        BASELINE_EMPTY_KM: baselineEmptyKm, BASELINE_SOURCE: baselineSource,
        END_LON: endLon, END_LAT: endLat,
        LAST_TASK_LON: prevLon ?? undefined, LAST_TASK_LAT: prevLat ?? undefined,
        SCORE: tourSec, PRODUCT: row.PRODUCT, PICKUP_CITY: row.PICKUP_CITY, PROPOSAL_DROPOFF_CITY: row.DROPOFF_CITY,
        ROUTE_GEOJSON: routeGeo, STOPS: stops, TOUR_KM: tourKmReal, TOUR_HRS: tourHrs, WAIT_SEC: waitSec,
        N_DELIVERIES: nDeliv, COST_USD: cost, REVENUE_USD: revenue, NET_BENEFIT_USD: revenue - cost,
      });
    }

    setAssignments(newAssignments);
    setUnassigned(newUnassigned);
    // Record what was actually dispatched (post clamp + post routable pre-filter)
    // so the "% dispatched assigned" KPI divides by the set the solver saw.
    setSolveStats({ vehiclesSent: workVehicles.length });
    const avgDetour = newAssignments.length ? Math.round(newAssignments.reduce((s, a) => s + (a.DETOUR_KM || 0), 0) / newAssignments.length) : 0;
    const totalNet = Math.round(newAssignments.reduce((s, a) => s + (a.NET_BENEFIT_USD || 0), 0));
    const excludedNote = excludedLabels.length
      ? ` Excluded ${excludedLabels.length} unroutable stop(s): ${excludedLabels.slice(0, 6).join('; ')}${excludedLabels.length > 6 ? ` (+${excludedLabels.length - 6} more)` : ''}.`
      : '';
    setSolverLog(`Sent ${workVehicles.length} vehicles, ${workShipments.length} shipments (maxStops=${maxStops}, dev=${deviationPct}%, slack=+${detourSlackHrs}h, caps=${effMaxVehicles}v/${effMaxInternal}i/${effMaxExternal}e${clamped.clamped ? ` [clamped from ${maxVehicles}/${maxInternal}/${maxExternal}]` : ''}, intFirst=${internalFirstWeight}, end=${endMode}; skipped ${internalSkipped} internal, ${externalSkipped} external).${excludedNote} Got ${vroomRoutes.length} routes, ${vroomUnassigned.length} unassigned -> ${newAssignments.length} assigned. Avg detour +${avgDetour} km. Net benefit total $${totalNet.toLocaleString()}.`);

    if (vroomError) {
      setSolveError(`Routing gateway / VROOM error: ${vroomError}`);
    } else if (newAssignments.length === 0 && newUnassigned.length > 0) {
      const counts = newUnassigned.reduce((m: Record<string, number>, u) => { const k = u.reason || 'unknown'; m[k] = (m[k] || 0) + 1; return m; }, {});
      const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n}x ${r}`).join(', ');
      setSolveError(`Solver placed 0 shipments out of ${newUnassigned.length}. Top reasons: ${summary}. Raise deviation %, raise detour budget, widen window slack, or relax skill requirements.`);
    } else if (vroomRoutes.length === 0 && !newAssignments.length) {
      setSolveError('Solver returned no routes. Try raising Detour budget or Allowed deviation, and confirm the region routing service is running.');
    }

    // Lazily fetch the three polylines a tour needs through the live routing
    // seam: the loaded path (first pickup -> last task stop), and both empty legs
    // - outbound (idle location -> first pickup) and return (last task stop ->
    // tour end). The loaded path is fetched here rather than taken from the solve
    // response because the solve runs with VROOM geometry disabled to stay under
    // the 20MB _OPTIMIZATION_RAW cap. The real road distance that comes back
    // replaces the haversine seed for EMPTY_OUT_KM / EMPTY_BACK_KM, so EMPTY_KM,
    // SAVED_KM, and DETOUR_KM all end up in the same distance system as TOUR_KM.
    Promise.all(newAssignments.map(async (a) => {
      const outKey = `${a.TRAILER_ID}|${a.OFFER_ID}`;
      const retKey = `${outKey}|ret`;
      const tourKey = `${outKey}|tour`;

      const cachedTour = tourCacheRef.current.get(tourKey);
      if (cachedTour) {
        a.ROUTE_GEOJSON = cachedTour;
      } else {
        const geo = await fetchTourPath(profile, a.STOPS, cfg.region);
        if (geo) {
          tourCacheRef.current.set(tourKey, geo);
          a.ROUTE_GEOJSON = geo;
        }
      }
      const cachedOut = emptyLegCacheRef.current.get(outKey) as EmptyLegCacheEntry | undefined;
      if (cachedOut) {
        a.EMPTY_GEOJSON = cachedOut.geo;
        if (cachedOut.km !== null) a.EMPTY_OUT_KM = cachedOut.km;
      } else {
        const leg = await fetchEmptyLeg(profile, [a.TRAILER_DROPOFF_LON, a.TRAILER_DROPOFF_LAT], [a.PICKUP_LON, a.PICKUP_LAT], cfg.region);
        if (leg) {
          emptyLegCacheRef.current.set(outKey, leg);
          a.EMPTY_GEOJSON = leg.geo;
          if (leg.km !== null) a.EMPTY_OUT_KM = leg.km;
        }
      }

      const hasReturn = a.END_LON !== undefined && a.END_LAT !== undefined
        && a.LAST_TASK_LON !== undefined && a.LAST_TASK_LAT !== undefined
        && (a.EMPTY_BACK_KM ?? 0) > 0;
      if (hasReturn) {
        const cachedRet = emptyLegCacheRef.current.get(retKey) as EmptyLegCacheEntry | undefined;
        if (cachedRet) {
          a.EMPTY_RETURN_GEOJSON = cachedRet.geo;
          if (cachedRet.km !== null) a.EMPTY_BACK_KM = cachedRet.km;
        } else {
          const leg = await fetchEmptyLeg(
            profile,
            [a.LAST_TASK_LON as number, a.LAST_TASK_LAT as number],
            [a.END_LON as number, a.END_LAT as number],
            cfg.region,
          );
          if (leg) {
            emptyLegCacheRef.current.set(retKey, leg);
            a.EMPTY_RETURN_GEOJSON = leg.geo;
            if (leg.km !== null) a.EMPTY_BACK_KM = leg.km;
          }
        }
      }

      a.EMPTY_KM = (a.EMPTY_OUT_KM ?? 0) + (a.EMPTY_BACK_KM ?? 0);
      if (a.BASELINE_EMPTY_KM !== undefined && a.BASELINE_SOURCE !== 'fixed-open') {
        a.SAVED_KM = Math.max(0, a.BASELINE_EMPTY_KM - a.EMPTY_KM);
      }
    })).then(() => setAssignments([...newAssignments]));

    setSolving(false);
  }, [
    trailers, internal, external, cfg, vehicleClass, vehicleClassError,
    maxVehicles, maxInternal, maxExternal, maxStops, detourSlackHrs, deviationPct,
    internalFirstWeight, windowSlackHrs, endMode, sharedDestLon, sharedDestLat,
    costPerHourUsd, costPerKmUsd, fixedDispatchUsd, costPerDeliveryUsd, internalRatePerKm,
    enforceDriverBreak, breakAfterHrs, breakLengthMin, enforceShift, shiftLengthHrs,
    useMultiDimCapacity, useMultiWindow,
  ]);

  // Auto-select the top assignment after a solve.
  useEffect(() => {
    if (!assignments.length) return;
    if (!selectedAssignment || !assignments.some((a) => a.ASSIGNMENT_ID === selectedAssignment)) {
      setSelectedAssignment(assignments[0].ASSIGNMENT_ID);
    }
  }, [assignments, selectedAssignment]);

  const askRationale = useCallback(async (a: Assignment) => {
    setRationaleLoading(true);
    try {
      const idleCity = trailers.find((t) => t.TRAILER_ID === a.TRAILER_ID)?.DROPOFF_CITY || '';
      const prompt = `You are a fleet dispatcher coach. In two short sentences, explain why vehicle ${a.TRAILER_ID} (idle in ${idleCity}) is a good match for ${a.SOURCE} offer ${a.OFFER_ID} (${a.PICKUP_CITY} -> ${a.PROPOSAL_DROPOFF_CITY}, ${Math.round(a.EMPTY_KM)} km empty, net $${Math.round(a.NET_BENEFIT_USD || 0)}, ${a.PRODUCT}). Mention empty km saved, profitability, and direction-to-home if relevant.`;
      const rows = await sfRead(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${sqlLiteral(prompt)}') AS R`);
      const text = String((rows[0] as { R?: string })?.R ?? '').trim();
      setRationale((prev) => ({ ...prev, [a.ASSIGNMENT_ID]: text || '(no rationale returned)' }));
    } catch (e) {
      setRationale((prev) => ({ ...prev, [a.ASSIGNMENT_ID]: e instanceof Error ? e.message : 'Rationale unavailable' }));
    } finally { setRationaleLoading(false); }
  }, [trailers]);

  const confirmPlan = useCallback(async () => {
    if (!assignments.length) return;
    setConfirming(true); setConfirmMsg(null);
    try {
      const res = await fetch('/api/backload/decide', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisions: assignments.map((a) => ({
            trailerId: a.TRAILER_ID, offerId: a.OFFER_ID, source: a.SOURCE,
            score: Number(a.SCORE.toFixed(2)), emptyKm: Number(a.EMPTY_KM.toFixed(1)),
            netBenefitUsd: Number((a.NET_BENEFIT_USD ?? 0).toFixed(2)), rationale: rationale[a.ASSIGNMENT_ID] ?? undefined,
          })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setConfirmMsg(`Wrote ${body.written} decisions to PROPOSAL_DECISIONS.`);
    } catch (e) {
      setConfirmMsg(e instanceof Error ? e.message : 'Write failed');
    } finally { setConfirming(false); }
  }, [assignments, rationale]);

  const loadAudit = useCallback(async () => {
    try {
      const rows = await sfRead(`SELECT TO_VARCHAR(DECIDED_AT, 'YYYY-MM-DD HH24:MI') AS DECIDED_AT, TRAILER_ID, OFFER_ID, SOURCE, ROUND(EMPTY_KM,1) AS EMPTY_KM, ROUND(COALESCE(NET_BENEFIT_USD, EMPTY_KM * ${USD_PER_LOADED_KM}), 0) AS USD_RECLAIMED FROM ${BM}.VW_PROPOSAL_DECISIONS ORDER BY DECIDED_AT DESC LIMIT 25`);
      setAuditRows(rows);
    } catch { setAuditRows([]); }
  }, []);
  useEffect(() => { loadAudit(); }, [loadAudit, confirmMsg]);

  // Hide-unprofitable filter applies to list AND map; always net-desc sorted.
  const visibleAssignments = useMemo(() => {
    const base = hideUnprofitable ? assignments.filter((a) => (a.NET_BENEFIT_USD ?? 0) >= 0) : assignments;
    return [...base].sort((a, b) => (b.NET_BENEFIT_USD ?? -Infinity) - (a.NET_BENEFIT_USD ?? -Infinity));
  }, [assignments, hideUnprofitable]);

  const totalNetBenefit = useMemo(() => Math.round(visibleAssignments.reduce((s, a) => s + (a.NET_BENEFIT_USD || 0), 0)), [visibleAssignments]);
  const internalCount = useMemo(() => visibleAssignments.filter((a) => a.SOURCE === 'INTERNAL').length, [visibleAssignments]);
  const internalPct = visibleAssignments.length ? Math.round((internalCount / visibleAssignments.length) * 100) : 0;
  // Denominator = vehicles actually submitted to the last solve; before the first
  // solve fall back to the idle pool. Clamped at 100 defensively - if the clamp
  // ever engages, the numerator/denominator pairing has regressed.
  const trailersConsidered = solveStats?.vehiclesSent ?? trailers.length;
  const trailersAssignedPct = trailersConsidered
    ? Math.min(100, Math.round((visibleAssignments.length / trailersConsidered) * 100))
    : 0;

  const selected = visibleAssignments.find((a) => a.ASSIGNMENT_ID === selectedAssignment) || null;
  const stopsPanelRef = useRef<HTMLDivElement | null>(null);

  // ---- agent grounding (Channel A; ref-guarded publish on change only) ----
  // Custom views keep results in local state, so the left-panel Cortex agent is
  // blind to the solved plan unless we surface it. Publish the on-screen
  // assignments as a bounded, pre-joined __memo_ STRING (viewState flattens
  // nested objects to "[object Object]"), plus scalar KPIs. MUST use the
  // ref+lastSent gate with deps [summary] only, or view-panel's fresh inline
  // onStateChange loops (React #185).
  const summary = useMemo(() => {
    const MAX_TRIPS = 12;
    const memo = visibleAssignments.length
      ? visibleAssignments.slice(0, MAX_TRIPS).map((a) => {
          const drops = Array.isArray(a.STOPS)
            ? a.STOPS.filter((s) => s.kind === 'dropoff').map((s) => s.city || s.label).filter(Boolean)
            : [];
          const dropStr = drops.length ? drops.join(', ') : (a.PROPOSAL_DROPOFF_CITY || '?');
          return `${a.TRAILER_ID} ${a.SOURCE} ${a.PICKUP_CITY || '?'}->${a.PROPOSAL_DROPOFF_CITY || '?'} | drops: ${dropStr} | ${a.N_DELIVERIES ?? drops.length} deliv, empty ${Math.round(a.EMPTY_KM || 0)}km (${Math.round(a.EMPTY_OUT_KM || 0)} out + ${Math.round(a.EMPTY_BACK_KM || 0)} back) loaded ${Math.round(a.LOADED_KM || 0)}km${a.SAVED_KM !== undefined ? `, deadhead avoided ${Math.round(a.SAVED_KM)}km vs ${Math.round(a.BASELINE_EMPTY_KM || 0)}km reposition baseline` : ''}, rev $${Math.round(a.REVENUE_USD || 0)} cost $${Math.round(a.COST_USD || 0)} net ${(a.NET_BENEFIT_USD ?? 0) >= 0 ? '+' : ''}$${Math.round(a.NET_BENEFIT_USD || 0)}`;
        }).join('; ') + (visibleAssignments.length > MAX_TRIPS ? ` (+${visibleAssignments.length - MAX_TRIPS} more)` : '')
      : null;
    return {
      view: 'backload_matching',
      region: cfg?.region ?? region ?? null,
      vehicle_type: cfg?.vehicleType ?? null,
      trailers: trailers.length,
      internal_volumes: internal.length,
      external_offers: external.length,
      assignments_count: visibleAssignments.length || null,
      internal_matched: visibleAssignments.length ? internalCount : null,
      internal_pct: visibleAssignments.length ? internalPct : null,
      vehicles_dispatched: solveStats?.vehiclesSent ?? null,
      trailers_assigned_pct: visibleAssignments.length ? trailersAssignedPct : null,
      net_benefit_usd: visibleAssignments.length ? totalNetBenefit : null,
      empty_km_total: visibleAssignments.length
        ? Math.round(visibleAssignments.reduce((s, a) => s + (a.EMPTY_KM || 0), 0)) : null,
      deadhead_avoided_km_total: visibleAssignments.length
        ? Math.round(visibleAssignments.reduce((s, a) => s + (a.SAVED_KM || 0), 0)) : null,
      unassigned_count: unassigned.length || null,
      selected_trailer: selected?.TRAILER_ID ?? null,
      __memo_backload_matching: memo,
    };
  }, [cfg, region, trailers.length, internal.length, external.length, visibleAssignments, internalCount, internalPct, totalNetBenefit, unassigned.length, selected, solveStats, trailersAssignedPct]);

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const lastSentRef = useRef<string>('');
  useEffect(() => {
    const json = JSON.stringify(summary);
    if (json === lastSentRef.current) return;
    lastSentRef.current = json;
    onStateChangeRef.current?.(summary);
  }, [summary]);

  // ---- deck.gl layers (bespoke, mirrors the reference dashboard) ----
  const layers = useMemo<Layer[]>(() => {
    const result: Layer[] = [];
    if (external.length) {
      result.push(new ScatterplotLayer({
        id: 'ext-offers', data: external, getPosition: (d: Offer) => [Number(d.PICKUP_LON), Number(d.PICKUP_LAT)],
        getFillColor: [200, 200, 200, 160], getLineColor: [120, 120, 120, 220],
        stroked: true, lineWidthMinPixels: 1, getRadius: 600, radiusMinPixels: 3, radiusMaxPixels: 5, pickable: true,
      }) as unknown as Layer);
    }
    if (internal.length) {
      result.push(new ScatterplotLayer({
        id: 'int-vols', data: internal, getPosition: (d: Volume) => [Number(d.PICKUP_LON), Number(d.PICKUP_LAT)],
        getFillColor: [41, 181, 232, 220], getRadius: 800, radiusMinPixels: 4, radiusMaxPixels: 6, pickable: true,
      }) as unknown as Layer);
    }
    if (trailers.length) {
      result.push(new ScatterplotLayer({
        id: 'trailers', data: trailers, getPosition: (d: Trailer) => [Number(d.DROPOFF_LON), Number(d.DROPOFF_LAT)],
        getFillColor: [22, 163, 74, 240], getLineColor: [255, 255, 255, 255],
        stroked: true, lineWidthMinPixels: 1, getRadius: 1200, radiusMinPixels: 5, radiusMaxPixels: 9, pickable: true,
      }) as unknown as Layer);
    }
    const hasSel = !!selectedAssignment;
    // The lazily fetched tour path already ends at the last task stop, so this
    // trim is normally a no-op. It stays because a geometry-bearing solve
    // response would cover the return reposition too, and that tail must not be
    // painted as if the vehicle were still carrying freight - the dashed
    // empty-leg layer owns it.
    const loadedPaths = visibleAssignments.map((a, i) => ({ a, i }))
      .filter(({ a }) => !!a.ROUTE_GEOJSON)
      .map(({ a, i }) => {
        const full = coordsFromGeoJSON(a.ROUTE_GEOJSON);
        const path = a.LAST_TASK_LON !== undefined && a.LAST_TASK_LAT !== undefined && (a.EMPTY_BACK_KM ?? 0) > 0
          ? trimPathAt(full, [a.LAST_TASK_LON, a.LAST_TASK_LAT])
          : full;
        return { idx: i, path, isSel: a.ASSIGNMENT_ID === selectedAssignment };
      });
    result.push(new PathLayer({
      id: 'loaded-routes', data: loadedPaths, getPath: (d: { path: LngLat[] }) => d.path,
      getColor: (d: { idx: number; isSel: boolean }) => { const c = ROUTE_COLORS[d.idx % ROUTE_COLORS.length]; const a = d.isSel ? 255 : (hasSel ? 80 : 110); return [c[0], c[1], c[2], a]; },
      getWidth: (d: { isSel: boolean }) => (d.isSel ? 6 : (hasSel ? 2 : 3)),
      widthUnits: 'pixels', widthMinPixels: 2, parameters: { depthTest: false }, pickable: true,
      updateTriggers: { getColor: [selectedAssignment, hasSel], getWidth: [selectedAssignment, hasSel] },
    }) as unknown as Layer);
    visibleAssignments.forEach((a, i) => {
      const isSel = a.ASSIGNMENT_ID === selectedAssignment;
      const emptyW = isSel ? 6 : (hasSel ? 2 : 4);
      const emptyAlpha = isSel ? 255 : (hasSel ? 140 : 255);
      const dashed = (id: string, data: unknown) => new GeoJsonLayer({
        id, data: data as GeoJSON.GeoJSON,
        stroked: true, getLineColor: [110, 110, 110, emptyAlpha], getDashArray: [10, 6], lineWidthMinPixels: emptyW,
        extensions: [new PathStyleExtension({ dash: true })], parameters: { depthTest: false },
      }) as unknown as Layer;
      if (a.EMPTY_GEOJSON) result.push(dashed(`empty-${i}`, a.EMPTY_GEOJSON));
      if (a.EMPTY_RETURN_GEOJSON) result.push(dashed(`empty-ret-${i}`, a.EMPTY_RETURN_GEOJSON));
    });
    if (selected && Array.isArray(selected.STOPS) && selected.STOPS.length) {
      const palette: Record<Stop['kind'], { ring: [number, number, number]; halo: [number, number, number, number] }> = {
        start: { ring: [156, 163, 175], halo: [156, 163, 175, 60] },
        pickup: { ring: [245, 158, 11], halo: [245, 158, 11, 60] },
        dropoff: { ring: [22, 163, 74], halo: [22, 163, 74, 60] },
        end: { ring: [41, 181, 232], halo: [41, 181, 232, 60] },
        break: { ring: [168, 85, 247], halo: [168, 85, 247, 60] },
      };
      const stopData = selected.STOPS.map((s, i) => ({ ...s, _idx: i + 1, _total: selected.STOPS.length }));
      const stopGroups = new Map<string, (Stop & { _idx: number; _total: number })[]>();
      for (const d of stopData) {
        const key = `${Number(d.lon).toFixed(5)},${Number(d.lat).toFixed(5)}`;
        const g = stopGroups.get(key);
        if (g) g.push(d); else stopGroups.set(key, [d]);
      }
      const stopMarkers = Array.from(stopGroups.values()).map((g) => ({ ...g[0], _label: g.map((x) => x._idx).join(','), _members: g }));
      result.push(new ScatterplotLayer({
        id: 'sel-stop-halo', data: stopMarkers, pickable: false,
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getFillColor: (d: { kind: Stop['kind'] }) => palette[d.kind].halo,
        getRadius: 160, radiusMinPixels: 16, radiusMaxPixels: 50, stroked: false, filled: true, parameters: { depthTest: false },
      }) as unknown as Layer);
      result.push(new ScatterplotLayer({
        id: 'sel-stop-marker', data: stopMarkers, pickable: true,
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getFillColor: [255, 255, 255, 240],
        getLineColor: (d: { kind: Stop['kind'] }) => { const c = palette[d.kind].ring; return [c[0], c[1], c[2], 255]; },
        getRadius: 90, radiusMinPixels: 11, radiusMaxPixels: 18, lineWidthMinPixels: 2, stroked: true, filled: true, parameters: { depthTest: false },
      }) as unknown as Layer);
      result.push(new TextLayer({
        id: 'sel-stop-number', data: stopMarkers, pickable: false,
        getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
        getText: (d: { _label: string }) => d._label,
        getColor: (d: { kind: Stop['kind'] }) => { const c = palette[d.kind].ring; return [c[0], c[1], c[2], 255]; },
        getSize: (d: { _label: string }) => (String(d._label).length > 1 ? 10 : 12), sizeUnits: 'pixels',
        fontWeight: 700, getAlignmentBaseline: 'center', getTextAnchor: 'middle', parameters: { depthTest: false },
      }) as unknown as Layer);
    }
    return result;
  }, [external, internal, trailers, visibleAssignments, selectedAssignment, selected]);

  // Agent grounding, Channel B: this page builds deck.gl layers itself, so nothing
  // publishes map state for it and the agent could not answer "what is on the map"
  // or diagnose an empty one. Derived from the compiled layers so a future layer is
  // described automatically. Gated on having loaded something, so a pre-solve page
  // publishes null instead of an all-zero map the agent would report as a finding.
  usePublishMapState(
    useMemo(
      () =>
        describeDeckLayers(layers, {
          selection: { selected_trailer: selected?.TRAILER_ID ?? null },
          ready: trailers.length > 0 || internal.length > 0 || external.length > 0,
        }),
      [layers, selected, trailers.length, internal.length, external.length],
    ),
  );

  // Fit-to coords: selected route (+empty leg) when selected, else the estate.
  const fitCoords = useMemo<LngLat[]>(() => {
    if (selected) {
      const out: LngLat[] = [
        [selected.TRAILER_DROPOFF_LON, selected.TRAILER_DROPOFF_LAT],
        [selected.PICKUP_LON, selected.PICKUP_LAT],
        [selected.DROPOFF_LON, selected.DROPOFF_LAT],
        ...coordsFromGeoJSON(selected.ROUTE_GEOJSON),
        ...coordsFromGeoJSON(selected.EMPTY_GEOJSON),
        ...coordsFromGeoJSON(selected.EMPTY_RETURN_GEOJSON),
      ];
      return out.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    }
    const out: LngLat[] = [];
    for (const t of trailers) if (Number.isFinite(Number(t.DROPOFF_LON))) out.push([Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)]);
    for (const i of internal) if (Number.isFinite(Number(i.PICKUP_LON))) out.push([Number(i.PICKUP_LON), Number(i.PICKUP_LAT)]);
    for (const e of external) if (Number.isFinite(Number(e.PICKUP_LON))) out.push([Number(e.PICKUP_LON), Number(e.PICKUP_LAT)]);
    return out;
  }, [selected, trailers, internal, external]);

  const getTooltip = useCallback((info: { object?: Record<string, unknown> }) => {
    const object = info?.object;
    if (!object) return null;
    const style = { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' };
    if (object._idx && ['start', 'pickup', 'dropoff', 'end', 'break'].includes(object.kind as string)) {
      const labelMap: Record<string, string> = { start: 'START', pickup: 'PICKUP', dropoff: 'DROPOFF', end: 'END', break: 'BREAK' };
      const members = (Array.isArray(object._members) && object._members.length ? object._members : [object]) as Record<string, unknown>[];
      const blocks = members.map((m) => {
        const lines: string[] = [`<b>#${escapeHtml(m._idx)} of ${escapeHtml(m._total)} - ${escapeHtml(labelMap[m.kind as string])}</b>`];
        if (m.city) lines.push(escapeHtml(m.city));
        if (m.label && m.label !== m.city) lines.push(escapeHtml(m.label));
        if (m.product) { const wt = m.weightKg ? ` - ${(Number(m.weightKg) / 1000).toFixed(1)} t` : ''; lines.push(`${escapeHtml(m.product)}${wt}`); }
        if (m.kind === 'break' && m.serviceSec) lines.push(`Driver break - ${Math.round(Number(m.serviceSec) / 60)} min`);
        if (m.waitSec) lines.push(`Wait ${Math.round(Number(m.waitSec) / 60)} min`);
        return lines.filter(Boolean).join('<br/>');
      });
      return { html: blocks.join('<hr style="border:none;border-top:1px solid #444;margin:4px 0"/>'), style };
    }
    if (object.TRAILER_ID) return { html: `<b>${escapeHtml(object.TRAILER_ID)}</b><br/>Idle in: ${escapeHtml(object.DROPOFF_CITY)}<br/>Home: ${escapeHtml(object.HOME_DEPOT)}<br/>HAZMAT: ${object.HAZMAT_CERT ? 'yes' : 'no'}`, style };
    if (object.OFFER_ID) return { html: `<b>${escapeHtml(object.SOURCE)} ${escapeHtml(object.OFFER_ID)}</b><br/>${escapeHtml(object.PICKUP_CITY)} -> ${escapeHtml(object.DROPOFF_CITY)}<br/>${escapeHtml(object.WEIGHT_KG)} kg - ${escapeHtml(object.PRODUCT)}<br/>$${escapeHtml(object.PRICE_USD)}`, style };
    if (object.ID) return { html: `<b>Internal ${escapeHtml(object.ID)}</b><br/>${escapeHtml(object.PICKUP_CITY)} -> ${escapeHtml(object.DROPOFF_CITY)}<br/>${escapeHtml(object.WEIGHT_KG)} kg - ${escapeHtml(object.PRODUCT)}`, style };
    return null;
  }, []);

  // ---- styles ----
  const sectionHdr: React.CSSProperties = { marginBottom: 6, fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #6b7280)', letterSpacing: 0.5 };
  const sectionBox: React.CSSProperties = { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12, padding: '8px 12px', border: '1px solid var(--border-default, #e5e7eb)', borderRadius: 6 };
  const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--text-secondary, #6b7280)', marginBottom: 2, display: 'block' };
  const sliderBlock: React.CSSProperties = { minWidth: 170 };
  const numBlock: React.CSSProperties = { minWidth: 130 };
  const inputStyle: React.CSSProperties = { width: '100%', fontSize: 13, padding: '4px 6px', borderRadius: 4, border: '1px solid var(--border-default, #e5e7eb)' };
  const kpiCard: React.CSSProperties = { padding: 12, borderRadius: 8, border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)' };
  const kpiLabel: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase', marginBottom: 2 };
  const btnPrimary = (enabled: boolean, bg = 'var(--surface-accent-strong, #2563eb)'): React.CSSProperties => ({ padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 6, border: 'none', cursor: enabled ? 'pointer' : 'not-allowed', backgroundColor: bg, color: '#fff', opacity: enabled ? 1 : 0.6, minWidth: 140 });

  const budget = (() => {
    const used = 2 * maxVehicles + 2 * maxInternal + 2 * maxExternal;
    const overBudget = used > BM_MAX_MATRIX_LOCATIONS;
    const nearBudget = !overBudget && used >= Math.round(BM_MAX_MATRIX_LOCATIONS * 0.8);
    const counterColor = overBudget ? '#dc2626' : nearBudget ? '#d97706' : 'var(--text-secondary, #6b7280)';
    const preview = overBudget ? clampPayload(maxVehicles, maxInternal, maxExternal, BM_MAX_MATRIX_LOCATIONS) : null;
    return { used, overBudget, nearBudget, counterColor, preview };
  })();

  const slider = (lbl: string, tip: string, val: number, set: (n: number) => void, min: number, max: number, step = 1, suffix = '', prefix = '') => (
    <div style={sliderBlock}>
      <label style={labelStyle}>{lbl}: {prefix}{val}{suffix}<InfoTip text={tip} /></label>
      <input type="range" min={min} max={max} step={step} value={val} onChange={(e) => set(Number(e.target.value))} style={{ width: '100%' }} />
    </div>
  );
  const numInput = (lbl: string, tip: string, val: number, set: (n: number) => void, step: number) => (
    <div style={numBlock}>
      <label style={labelStyle}>{lbl}<InfoTip text={tip} /></label>
      <input type="number" min={0} step={step} value={val} onChange={(e) => set(Number(e.target.value) || 0)} style={inputStyle} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: 16, height: '100%', overflow: 'auto' }}>
      <h2 style={{ fontSize: 20, margin: '0 0 4px' }}>Backload Matching Engine</h2>
      <p style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)', margin: '0 0 12px' }}>
        Fleet-wide VRP solve with VROOM + ORS - every visible knob maps 1:1 to a solver field
        {cfg ? ` (${cfg.vehicleType} / ${cfg.region})` : ''}.
      </p>

      {seedHint && (
        <div style={{ background: 'rgba(245,158,11,0.12)', color: '#a16207', border: '1px solid rgba(245,158,11,0.4)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span>{seedHint}</span>
          <button type="button" onClick={() => refetch()} style={{ padding: '4px 10px', fontSize: 12, borderRadius: 4, border: '1px solid rgba(245,158,11,0.4)', background: 'transparent', color: '#a16207', cursor: 'pointer', whiteSpace: 'nowrap' }}>Refresh</button>
        </div>
      )}

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 12 }}>
        <div style={kpiCard}><div style={kpiLabel}>Trailers</div><div style={{ fontSize: 22, fontWeight: 700 }}>{trailers.length}</div></div>
        <div style={kpiCard}><div style={kpiLabel}>Internal volumes</div><div style={{ fontSize: 22, fontWeight: 700 }}>{internal.length}</div></div>
        <div style={kpiCard}><div style={kpiLabel}>External offers</div><div style={{ fontSize: 22, fontWeight: 700 }}>{external.length}</div></div>
        <div style={kpiCard}>
          <div style={kpiLabel}>% dispatched assigned</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{trailersAssignedPct}%</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)' }}>
            {visibleAssignments.length} of {trailersConsidered} {solveStats ? 'sent to solver' : 'idle'}
          </div>
        </div>
        <div style={kpiCard}><div style={kpiLabel}>% internal coverage</div><div style={{ fontSize: 22, fontWeight: 700 }}>{internalPct}%</div></div>
        <div style={kpiCard}><div style={kpiLabel}>Net benefit ($)</div><div style={{ fontSize: 22, fontWeight: 700 }}>${totalNetBenefit.toLocaleString()}</div></div>
      </div>

      {/* PAYLOAD SIZE */}
      <div style={sectionHdr}>PAYLOAD SIZE (matrix budget)</div>
      <div style={sectionBox}>
        {slider('Max trailers', `How many idle trailers (closest to shipments) get sent to the solver. Auto-clamped on Solve so the precomputed ORS matrix stays under ${BM_MAX_MATRIX_LOCATIONS} unique locations.`, maxVehicles, setMaxVehicles, BM_VEHICLES_MIN, BM_VEHICLES_MAX)}
        {slider('Max internal volumes', 'How many internal (own-fleet) shipments enter the solver, sorted by proximity to the nearest idle trailer.', maxInternal, setMaxInternal, BM_INTERNAL_MIN, BM_INTERNAL_MAX)}
        {slider('Max external offers', 'How many external freight-exchange offers enter the solver, sorted by proximity to the nearest idle trailer.', maxExternal, setMaxExternal, BM_EXTERNAL_MIN, BM_EXTERNAL_MAX)}
        <div style={{ minWidth: 220, fontSize: 12, color: budget.counterColor }}>
          <div style={{ fontWeight: 600 }}>Locations used: {budget.used} / {BM_MAX_MATRIX_LOCATIONS}</div>
          {budget.overBudget && budget.preview && (<div style={{ fontSize: 11 }}>Will clamp on Solve to {budget.preview.v}/{budget.preview.i}/{budget.preview.e}</div>)}
          {!budget.overBudget && budget.nearBudget && (<div style={{ fontSize: 11 }}>Approaching matrix budget</div>)}
        </div>
      </div>

      {/* SOLVER */}
      <div style={sectionHdr}>SOLVER (VROOM-native)</div>
      <div style={sectionBox}>
        {slider('Max stops per trailer', 'How many shipments one trailer may collect on a single tour. 1 = pure backload; higher = consolidation tours.\n\nVROOM field: vehicle.max_tasks', maxStops, setMaxStops, 1, 6)}
        {slider('Detour budget', "Extra hours allowed on top of each trailer's empty drive home. Adds linearly per vehicle.\n\nVROOM field: vehicle.max_travel_time", detourSlackHrs, setDetourSlackHrs, 0, 12, 1, ' h', '+')}
        {slider('Allowed deviation', "Distance cap as a percentage above each trailer's empty drive home. 200% = tour may be up to 3x the empty distance.\n\nVROOM field: vehicle.max_distance", deviationPct, setDeviationPct, 0, 500, 10, '%', '+')}
        {slider('Internal-first', 'Bias toward internal volumes vs external offers. 100 = always internal first, 50 = equal, 0 = always external first.\n\nVROOM field: job.priority', internalFirstWeight, setInternalFirstWeight, 0, 100)}
        {slider('Window slack', 'Widens every pickup/delivery time window by this many hours so the solver has more flexibility.\n\nVROOM field: job.time_windows', windowSlackHrs, setWindowSlackHrs, 0, 12, 1, ' h', '\u00b1')}
        <div style={{ minWidth: 220 }}>
          <label style={labelStyle}>Trailer end<InfoTip text="Where the trailer must finish: Home depot, a Shared destination you pick, or Open-ended (no return).\n\nVROOM field: vehicle.end" /></label>
          <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="radio" name="endMode" checked={endMode === 'home'} onChange={() => setEndMode('home')} />Home</label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="radio" name="endMode" checked={endMode === 'shared'} onChange={() => setEndMode('shared')} />Shared</label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><input type="radio" name="endMode" checked={endMode === 'open'} onChange={() => setEndMode('open')} />Open</label>
          </div>
          {endMode === 'shared' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input type="number" step="0.0001" value={sharedDestLon ?? ''} onChange={(e) => { setSharedDestUserEdited(true); setSharedDestLon(e.target.value === '' ? null : Number(e.target.value)); }} placeholder="lon" style={{ ...inputStyle, width: '50%', fontSize: 11 }} />
              <input type="number" step="0.0001" value={sharedDestLat ?? ''} onChange={(e) => { setSharedDestUserEdited(true); setSharedDestLat(e.target.value === '' ? null : Number(e.target.value)); }} placeholder="lat" style={{ ...inputStyle, width: '50%', fontSize: 11 }} />
            </div>
          )}
        </div>
      </div>

      {/* ECONOMICS */}
      <div style={sectionHdr}>ECONOMICS ($)</div>
      <div style={sectionBox}>
        {numInput('Cost $/h', 'Driver hour cost. Folded into the solver per-km cost via the class average speed.', costPerHourUsd, setCostPerHourUsd, 1)}
        {numInput('Cost $/km', 'Distance cost (fuel, wear). Combined with $/h to form vehicle.costs.per_km.', costPerKmUsd, setCostPerKmUsd, 0.05)}
        {numInput('Dispatch ($)', 'Fixed cost paid every time a trailer is dispatched.\n\nVROOM field: vehicle.costs.fixed', fixedDispatchUsd, setFixedDispatchUsd, 5)}
        {numInput('$/delivery', 'Per-stop overhead added in the post-solve net-benefit calculation only.', costPerDeliveryUsd, setCostPerDeliveryUsd, 1)}
        {numInput('Internal $/loaded-km', 'Synthetic revenue rate for internal volumes (external offers carry their real price).', internalRatePerKm, setInternalRatePerKm, 0.05)}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={hideUnprofitable} onChange={(e) => setHideUnprofitable(e.target.checked)} />
          Hide unprofitable
        </label>
        <button onClick={solve} disabled={solving || !trailers.length || !vehicleClass} style={btnPrimary(!solving && !!trailers.length && !!vehicleClass, '#16a34a')} title={!vehicleClass ? (vehicleClassError || 'Vehicle class profile not loaded') : ''}>
          {solving ? 'Solving...' : 'Solve Backloads'}
        </button>
        {solving && (
          <button type="button" onClick={() => solveAbortRef.current?.abort()} style={{ minWidth: 100, padding: '6px 12px', fontSize: 12, borderRadius: 4, border: '1px solid rgba(239,68,68,0.6)', background: '#fff', color: '#b91c1c', cursor: 'pointer' }}>Cancel</button>
        )}
        <button onClick={confirmPlan} disabled={confirming || !visibleAssignments.length} style={btnPrimary(!confirming && !!visibleAssignments.length)}>
          {confirming ? 'Saving...' : 'Confirm Plan'}
        </button>
      </div>

      {/* ENGINE FEATURES (collapsible) */}
      <div style={{ marginBottom: 12, border: '1px solid var(--border-default, #e5e7eb)', borderRadius: 6 }}>
        <button type="button" onClick={() => setShowAdvanced((s) => !s)} style={{ width: '100%', padding: '8px 12px', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #6b7280)', letterSpacing: 0.5 }}>
          <span>ENGINE FEATURES (VROOM + ORS) - {showAdvanced ? 'hide' : 'show'}</span>
          <span>{showAdvanced ? '\u25b4' : '\u25be'}</span>
        </button>
        {showAdvanced && (
          <div style={{ padding: '8px 12px 12px', borderTop: '1px solid var(--border-default, #e5e7eb)', display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12 }}>
            <div style={{ minWidth: 220 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={enforceDriverBreak} onChange={(e) => setEnforceDriverBreak(e.target.checked)} />
                <b>Driver break</b><InfoTip text="Inserts a mandatory rest stop into the tour (default 45 min after 4.5 h).\n\nVROOM field: vehicle.breaks" />
              </label>
              {enforceDriverBreak && (
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  After {breakAfterHrs} h:
                  <input type="range" min={2} max={6} step={0.5} value={breakAfterHrs} onChange={(e) => setBreakAfterHrs(Number(e.target.value))} style={{ width: '60%', marginLeft: 6 }} />
                  <br />{breakLengthMin} min:
                  <input type="range" min={15} max={90} step={5} value={breakLengthMin} onChange={(e) => setBreakLengthMin(Number(e.target.value))} style={{ width: '60%', marginLeft: 6 }} />
                </div>
              )}
            </div>
            <div style={{ minWidth: 200 }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={enforceShift} onChange={(e) => setEnforceShift(e.target.checked)} />
                <b>Shift / hours-of-service</b><InfoTip text="Forces the whole tour to fit inside a single driver shift.\n\nVROOM field: vehicle.time_window" />
              </label>
              {enforceShift && (
                <div style={{ marginTop: 4, fontSize: 11 }}>
                  Shift = {shiftLengthHrs} h
                  <input type="range" min={4} max={13} value={shiftLengthHrs} onChange={(e) => setShiftLengthHrs(Number(e.target.value))} style={{ width: '70%', marginLeft: 6 }} />
                </div>
              )}
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={useMultiDimCapacity} onChange={(e) => setUseMultiDimCapacity(e.target.checked)} />
              <b>Multi-dim capacity</b><InfoTip text="Adds pallets and m3 alongside kg; the solver enforces all three simultaneously.\n\nVROOM fields: vehicle.capacity[] / shipment.amount[]" />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={useMultiWindow} onChange={(e) => setUseMultiWindow(e.target.checked)} />
              <b>Multi-window pickups</b><InfoTip text="Adds a synthetic second pickup window at +8 h.\n\nVROOM field: pickup.time_windows[[a,b],[c,d]]" />
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={showWaitTimes} onChange={(e) => setShowWaitTimes(e.target.checked)} />
              <b>Show wait times</b><InfoTip text="Display a wait chip per stop when the trailer arrives early and idles before the window opens." />
            </label>
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginBottom: 12, padding: '8px 12px', border: '1px solid var(--border-default, #e5e7eb)', borderRadius: 6, fontSize: 11, color: 'var(--text-secondary, #6b7280)', background: 'rgba(0,0,0,0.02)' }}>
        <b style={{ color: 'var(--text-primary, #111827)' }}>Legend</b>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(200,200,200)', border: '1px solid rgb(120,120,120)', display: 'inline-block' }} />External offer</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(41,181,232)', display: 'inline-block' }} />Internal volume</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: 'rgb(22,163,74)', border: '1px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.15)', display: 'inline-block' }} />Idle trailer</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 24, height: 0, borderTop: '3px dashed rgb(110,110,110)', display: 'inline-block' }} />Empty leg (out + return)</span>
      </div>

      {confirmMsg && (<div style={{ marginBottom: 12, fontSize: 13, padding: '8px 12px', background: 'rgba(22,163,74,0.10)', border: '1px solid rgba(22,163,74,0.4)', borderRadius: 4, color: '#065f46' }}>{confirmMsg}</div>)}
      {solverLog && (<div style={{ marginBottom: 12, fontSize: 11, fontFamily: 'monospace', padding: '6px 10px', background: 'rgba(0,0,0,0.04)', borderRadius: 4, color: 'var(--text-secondary, #6b7280)' }}>{solverLog}</div>)}
      {vehicleClassError && (<div style={{ marginBottom: 12, fontSize: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.45)', borderRadius: 4, color: '#b91c1c' }}><b>Vehicle class issue.</b> {vehicleClassError}</div>)}
      {suspended && (<div style={{ marginBottom: 12 }}><RoutingSuspendedNotice info={suspended} onRetry={solve} compact /></div>)}
      {solveError && (<div style={{ marginBottom: 12, fontSize: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.45)', borderRadius: 4, color: '#b91c1c' }}><b>Solve returned no assignments.</b> {solveError}</div>)}

      {/* Map + assignments */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 12 }}>
        <div style={{ height: 560, borderRadius: 8, border: '1px solid var(--border-default, #e5e7eb)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
          {solving && (
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: '#fff', zIndex: 10, fontSize: 14 }}>
              <div>{solverLog || 'Calling OPTIMIZATION...'}</div>
              <button type="button" onClick={() => solveAbortRef.current?.abort()} style={{ padding: '6px 14px', fontSize: 12, borderRadius: 4, border: '1px solid rgba(255,255,255,0.6)', background: 'transparent', color: '#fff', cursor: 'pointer' }}>Cancel</button>
            </div>
          )}
          <MapView layers={layers} fitTo={{ coords: fitCoords, focusKey: selectedAssignment ? `sel:${selectedAssignment}` : '', regionKey: cfg?.region, regionCoords }} getTooltip={getTooltip} onRecenterReady={(fn) => { recenterRef.current = fn; }} />
          <button type="button" onClick={() => recenterRef.current?.()} style={{ position: 'absolute', top: 12, right: 12, zIndex: 5, padding: '6px 10px', fontSize: 12, borderRadius: 4, border: '1px solid var(--border-default, #e5e7eb)', background: 'rgba(255,255,255,0.92)', color: 'var(--text-primary, #111827)', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}>Recenter</button>
          {selected && (
            <button type="button" onClick={() => stopsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} style={{ position: 'absolute', top: 12, right: 108, zIndex: 5, padding: '6px 10px', fontSize: 12, borderRadius: 4, border: '1px solid var(--border-default, #e5e7eb)', background: 'rgba(255,255,255,0.92)', color: 'var(--text-primary, #111827)', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}>Stops &darr;</button>
          )}
        </div>
        <AssignmentList assignments={visibleAssignments} unassigned={unassigned} selectedAssignment={selectedAssignment} onSelect={(id) => setSelectedAssignment(selectedAssignment === id ? null : id)} rationale={rationale} rationaleLoading={rationaleLoading} onAskRationale={askRationale} />
      </div>

      {selected && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-secondary, #6b7280)' }}>
          Selected trailer: <b>{selected.TRAILER_ID}</b> &middot; duration {selected.SCORE.toFixed(0)}s &middot; empty {Math.round(selected.EMPTY_KM)} km &middot; net ${Math.round(selected.NET_BENEFIT_USD || 0)}
        </div>
      )}

      <div ref={stopsPanelRef}>
        <StopsPanel assignment={selected} showWaitTimes={showWaitTimes} />
      </div>

      <DecisionsAudit rows={auditRows} onRefresh={loadAudit} />
    </div>
  );
}
