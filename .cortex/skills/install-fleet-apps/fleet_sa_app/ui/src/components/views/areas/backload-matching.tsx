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
import { describeDeckLayers, usePublishMapState, joinBounded, TRIP_MEMO_MAX_LEN } from '@/lib/agent-memo';
import { escapeHtml } from '@/lib/html';
import { formatNumber } from '@/lib/format-number';
import { postSolve } from '@/lib/solve-client';
import { collectAgentSolve, proposalsToAssignments } from '@/lib/backload-rehydrate';
import type { ViewProps } from '@/lib/types';
import AssignmentList from './backload-matching/AssignmentList';
import StopsPanel from './backload-matching/StopsPanel';
import DecisionsAudit from './backload-matching/DecisionsAudit';
import InfoTip from './backload-matching/InfoTip';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';
import { isSuspendedBody, isRoutingSuspendedError, type SuspendedInfo } from '@/lib/routing-suspend';
import {
  BM, COST_SCALE, USD_PER_LOADED_KM, KMH_DEFAULT, ROUTE_COLORS,
  sfRead, sqlLiteral, haversineKm, synthPallets, synthVolumeM3,
  fetchVehicleClass, computeEmptyLegBaselines, fetchEmptyLeg, fetchTourPath, trimPathAt,
  findUnroutablePoints, coordKey, describeTourChain, realPlace,
  type Trailer, type Volume, type Offer, type Assignment, type Stop,
  baselineEndpointFor, fetchBaselineLeg, straightLineGeoJSON,
  type VehicleClass, type EmptyLegBaseline, type UnroutableProbeStats,
  type EndMode, type BaselineGeom,
} from './backload-matching/helpers';

// Cached ORS empty-leg result (geometry + real road km) keyed by
// `<trailer>|<offer>` for the outbound leg and `<trailer>|<offer>|ret` for the
// return reposition.
type EmptyLegCacheEntry = { geo: unknown; km: number | null };
// Cached loaded-tour result: geometry plus the road km that produced it. `km` is
// null when fetchTourPath fell back to a straight line.
type TourCacheEntry = { geo: unknown; km: number | null };

/**
 * Upgrade a COLLECTED plan's loaded distance to the road distance just measured.
 *
 * Only for rehydrated rows. On the solve path LOADED_KM and TOUR_KM come from
 * VROOM, which routed the whole tour under the solver's own constraints, and
 * overwriting those with a fresh DIRECTIONS number would make the card disagree
 * with the plan that was actually optimised.
 *
 * A collected plan has neither: the procedure reports great-circle km. Leaving it
 * put a straight-line 1,352 km beside a road polyline on the same card, under a
 * note that promised road distances.
 */
function refineLoaded(a: Assignment, km: number | null): void {
  if (!a.REHYDRATED || km === null || !Number.isFinite(km) || km <= 0) return;
  a.LOADED_KM = km;
  a.TOUR_KM = km;
}

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

function clampPayload(v: number, i: number, e: number, budget: number): { v: number; i: number; e: number; clamped: boolean } {
  const used = 2 * v + 2 * i + 2 * e;
  if (used <= budget) return { v, i, e, clamped: false };
  const scale = budget / used;
  return { v: Math.max(1, Math.floor(v * scale)), i: Math.max(0, Math.floor(i * scale)), e: Math.max(0, Math.floor(e * scale)), clamped: true };
}

export function BackloadMatchingView({ viewState, onStateChange }: Partial<ViewProps> = {}) {
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
  const tourCacheRef = useRef<Map<string, TourCacheEntry>>(new Map());
  const [unassigned, setUnassigned] = useState<{ id: number; reason?: string }[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<string | null>(null);
  // Selected VEHICLE, independent of any assignment. Set by clicking a trailer
  // dot on the map and kept in sync with selectedAssignment below. This exists
  // separately because the baseline (no-backload) line must be answerable BEFORE
  // a solve, when there are no assignments at all to select.
  const [selectedTrailer, setSelectedTrailer] = useState<string | null>(null);
  // Baseline reposition line for selectedTrailer, fetched lazily. Cache key is
  // `<trailer>|<endLon>,<endLat>`: the endpoint MUST be in the key because
  // endMode and the shared destination are editable at runtime, and a
  // trailer-only key would keep serving the line drawn to the old endpoint.
  const baselineCacheRef = useRef<Map<string, BaselineGeom>>(new Map());
  const [baseline, setBaseline] = useState<BaselineGeom | null>(null);
  const [rationale, setRationale] = useState<Record<string, string>>({});
  const [rationaleLoading, setRationaleLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null);
  // Set when the plan on screen was collected from a solve the AGENT ran, rather
  // than solved here. Surfaced so a dispatcher is never unsure whose numbers
  // these are, and cleared the moment this page solves for itself.
  const [rehydrateNote, setRehydrateNote] = useState<string | null>(null);
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
      // The APP SELECTION is authoritative; VW_CONFIG is a default hint only.
      // CONFIG holds one row and is writable at runtime (the /api/region promote
      // path, and the ops verb set_active_context which an agent can call), so
      // trusting it over the selection makes the same page answer differently at
      // different times - and, worse, mixes regions when the two disagree.
      const cfgRegion = String(region ?? c?.REGION ?? 'SanFrancisco');

      // MULTI-REGION contract views: region MUST be bound here. Without it the
      // pool spans every loaded region and the unsorted `.slice(0, maxVehicles)`
      // below feeds off-graph coordinates to the region's routing engine, which
      // fails the matrix pre-compute with ORS 6010 ("out of bounds").
      const scope = { region: cfgRegion };
      const [tRows, iRows, oRows] = await Promise.all([
        sfRead(`SELECT * FROM ${BM}.VW_TRAILERS WHERE REGION = :region`, { params: scope }),
        sfRead(`SELECT * FROM ${BM}.VW_INTERNAL_VOLUMES WHERE REGION = :region`, { params: scope }),
        sfRead(`SELECT * FROM ${BM}.VW_EXTERNAL_OFFERS WHERE REGION = :region`, { params: scope }),
      ]);

      // Vehicle type for the region we actually loaded. DIM_DATASETS allows one
      // ACTIVE dataset per (REGION, VEHICLE_TYPE), so CONFIG's vehicle type is
      // only meaningful when CONFIG's region is the region on screen; otherwise
      // take it from the fleet itself (VW_TRAILERS.CURRENT_LOAD is VEHICLE_TYPE).
      // Filtering trailers by it keeps a future mixed-vehicle region honest -
      // one class profile cannot describe two vehicle types.
      let vehicleType = String(c?.VEHICLE_TYPE ?? 'hgv');
      if (String(c?.REGION ?? '') !== cfgRegion) {
        const counts = new Map<string, number>();
        for (const r of tRows as unknown as Trailer[]) {
          const vt = String(r.CURRENT_LOAD ?? '').trim();
          if (vt) counts.set(vt, (counts.get(vt) ?? 0) + 1);
        }
        const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (dominant) vehicleType = dominant;
      }
      setCfg({ vehicleType, region: cfgRegion });

      // Defensive dedupe (guards against upstream view regressions feeding VROOM
      // duplicate vehicles / shipments -> visually-identical duplicate cards).
      // Trailers are additionally narrowed to the resolved vehicle type: the
      // single VehicleClass profile below (payload, speed, ORS profile) describes
      // exactly one type, so mixing types would cost and route the pool wrongly.
      const seenT = new Set<string>();
      const tDeduped = (tRows as unknown as Trailer[]).filter((r) => {
        const vt = String(r.CURRENT_LOAD ?? '').trim();
        if (vt && vt !== vehicleType) return false;
        const id = String(r.TRAILER_ID);
        if (seenT.has(id)) return false; seenT.add(id); return true;
      });
      // Internal volumes are deduped in SQL now (same lane, same weight), before
      // the pool bound is applied, so there is nothing left to drop here. Doing
      // it in the browser meant the "Internal volumes" tile reported a smaller
      // number than the pool the solver actually received - measured 4,979 on
      // screen against 5,000 rows - and no SQL consumer got the benefit.
      const seenO = new Set<string>();
      const oDeduped = (oRows as unknown as Offer[]).filter((o) => {
        const k = String(o.OFFER_ID);
        if (seenO.has(k)) return false; seenO.add(k); return true;
      });
      setTrailers(tDeduped);
      setInternal(iRows as unknown as Volume[]);
      setExternal(oDeduped);
      // A data reload invalidates the previous solve: drop the results and the
      // dispatch stats together so the KPI denominator can never be paired with
      // assignments from a different preset / region.
      setAssignments([]); setUnassigned([]); setSelectedAssignment(null);
      autoSelectedForRef.current = null; retriedGeomRef.current.clear();
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

      if (!tDeduped.length || !iRows.length || !oDeduped.length) {
        setSeedHint(`Tables are empty for the active preset (${vehicleType} / ${cfgRegion}) - trailers: ${tDeduped.length}, internal: ${iRows.length}, external: ${oDeduped.length}. Run a Data Studio job for this preset to populate the freight data.`);
      } else {
        setSeedHint(null);
      }
    } catch (e) {
      // A suspended engine reaches here when one of the DATA reads (not the
      // solve) is the first thing to touch live routing.
      if (isRoutingSuspendedError(e)) { setSuspended(e.info); return; }
      setSeedHint(e instanceof Error ? e.message : 'Failed to load backload data');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region]);

  useEffect(() => { refetch(); }, [refetch]);

  // -----------------------------------------------------------------
  // Geometry enrichment - the ONLY producer of the polylines the map draws.
  //
  // Lazily fetch the three polylines a tour needs through the live routing seam:
  // the loaded path (first pickup -> last task stop), and both empty legs -
  // outbound (idle location -> first pickup) and return (last task stop -> tour
  // end). The loaded path is fetched here rather than taken from the solve
  // response because the solve runs with VROOM geometry disabled to stay under
  // the 20MB _OPTIMIZATION_RAW cap. The real road distance that comes back
  // replaces the haversine seed for EMPTY_OUT_KM / EMPTY_BACK_KM, so EMPTY_KM,
  // SAVED_KM, and DETOUR_KM all end up in the same distance system as TOUR_KM.
  //
  // This is a standalone callback, not inline in `solve`, because a plan
  // collected from an agent solve needs exactly the same pass. While it lived
  // inside `solve` a rehydrated plan rendered its stops and its numbers but no
  // route line at all - nothing threw, the assignment list looked complete, and
  // only the map was wrong.
  // -----------------------------------------------------------------
  // Assignment ids whose geometry fetch has already been claimed, so the
  // enrichment effect cannot loop on the state update it causes.
  const enrichedKeysRef = useRef<Set<string>>(new Set());

  // Plan (set of assignment ids) the top card was last auto-selected for. See
  // the auto-select effect below. Reset to null wherever the plan is cleared, so
  // a re-solve that happens to place the same assignments still auto-selects.
  const autoSelectedForRef = useRef<string | null>(null);

  const enrichGeometry = useCallback(async (
    list: Assignment[], profile: string, regionName: string,
  ): Promise<void> => {
    await Promise.all(list.map(async (a) => {
      const outKey = `${a.TRAILER_ID}|${a.OFFER_ID}`;
      const retKey = `${outKey}|ret`;
      const tourKey = `${outKey}|tour`;

      const cachedTour = tourCacheRef.current.get(tourKey);
      if (cachedTour) {
        a.ROUTE_GEOJSON = cachedTour.geo;
        refineLoaded(a, cachedTour.km);
      } else {
        const tour = await fetchTourPath(profile, a.STOPS, regionName);
        if (tour) {
          tourCacheRef.current.set(tourKey, tour);
          a.ROUTE_GEOJSON = tour.geo;
          refineLoaded(a, tour.km);
        }
      }
      const cachedOut = emptyLegCacheRef.current.get(outKey) as EmptyLegCacheEntry | undefined;
      if (cachedOut) {
        a.EMPTY_GEOJSON = cachedOut.geo;
        if (cachedOut.km !== null) a.EMPTY_OUT_KM = cachedOut.km;
      } else {
        const leg = await fetchEmptyLeg(profile, [a.TRAILER_DROPOFF_LON, a.TRAILER_DROPOFF_LAT], [a.PICKUP_LON, a.PICKUP_LAT], regionName);
        if (leg) {
          emptyLegCacheRef.current.set(outKey, leg);
          a.EMPTY_GEOJSON = leg.geo;
          if (leg.km !== null) a.EMPTY_OUT_KM = leg.km;
        } else {
          // DIRECTIONS refused this pair (transient seam error, unroutable, or
          // over the waypoint cap). Draw the straight link rather than nothing:
          // an absent dashed leg is indistinguishable from a plan that has no
          // deadhead. NOT cached, so a later selection retries the road call,
          // and no km is taken from it - EMPTY_OUT_KM keeps the solver's figure.
          a.EMPTY_GEOJSON = straightLineGeoJSON(
            [a.TRAILER_DROPOFF_LON, a.TRAILER_DROPOFF_LAT], [a.PICKUP_LON, a.PICKUP_LAT],
          ) ?? undefined;
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
            regionName,
          );
          if (leg) {
            emptyLegCacheRef.current.set(retKey, leg);
            a.EMPTY_RETURN_GEOJSON = leg.geo;
            if (leg.km !== null) a.EMPTY_BACK_KM = leg.km;
          } else {
            // Same fallback as the outbound leg above, same reasoning.
            a.EMPTY_RETURN_GEOJSON = straightLineGeoJSON(
              [a.LAST_TASK_LON as number, a.LAST_TASK_LAT as number],
              [a.END_LON as number, a.END_LAT as number],
            ) ?? undefined;
          }
        }
      }

      // Only re-derive the deadhead total from its legs when at least one leg is
      // actually known. A rehydrated plan carries the procedure's own EMPTY_KM
      // and no per-leg split, so summing two undefined legs would overwrite a
      // real figure with 0 whenever DIRECTIONS is unavailable.
      if (a.EMPTY_OUT_KM !== undefined || a.EMPTY_BACK_KM !== undefined) {
        a.EMPTY_KM = (a.EMPTY_OUT_KM ?? 0) + (a.EMPTY_BACK_KM ?? 0);
      }
      if (a.BASELINE_EMPTY_KM !== undefined && a.BASELINE_SOURCE !== 'fixed-open') {
        a.SAVED_KM = Math.max(0, a.BASELINE_EMPTY_KM - a.EMPTY_KM);
      }
    }));
  }, []);

  // -----------------------------------------------------------------
  // Rehydrate a plan the agent already solved.
  //
  // `solve_key` arrives in viewState when the agent navigates here after running
  // backload_solve (show_view with selection="solve_key=..."). Collecting it puts
  // the agent's OWN plan on screen; solving again would run a second, different
  // job and could contradict the numbers the agent just quoted in chat.
  //
  // Waits for the vehicle pool, because a proposal is matched to a vehicle by
  // TRAILER_ID and an empty pool would silently drop every row.
  // -----------------------------------------------------------------
  const solveKeyParam = typeof viewState?.solve_key === 'string' ? viewState.solve_key : null;
  const rehydratedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!solveKeyParam || !trailers.length) return;
    // Once per key: this effect depends on the pool, which changes as data
    // arrives, and re-collecting would keep resetting the dispatcher's selection.
    if (rehydratedKeyRef.current === solveKeyParam) return;
    let cancelled = false;
    const ac = new AbortController();

    (async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (cancelled) return;
        const out = await collectAgentSolve(solveKeyParam, ac.signal);
        if (cancelled) return;

        if (out.state === 'pending') {
          setRehydrateNote('The agent\u2019s solve is still running. Collecting it...');
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        // Terminal in every remaining case: mark the key done so a dependency
        // change cannot restart the poll loop.
        rehydratedKeyRef.current = solveKeyParam;

        if (out.state === 'expired') {
          setRehydrateNote(
            'That plan is no longer stored, so it cannot be shown. Press Solve Backloads to build a new one.',
          );
          return;
        }
        if (out.state === 'failed') {
          setRehydrateNote(`The agent\u2019s plan could not be collected: ${out.error}. Press Solve Backloads to build a new one.`);
          return;
        }

        const proposals = Array.isArray(out.solve.proposals) ? out.solve.proposals : [];
        if (!proposals.length) {
          setRehydrateNote(
            'The agent\u2019s solve produced no assignments' +
            (out.solve.note ? `: ${out.solve.note}` : '.'),
          );
          return;
        }
        const { assignments: rebuilt, skipped } = proposalsToAssignments(proposals, trailers);
        if (!rebuilt.length) {
          setRehydrateNote(
            'The agent solved over a different set of vehicles, so none of its assignments apply to the ' +
            'vehicles shown here. Press Solve Backloads to plan this pool.',
          );
          return;
        }
        // These are fresh objects with no polylines, so release any claim a
        // previous collection made on the same assignment ids.
        enrichedKeysRef.current.clear();
        setAssignments(rebuilt as unknown as Assignment[]);
        setUnassigned([]);
        setSelectedAssignment(rebuilt[0]?.ASSIGNMENT_ID ?? null);
        const strat = out.solve.strategy ? ` (${out.solve.strategy})` : '';
        // Say only what the enrichment pass actually does. Empty and loaded km
        // both refine now (the tour fetch returns its road distance), but the
        // solver's revenue/cost breakdown is NOT recoverable from a proposal, so
        // the card shows the solver's margin and no breakdown - claiming
        // otherwise is how a 0 gets read as a measurement.
        setRehydrateNote(
          `Showing the plan the agent solved${strat}: ${rebuilt.length} trip(s)` +
          (skipped ? `, ${skipped} outside this vehicle pool` : '') +
          '. Drawing road routes; empty and loaded distances start as straight-line and ' +
          'refine to road distance as each leg is measured. Margin is the solver\u2019s; ' +
          'the revenue/cost breakdown is not part of a collected plan.',
        );
        return;
      }
    })();

    return () => { cancelled = true; ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solveKeyParam, trailers]);

  // -----------------------------------------------------------------
  // Draw the road geometry for a rehydrated plan.
  //
  // A collected plan carries business keys and coordinates but no polylines: the
  // procedure never asks the engine for geometry. Without this pass the map shows
  // the stop markers and nothing joining them, which reads as a broken plan.
  //
  // Separate from the collection effect on purpose - the vehicle class (and so
  // the ORS profile) can arrive after the pool does, and the plan should appear
  // as soon as it is collected rather than waiting on the profile.
  // -----------------------------------------------------------------
  useEffect(() => {
    if (!cfg || !vehicleClass) return;
    const pending = assignments.filter(
      (a) => a.REHYDRATED && !a.ROUTE_GEOJSON && !enrichedKeysRef.current.has(a.ASSIGNMENT_ID),
    );
    if (!pending.length) return;
    // Claim before the await: this effect reruns on `assignments`, which the
    // enrichment itself replaces, and an unclaimed rerun would refetch forever.
    for (const a of pending) enrichedKeysRef.current.add(a.ASSIGNMENT_ID);
    let cancelled = false;
    enrichGeometry(pending, vehicleClass.ORS_PROFILE, cfg.region).then(() => {
      if (!cancelled) setAssignments((prev) => [...prev]);
    });
    return () => { cancelled = true; };
  }, [assignments, cfg, vehicleClass, enrichGeometry]);

  // -----------------------------------------------------------------
  // Retry the geometry for the assignment the dispatcher just clicked.
  //
  // Every polyline here comes from ORS DIRECTIONS, and `fetchDirections` returns
  // null on ANY failure - a transient seam error, an unroutable pair, or more
  // than MAX_DIRECTIONS_WAYPOINTS stops. The post-solve pass runs once, so a
  // single null left that card with no route line for the rest of the session:
  // the card rendered complete, nothing threw, and clicking it again could not
  // fix it because there was no second attempt anywhere. Selecting a card is
  // exactly the moment its geometry is worth paying for again.
  //
  // Uses the SAME enrichGeometry as the solve and rehydrate paths - one fetch
  // path, so a fix or a cache hit benefits all three.
  // -----------------------------------------------------------------
  const retriedGeomRef = useRef<Set<string>>(new Set());
  const [geomRetrying, setGeomRetrying] = useState(false);
  useEffect(() => {
    if (!cfg || !vehicleClass || !selectedAssignment) return;
    const target = assignments.find((a) => a.ASSIGNMENT_ID === selectedAssignment);
    if (!target || target.ROUTE_GEOJSON) return;
    // Claim before the await, for the same reason as the rehydrate pass: this
    // effect reruns on `assignments`, which the enrichment itself replaces.
    if (retriedGeomRef.current.has(selectedAssignment)) return;
    retriedGeomRef.current.add(selectedAssignment);
    let cancelled = false;
    setGeomRetrying(true);
    enrichGeometry([target], vehicleClass.ORS_PROFILE, cfg.region).then(() => {
      if (cancelled) return;
      setGeomRetrying(false);
      setAssignments((prev) => [...prev]);
    }).catch(() => { if (!cancelled) setGeomRetrying(false); });
    return () => { cancelled = true; };
  }, [selectedAssignment, assignments, cfg, vehicleClass, enrichGeometry]);


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
    autoSelectedForRef.current = null; retriedGeomRef.current.clear();
    setSolveStats(null);
    // This page is now the author of the plan, so the "showing the agent's plan"
    // notice must go - leaving it would attribute these numbers to the agent.
    setRehydrateNote(null);

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
        // maxStops counts LOADS; a shipment is two VROOM tasks (pickup +
        // delivery), so the task cap is doubled. Passing the load count
        // straight through made the slider's own "1 = pure backload" setting
        // unsatisfiable (one task cannot hold a pickup and its delivery).
        max_tasks: maxStops * 2,
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

    // `internal` is the STRUCTURAL provenance flag: it records which pool the
    // row came out of, and nothing downstream may re-derive that from `kind`.
    // `kind` is a display/channel label, and one of its legal external values
    // used to be the literal 'INTERNAL', so a `kind === 'INTERNAL'` test both
    // over-counted internal volumes and coloured external offers as internal.
    const offerById = new Map<number, { kind: 'INTERNAL' | string; internal: boolean; row: Volume | Offer }>();
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
      offerById.set(id, { kind: 'INTERNAL', internal: true, row: v });
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
      offerById.set(id, { kind: o.SOURCE, internal: false, row: o });
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

    // Whether the routability probe produced EVIDENCE we can act on. False when
    // it never ran, threw, or backed off - see the zero-pool branch below.
    let probeTrustworthy = false;

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
      const probe: UnroutableProbeStats = { probed: 0, clean: 0, rejected: 0, backedOff: false };
      try { badKeys = await findUnroutablePoints(profile, [...uniq.values()], anchor, cfg.region, { signal: ac.signal, stats: probe }); }
      catch { badKeys = new Set(); probe.backedOff = true; }
      probeTrustworthy = probe.clean > 0 && !probe.backedOff;
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

    // A pre-filter that zeroes out the solve is either a bad probe or a genuinely
    // unusable pool, and the two need OPPOSITE handling.
    //
    // Untrustworthy probe (nothing routed cleanly, or it threw): discard the
    // shear and solve the full set - the solve path detects a suspended engine
    // and the retry loop shears any real code-3 point one at a time.
    //
    // Trustworthy probe (some points routed cleanly, so the engine is provably
    // answering): the rejections are real. Restoring them here is what used to
    // hand the engine coordinates it had just refused, turning a shear-and-solve
    // into a hard matrix pre-compute failure. Report it instead.
    if (!workVehicles.length || !workShipments.length) {
      if (probeTrustworthy) {
        const what = !workVehicles.length ? 'vehicle start/end locations' : 'load pickup/dropoff locations';
        setSolveError(
          `Every one of the ${what} in this selection is outside the ${cfg.region} road graph, ` +
          `so there is nothing to solve. The routing engine is healthy - check that the ` +
          `selected region matches the data, or regenerate the preset for this region.`,
        );
        setSolving(false);
        solveAbortRef.current = null;
        return;
      }
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
        // postSolve handles the deferred case: the route answers 202 with a
        // solve_key when the solve outlives its 45s inline wait, and this polls
        // /api/solve-status until it finishes. Measured, a 100-vehicle /
        // 500-load solve takes 168.6s - well inside this page's 180s budget, but
        // far beyond what a single held-open request can do (the statement is
        // capped at 80s to stay under the ~90s SPCS ingress limit).
        const res = await postSolve(
          '/api/backload/solve',
          { challenge, region: cfg.region },
          ac.signal,
          (sec) => setSolverLog(`Still solving on Snowflake (${sec}s)...`),
        );
        body = res.body as typeof body;
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
        if (je.internal) revenue += segLoadedKm * internalRatePerKm;
        else revenue += Number(jr.PRICE_USD) || segLoadedKm * internalRatePerKm;
      }
      const cost = fixedDispatchUsd + tourHrs * costPerHourUsd + tourKmReal * costPerKmUsd + nDeliv * costPerDeliveryUsd;

      newAssignments.push({
        ASSIGNMENT_ID: `${t.TRAILER_ID}|${offerIdFirst}`,
        TRAILER_ID: t.TRAILER_ID, OFFER_ID: offerIdFirst, SOURCE: ent.kind,
        IS_INTERNAL: ent.internal,
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

    // Fetch the tour + deadhead polylines (shared with the rehydrate path).
    enrichGeometry(newAssignments, profile, cfg.region)
      .then(() => setAssignments([...newAssignments]));

    setSolving(false);
  }, [
    trailers, internal, external, cfg, vehicleClass, vehicleClassError,
    maxVehicles, maxInternal, maxExternal, maxStops, detourSlackHrs, deviationPct,
    internalFirstWeight, windowSlackHrs, endMode, sharedDestLon, sharedDestLat,
    costPerHourUsd, costPerKmUsd, fixedDispatchUsd, costPerDeliveryUsd, internalRatePerKm,
    enforceDriverBreak, breakAfterHrs, breakLengthMin, enforceShift, shiftLengthHrs,
    useMultiDimCapacity, useMultiWindow, enrichGeometry,
  ]);

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

  // Auto-select the top assignment when a NEW plan arrives, and repair a
  // selection that no longer exists in the list.
  //
  // Reads `visibleAssignments`, NOT `assignments`, and must therefore be declared
  // after that memo. The old form selected `assignments[0]` - the solver's
  // emission order - while the list renders `visibleAssignments`, which is
  // net-desc sorted and `hideUnprofitable`-filtered. So the highlighted card was
  // usually not the first card on screen, and when the filter hid that row the
  // selection resolved to null and the page looked unselected after a solve.
  //
  // Keyed on the SET OF VISIBLE IDS, not on `selectedAssignment` and not on the
  // array identity. The old form re-ran on the selection change itself, so
  // toggling the selected card off set it to null and this effect immediately
  // put it back on the first one - clicking a card twice silently selected the
  // top one and there was no way to select nothing. The array identity is no
  // good either: `visibleAssignments` is a fresh array on every render and
  // geometry enrichment replaces `assignments` with the same plan in it, which
  // would yank the selection back to the top on every enrichment tick.
  useEffect(() => {
    if (!visibleAssignments.length) return;
    const planKey = visibleAssignments.map((a) => a.ASSIGNMENT_ID).join('|');
    const isNewPlan = autoSelectedForRef.current !== planKey;
    autoSelectedForRef.current = planKey;
    const stale = !!selectedAssignment && !visibleAssignments.some((a) => a.ASSIGNMENT_ID === selectedAssignment);
    // A selection that is still on screen survives a list change, so toggling
    // `hideUnprofitable` does not yank the dispatcher back to the top card.
    if (stale || (isNewPlan && !selectedAssignment)) {
      setSelectedAssignment(visibleAssignments[0].ASSIGNMENT_ID);
    }
  }, [visibleAssignments, selectedAssignment]);

  const totalNetBenefit = useMemo(() => Math.round(visibleAssignments.reduce((s, a) => s + (a.NET_BENEFIT_USD || 0), 0)), [visibleAssignments]);
  // Counted on IS_INTERNAL, never on SOURCE. This number is published to the
  // agent memo (internal_matched below) and therefore gets quoted as fact, and
  // SOURCE carried the literal 'INTERNAL' on external offers - measured 75 rows
  // - so the SOURCE form over-counted internal matches by exactly those rows.
  const internalCount = useMemo(() => visibleAssignments.filter((a) => a.IS_INTERNAL === true).length, [visibleAssignments]);
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
  const selectedTrailerRow = useMemo(
    () => trailers.find((t) => t.TRAILER_ID === selectedTrailer) || null,
    [trailers, selectedTrailer],
  );

  // Keep the two selections in one story: selecting an assignment (from the list
  // or from the post-solve auto-select) also selects its vehicle, so the
  // baseline on screen always belongs to the plan on screen. Clearing the
  // assignment does NOT clear the vehicle - the dispatcher is then looking at a
  // bare baseline, which is exactly the pre-solve view.
  useEffect(() => {
    if (selected) setSelectedTrailer(selected.TRAILER_ID);
  }, [selected]);

  // Map click: the trailers layer is the only pickable vehicle surface. Clicking
  // a dot toggles it; clicking an offer, a stop marker, or empty space leaves the
  // selection alone, because a stray background click clearing the map is worse
  // than an extra click to dismiss.
  const onMapClick = useCallback((info: { object?: Record<string, unknown> } | null) => {
    const id = info?.object?.TRAILER_ID;
    if (typeof id !== 'string' || !id) return;
    setSelectedTrailer((prev) => (prev === id ? null : id));
    // If that vehicle has an assignment on screen, select it too so the stops
    // panel and the coloured route follow the click.
    const owned = visibleAssignments.find((a) => a.TRAILER_ID === id);
    setSelectedAssignment(owned ? owned.ASSIGNMENT_ID : null);
  }, [visibleAssignments]);

  // Lazy baseline fetch for the selected vehicle. Same live routing seam every
  // other polyline here uses. The key check before setBaseline discards a slow
  // response for a vehicle/endpoint that is no longer selected - without it,
  // clicking two vehicles quickly can paint the first one's baseline under the
  // second one's plan.
  useEffect(() => {
    const t = selectedTrailerRow;
    const profile = vehicleClass?.ORS_PROFILE;
    const regionName = cfg?.region;
    if (!t || !profile || !regionName) { setBaseline(null); return; }
    const from = [Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)] as [number, number];
    const end = baselineEndpointFor(t, endMode, sharedDestLon, sharedDestLat);
    if (!end || !Number.isFinite(from[0]) || !Number.isFinite(from[1])) { setBaseline(null); return; }
    const key = `${t.TRAILER_ID}|${end.pt[0].toFixed(5)},${end.pt[1].toFixed(5)}`;
    const cached = baselineCacheRef.current.get(key);
    if (cached) { setBaseline(cached); return; }
    let live = true;
    setBaseline(null);
    fetchBaselineLeg(profile, from, end.pt, regionName, end.label).then((res) => {
      baselineCacheRef.current.set(key, res);
      if (live) setBaseline(res);
    }).catch(() => {
      // Never leave the readout on "routing...": a failed leg is a stated
      // outcome, not an in-flight one.
      if (live) setBaseline({ geo: null, km: null, endLabel: end.label, status: 'failed' });
    });
    return () => { live = false; };
  }, [selectedTrailerRow, vehicleClass, cfg?.region, endMode, sharedDestLon, sharedDestLat]);

  // ---- agent grounding (Channel A; ref-guarded publish on change only) ----
  // Custom views keep results in local state, so the left-panel Cortex agent is
  // blind to the solved plan unless we surface it. Publish the on-screen
  // assignments as a bounded, pre-joined __memo_ STRING (viewState flattens
  // nested objects to "[object Object]"), plus scalar KPIs. MUST use the
  // ref+lastSent gate with deps [summary] only, or view-panel's fresh inline
  // onStateChange loops (React #185).
  const summary = useMemo(() => {
    const MAX_TRIPS = 12;
    const MAX_CHAIN_STOPS = 8;
    // Body left at its original indentation on purpose: this block has already
    // been reverted once by a commit written from a stale copy of the file, and a
    // whole-block reindent makes that far more likely to happen again. Only the
    // head and the join below are ours.
    const tripParts = visibleAssignments.slice(0, MAX_TRIPS).map((a) => {
          // Derive from STOPS, never from the scalar PICKUP_CITY /
          // PROPOSAL_DROPOFF_CITY pair: those come from the first pickup only,
          // so on a chained tour they name hop 1 and the agent then reports the
          // handover point as the final destination.
          const tour = describeTourChain(a.STOPS, MAX_CHAIN_STOPS);
          const drops = Array.isArray(a.STOPS)
            ? a.STOPS.filter((s) => s.kind === 'dropoff')
                .map((s) => realPlace(s.city) ?? (s.offerId ? `unnamed site for ${s.offerId}` : null))
                .filter(Boolean)
            : [];
          const dropStr = drops.length ? drops.join(', ') : (realPlace(a.PROPOSAL_DROPOFF_CITY) || '?');
          const loadStr = tour.loadIds.length > 1
            ? `CHAINED tour, ${tour.loadIds.length} loads ${tour.loadIds.join(' then ')} | `
            : (tour.loadIds.length === 1 ? `1 load ${tour.loadIds[0]} | ` : '');
          const chainStr = tour.chain
            ? ` | stops: ${tour.chain}${tour.truncatedStops ? ` (+${tour.truncatedStops} more stops)` : ''}`
            : '';
          const endStr = tour.endCity ? ` | tour ends at ${tour.endCity} (depot, not a delivery)` : '';
          const origin = tour.firstPickup ?? realPlace(a.PICKUP_CITY) ?? '?';
          const dest = tour.finalDropoff ?? realPlace(a.PROPOSAL_DROPOFF_CITY) ?? '?';
          // Economics: publish the revenue/cost breakdown ONLY when both terms
          // exist. A collected plan (REHYDRATED) carries the procedure's margin
          // and no breakdown - the proposal has no per-offer price, so revenue
          // cannot be derived for an external offer at all - and `|| 0` turned
          // that into "rev $0 cost $0 net +$1432". Every number there was
          // individually defensible and the line as a whole did not add up, which
          // is precisely the shape the agent quotes as fact. An unbacked breakdown
          // is worse than no breakdown.
          //
          // Restored after a concurrent commit reverted it. `check_backload_rehydrate_geometry.py`
          // rule E is what named the regression, and mutations M9/M10 are its
          // controls - if this block goes missing again, that gate goes red.
          const hasBreakdown = a.REVENUE_USD !== undefined && a.COST_USD !== undefined;
          const econ = hasBreakdown
            ? `, rev $${Math.round(a.REVENUE_USD as number)} cost $${Math.round(a.COST_USD as number)} net ${(a.NET_BENEFIT_USD ?? 0) >= 0 ? '+' : ''}$${Math.round(a.NET_BENEFIT_USD || 0)}`
            : (a.NET_BENEFIT_USD !== undefined
                ? `, margin ${a.NET_BENEFIT_USD >= 0 ? '+' : ''}$${Math.round(a.NET_BENEFIT_USD)} (solver margin; revenue/cost breakdown not available for a collected plan)`
                : '');
          return `${a.TRAILER_ID} ${a.SOURCE} | ${loadStr}first pickup ${origin} -> final dropoff ${dest}${chainStr}${endStr} | drops: ${dropStr} | ${a.N_DELIVERIES ?? drops.length} deliv, empty ${Math.round(a.EMPTY_KM || 0)}km (${Math.round(a.EMPTY_OUT_KM || 0)} out + ${Math.round(a.EMPTY_BACK_KM || 0)} back) loaded ${Math.round(a.LOADED_KM || 0)}km${a.SAVED_KM !== undefined ? `, deadhead avoided ${Math.round(a.SAVED_KM)}km vs ${Math.round(a.BASELINE_EMPTY_KM || 0)}km reposition baseline` : ''}${econ}`;
        });
    // Bound by CHARACTERS, not by row count. MAX_TRIPS caps rows, but 12 rows of
    // tour prose measured 3,627 chars - over the consumer's whole-panel budget in
    // app/api/chat/route.ts - and that consumer trims PANELS, so the entire list
    // was deleted from the agent's context rather than shortened. joinBounded
    // drops whole trips and says how many. The overflow note is a PART, so it is
    // either included or itself counted in joinBounded's "(+N more)": either way
    // the agent learns this is a top-N slice and never reads it as the whole plan.
    const overflow = visibleAssignments.length - tripParts.length;
    if (overflow > 0) tripParts.push(`(+${overflow} more trips, not listed)`);
    const memo = tripParts.length ? joinBounded(tripParts, TRIP_MEMO_MAX_LEN) : null;
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
        stroked: true, lineWidthMinPixels: 1,
        getRadius: (d: Trailer) => (d.TRAILER_ID === selectedTrailer ? 2000 : 1200),
        radiusMinPixels: 5, radiusMaxPixels: 9, pickable: true,
        updateTriggers: { getRadius: [selectedTrailer] },
      }) as unknown as Layer);
    }
    // Baseline: what the selected vehicle would have driven with NO backload -
    // its idle drop-off straight to the reposition endpoint. Pushed BEFORE the
    // route layers so the optimised plan always draws on top of it, and thin +
    // solid so it reads as a different kind of thing from the dashed empty legs
    // (which are part of the plan) and the coloured loaded path. Deliberately
    // NOT dimmed when an assignment is selected: the whole point is to compare
    // it against the plan, side by side.
    if (baseline?.geo) {
      const path = coordsFromGeoJSON(baseline.geo);
      if (path.length >= 2) {
        result.push(new PathLayer({
          id: 'baseline-path',
          data: [{ path, _baselineKm: baseline.km, _baselineEnd: baseline.endLabel }],
          getPath: (d: { path: LngLat[] }) => d.path,
          getColor: [150, 150, 150, 200],
          getWidth: 2, widthUnits: 'pixels', widthMinPixels: 1, widthMaxPixels: 3,
          parameters: { depthTest: false }, pickable: true,
        }) as unknown as Layer);
      }
    }
    // Route geometry is drawn for the SELECTED card only - loaded path and both
    // dashed empty legs. Drawing every assignment (previously done at reduced
    // alpha/width) put 16 coloured paths and up to 32 dashed legs on one map:
    // the dimming did not read as "context", it read as a plan nobody chose,
    // and it hid the one tour the stops panel and the KPI readout describe.
    // Nothing selected therefore means no route lines, which is the pre-solve
    // view plus - if a vehicle is selected - its bare grey baseline above.
    if (selected) {
      // The lazily fetched tour path already ends at the last task stop, so this
      // trim is normally a no-op. It stays because a geometry-bearing solve
      // response would cover the return reposition too, and that tail must not be
      // painted as if the vehicle were still carrying freight - the dashed
      // empty-leg layer owns it.
      if (selected.ROUTE_GEOJSON) {
        // Colour index is the card's position in the RENDERED list, not 0, so the
        // line keeps the same colour as its card swatch when the selection moves.
        const idx = visibleAssignments.findIndex((a) => a.ASSIGNMENT_ID === selected.ASSIGNMENT_ID);
        const c = ROUTE_COLORS[(idx < 0 ? 0 : idx) % ROUTE_COLORS.length];
        const full = coordsFromGeoJSON(selected.ROUTE_GEOJSON);
        const path = selected.LAST_TASK_LON !== undefined && selected.LAST_TASK_LAT !== undefined && (selected.EMPTY_BACK_KM ?? 0) > 0
          ? trimPathAt(full, [selected.LAST_TASK_LON, selected.LAST_TASK_LAT])
          : full;
        if (path.length >= 2) {
          result.push(new PathLayer({
            id: 'loaded-routes', data: [{ path }], getPath: (d: { path: LngLat[] }) => d.path,
            getColor: [c[0], c[1], c[2], 255], getWidth: 6,
            widthUnits: 'pixels', widthMinPixels: 2, parameters: { depthTest: false }, pickable: true,
            updateTriggers: { getColor: [selectedAssignment] },
          }) as unknown as Layer);
        }
      }
      const dashed = (id: string, data: unknown) => new GeoJsonLayer({
        id, data: data as GeoJSON.GeoJSON,
        stroked: true, getLineColor: [110, 110, 110, 255], getDashArray: [10, 6], lineWidthMinPixels: 6,
        extensions: [new PathStyleExtension({ dash: true })], parameters: { depthTest: false },
      }) as unknown as Layer;
      if (selected.EMPTY_GEOJSON) result.push(dashed('empty-sel', selected.EMPTY_GEOJSON));
      if (selected.EMPTY_RETURN_GEOJSON) result.push(dashed('empty-ret-sel', selected.EMPTY_RETURN_GEOJSON));
    }
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
  }, [external, internal, trailers, visibleAssignments, selectedAssignment, selected, selectedTrailer, baseline]);

  // Agent grounding, Channel B: this page builds deck.gl layers itself, so nothing
  // publishes map state for it and the agent could not answer "what is on the map"
  // or diagnose an empty one. Derived from the compiled layers so a future layer is
  // described automatically. Gated on having loaded something, so a pre-solve page
  // publishes null instead of an all-zero map the agent would report as a finding.
  usePublishMapState(
    useMemo(
      () =>
        describeDeckLayers(layers, {
          selection: {
            selected_trailer: selected?.TRAILER_ID ?? selectedTrailer ?? null,
            baseline_km: baseline?.km ?? null,
            baseline_end: baseline?.endLabel ?? null,
            baseline_status: baseline?.status ?? null,
          },
          ready: trailers.length > 0 || internal.length > 0 || external.length > 0,
        }),
      [layers, selected, selectedTrailer, baseline, trailers.length, internal.length, external.length],
    ),
  );

  // Fit-to coords: selected route (+empty leg, +baseline) when an assignment is
  // selected; else the whole estate.
  //
  // Selecting a VEHICLE deliberately contributes nothing here. It used to narrow
  // the coords to that trailer plus its baseline, which - paired with a `tr:`
  // focusKey - forced a zoom onto one vehicle every time the user clicked one.
  // Clicking a vehicle is a "show me its baseline line" gesture, not a "take me
  // there" one, so the coords set stays byte-identical to the unselected estate
  // view and MapView performs no fit at all.
  const fitCoords = useMemo<LngLat[]>(() => {
    const baseCoords = coordsFromGeoJSON(baseline?.geo);
    if (selected) {
      const out: LngLat[] = [
        [selected.TRAILER_DROPOFF_LON, selected.TRAILER_DROPOFF_LAT],
        [selected.PICKUP_LON, selected.PICKUP_LAT],
        [selected.DROPOFF_LON, selected.DROPOFF_LAT],
        ...coordsFromGeoJSON(selected.ROUTE_GEOJSON),
        ...coordsFromGeoJSON(selected.EMPTY_GEOJSON),
        ...coordsFromGeoJSON(selected.EMPTY_RETURN_GEOJSON),
        ...baseCoords,
      ];
      return out.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    }
    const out: LngLat[] = [];
    for (const t of trailers) if (Number.isFinite(Number(t.DROPOFF_LON))) out.push([Number(t.DROPOFF_LON), Number(t.DROPOFF_LAT)]);
    for (const i of internal) if (Number.isFinite(Number(i.PICKUP_LON))) out.push([Number(i.PICKUP_LON), Number(i.PICKUP_LAT)]);
    for (const e of external) if (Number.isFinite(Number(e.PICKUP_LON))) out.push([Number(e.PICKUP_LON), Number(e.PICKUP_LAT)]);
    return out;
  }, [selected, baseline, trailers, internal, external]);

  const getTooltip = useCallback((info: { object?: Record<string, unknown> }) => {
    const object = info?.object;
    if (!object) return null;
    const style = { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' };
    if (object._baselineEnd !== undefined) {
      const km = formatNumber(object._baselineKm, { column: 'km' });
      return { html: `<b>Baseline - no backload</b><br/>Reposition to ${escapeHtml(object._baselineEnd)}${km ? `<br/>${escapeHtml(km)} km empty` : ''}`, style };
    }
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

      {rehydrateNote && (
        <div style={{ background: 'rgba(41,181,232,0.10)', color: '#0e7490', border: '1px solid rgba(41,181,232,0.4)', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
          {rehydrateNote}
        </div>
      )}

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 12 }}>
        <div style={kpiCard}><div style={kpiLabel}>Trailers</div><div style={{ fontSize: 22, fontWeight: 700 }}>{trailers.length}</div></div>
        <div style={kpiCard}><div style={kpiLabel}>Internal load pool</div><div style={{ fontSize: 22, fontWeight: 700 }}>{internal.length}</div></div>
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
        {slider('Max trailers', `How many idle trailers get sent to the solver, taken in id order. Auto-clamped on Solve so the precomputed ORS matrix stays under ${BM_MAX_MATRIX_LOCATIONS} unique locations.`, maxVehicles, setMaxVehicles, BM_VEHICLES_MIN, BM_VEHICLES_MAX)}
        {slider('Max internal loads', 'How many loads from the internal pool enter the solver, ranked by straight-line proximity to the nearest idle trailer. Proximity only - the ranking does not consider the pickup window, weight fit or revenue.', maxInternal, setMaxInternal, BM_INTERNAL_MIN, BM_INTERNAL_MAX)}
        {slider('Max external offers', 'How many external freight-exchange offers enter the solver, ranked by straight-line proximity to the nearest idle trailer.', maxExternal, setMaxExternal, BM_EXTERNAL_MIN, BM_EXTERNAL_MAX)}
        <div style={{ minWidth: 220, fontSize: 12, color: budget.counterColor }}>
          <div style={{ fontWeight: 600 }}>Locations used: {budget.used} / {BM_MAX_MATRIX_LOCATIONS}</div>
          {budget.overBudget && budget.preview && (<div style={{ fontSize: 11 }}>Will clamp on Solve to {budget.preview.v}/{budget.preview.i}/{budget.preview.e}</div>)}
          {!budget.overBudget && budget.nearBudget && (<div style={{ fontSize: 11 }}>Approaching matrix budget</div>)}
        </div>
      </div>

      {/* SOLVER */}
      <div style={sectionHdr}>SOLVER (VROOM-native)</div>
      <div style={sectionBox}>
        {slider('Max loads per trailer', 'How many shipments one trailer may collect on a single tour. 1 = pure backload; higher = consolidation tours.\n\nVROOM field: vehicle.max_tasks (set to 2x this value, since each shipment is a pickup task plus a delivery task)', maxStops, setMaxStops, 1, 6)}
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
        {/* Matches the solid grey `baseline-path` PathLayer: thin and solid so it
            reads as a different kind of thing from the dashed empty legs, which
            are part of the plan. Drawn only for the selected vehicle. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 24, height: 0, borderTop: '2px solid rgb(150,150,150)', display: 'inline-block' }} />Baseline - no backload (selected vehicle)</span>
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
          <MapView layers={layers} fitTo={{ coords: fitCoords, focusKey: selectedAssignment ? `sel:${selectedAssignment}` : '', focusOnlyIfOffscreen: true, regionKey: cfg?.region, regionCoords }} getTooltip={getTooltip} onClick={onMapClick} onRecenterReady={(fn) => { recenterRef.current = fn; }} />
          {/* Baseline readout. Pre-solve this is the whole answer ("what would
              this vehicle have driven anyway"); post-solve it sits beside the
              plan's own empty km so the comparison is on screen, not implied. */}
          {selectedTrailer && (
            <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 5, padding: '6px 10px', fontSize: 11, borderRadius: 4, border: '1px solid var(--border-default, #e5e7eb)', background: 'rgba(255,255,255,0.92)', color: 'var(--text-primary, #111827)', boxShadow: '0 1px 3px rgba(0,0,0,0.12)', maxWidth: 320 }}>
              <span style={{ display: 'inline-block', width: 18, height: 0, borderTop: '2px solid rgb(150,150,150)', verticalAlign: 'middle', marginRight: 6 }} />
              <b>{selectedTrailer}</b> baseline (no backload):{' '}
              {!baseline && <span style={{ color: 'var(--text-secondary, #6b7280)' }}>routing...</span>}
              {baseline?.status === 'at-end' && <>0 km - already at {baseline.endLabel}</>}
              {baseline?.status === 'failed' && <span style={{ color: 'var(--text-secondary, #6b7280)' }}>no routable leg to {baseline.endLabel}</span>}
              {baseline?.status === 'ok' && <>{formatNumber(baseline.km, { column: 'km' }) ?? '-'} km empty to {baseline.endLabel}</>}
              {selected && (
                <> - plan drives {formatNumber(selected.EMPTY_KM, { column: 'km' }) ?? '-'} km empty
                  {(selected.SAVED_KM ?? 0) > 0 ? `, saving ${formatNumber(selected.SAVED_KM, { column: 'km' })} km` : ''}</>
              )}
              <button type="button" onClick={() => { setSelectedTrailer(null); setSelectedAssignment(null); }} style={{ marginLeft: 8, padding: '0 4px', fontSize: 11, borderRadius: 3, border: '1px solid var(--border-default, #e5e7eb)', background: 'transparent', color: 'var(--text-secondary, #6b7280)', cursor: 'pointer' }}>clear</button>
            </div>
          )}
          <button type="button" onClick={() => recenterRef.current?.()} style={{ position: 'absolute', top: 12, right: 12, zIndex: 5, padding: '6px 10px', fontSize: 12, borderRadius: 4, border: '1px solid var(--border-default, #e5e7eb)', background: 'rgba(255,255,255,0.92)', color: 'var(--text-primary, #111827)', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}>Recenter</button>
          {/* A selected card with no loaded polyline is otherwise a silently blank
              map: the stops and every number are right, nothing joins them, and
              no error is raised anywhere. Say which of the two states it is. */}
          {selected && !selected.ROUTE_GEOJSON && (
            <div style={{ position: 'absolute', bottom: 12, right: 12, zIndex: 5, padding: '6px 10px', fontSize: 11, borderRadius: 4, border: '1px solid rgba(245,158,11,0.45)', background: 'rgba(255,255,255,0.94)', color: '#92400e', boxShadow: '0 1px 3px rgba(0,0,0,0.12)', maxWidth: 300 }}>
              {geomRetrying
                ? 'Fetching road geometry for this tour...'
                : 'No routable road geometry for this tour - showing stops only. Reselect the card to retry.'}
            </div>
          )}
          {selected && (
            <button type="button" onClick={() => stopsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} style={{ position: 'absolute', top: 12, right: 108, zIndex: 5, padding: '6px 10px', fontSize: 12, borderRadius: 4, border: '1px solid var(--border-default, #e5e7eb)', background: 'rgba(255,255,255,0.92)', color: 'var(--text-primary, #111827)', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}>Stops &darr;</button>
          )}
        </div>
        <AssignmentList assignments={visibleAssignments} unassigned={unassigned} selectedAssignment={selectedAssignment} onSelect={(id) => {
          if (selectedAssignment === id) {
            // Deselecting drops the geometry claim, so reselecting the card is a
            // real second attempt - which is what the no-geometry notice says.
            retriedGeomRef.current.delete(id);
            setSelectedAssignment(null);
          } else {
            setSelectedAssignment(id);
          }
        }} rationale={rationale} rationaleLoading={rationaleLoading} onAskRationale={askRationale} />
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
