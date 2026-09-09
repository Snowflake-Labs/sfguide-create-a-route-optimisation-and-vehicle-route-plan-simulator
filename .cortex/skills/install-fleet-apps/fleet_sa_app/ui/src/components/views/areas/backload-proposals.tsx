'use client';

// Backload Proposals - dispatcher cockpit (neutral, industry-agnostic).
//
// The advanced sibling of Backload Matching. Runs a selectable set of optimizer
// strategies over the neutral, synthetic-backed FLEET_APP.BACKLOAD_MATCHING
// views, scores every (vehicle, load) pair on seven dimensions client-side
// (backload-ensemble.ts), and presents the result in a Freight-Exchange-style
// cockpit: compact KPI strip + status bar + 2-row filter/strategy bar +
// perspective toggle (Vehicles / Loads / Ensemble) + a master list beside a map
// and a detail drawer. Weight sliders re-rank instantly. Accept/Reject/Flag are
// session-only (no write-back). Solves reuse the /api/backload/solve seam; the
// selected route follows roads via a lazily-fetched ORS DIRECTIONS path. No
// vendor branding.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { usePublishMapState } from '@/lib/agent-memo';
import type { ViewProps } from '@/lib/types';
import {
  rankByWeights, groupByTrailer, loadWeights, saveWeights,
  DEFAULT_WEIGHTS, FAMILY_LABELS,
  type ScoredPair, type ParamRow, type EnsembleWeights,
  type StrategyFamily,
} from './backload-ensemble';
import { sfRead, sqlLiteral, callVerb } from './backload-matching/helpers';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';
import { isRoutingSuspendedError, RoutingSuspendedError, type SuspendedInfo } from '@/lib/routing-suspend';
import KpiStrip, { type KpiStat } from './backload-proposals/KpiStrip';
import StatusBar from './backload-proposals/StatusBar';
import FilterBar, { type StrategyOption } from './backload-proposals/FilterBar';
import WeightSliders from './backload-proposals/WeightSliders';
import EnsembleList from './backload-proposals/EnsembleList';
import VehicleList from './backload-proposals/VehicleList';
import LoadList from './backload-proposals/LoadList';
import DetailDrawer from './backload-proposals/DetailDrawer';
import ProposalMap, { type MapVehicle, type MapLoad, type MapLink, type MapStop } from './backload-proposals/ProposalMap';
import LegendOverlay, { LegendSection } from './backload-proposals/LegendOverlay';
import { COLOR_VEHICLE, COLOR_INTERNAL, COLOR_EXTERNAL, COLOR_LEG_EMPTY } from './backload-proposals/constants';
import { INITIAL_FILTERS, type FilterState, type Perspective, type EnsembleBasis, type Decision, type DecisionState, type ChipDef } from './backload-proposals/types';

const BM = 'FLEET_APP.BACKLOAD_MATCHING';
const PHYS = 'FLEET_INTELLIGENCE.BACKLOAD_MATCHING';

interface Trailer {
  TRAILER_ID: string; OPERATING_COUNTRY: string;
  HOME_LON: number; HOME_LAT: number;
  EMPTY_CITY: string; EMPTY_LON: number; EMPTY_LAT: number;
  EMPTY_FROM_TS: string | null; NEXT_START_LON: number; NEXT_START_LAT: number;
  MAX_PAYLOAD_KG: number; HAZMAT_CERT: boolean;
}
interface Load {
  LOAD_ID: string; IS_INTERNAL: boolean; SOURCE: string;
  PICKUP_CITY: string; PICKUP_LON: number; PICKUP_LAT: number;
  DELIVERY_CITY: string; DELIVERY_LON: number; DELIVERY_LAT: number;
  REQUESTED_PICKUP_TS: string | null; WEIGHT_KG: number; PRODUCT: string;
  HAZMAT: boolean; PRICE_USD: number | null; APPROX_DISTANCE_KM: number | null;
}
interface VehicleClass {
  VEHICLE_TYPE: string; ORS_PROFILE: string; PAYLOAD_KG_TYP: number;
  AVG_SPEED_KMH: number; COST_PER_KM: number; HOME_RANGE_KM: number; LABEL_NOUN: string;
}
// How many graded pairs to pull back. The cockpit shows several candidates per
// vehicle across three perspectives, so a per-vehicle-best response would make the
// Loads and Ensemble views impossible; this bounds the payload instead.
const PAIR_LIMIT = 200;

// Single-strategy options (non-ensemble perspectives).
const STRATEGY_OPTIONS: StrategyOption[] = [
  { key: 'baseline', label: 'Quick scan - nearest load' },
  { key: 'vrp', label: 'Per-load VRP (road)' },
  { key: 'fleet', label: 'Fleet 1:1 (road)' },
  { key: 'bpmp', label: 'Profit-max backhaul (road)' },
];

// Thrown by apiSolve and sfRead when the routing engine is suspended so the
// caller can show the shared resume notice (server has already triggered the
// resume). Aliased to the shared class so both paths land in ONE catch.
const SuspendedError = RoutingSuspendedError;

// Road path for a single pair via ORS DIRECTIONS through [empty, pickup,
// delivery]. Returns [lon,lat][] or null on any failure (caller falls back to
// straight legs). Waypoints are numeric-only -> injection-safe.
async function fetchRouteCoords(profile: string, waypoints: [number, number][], region: string): Promise<[number, number][] | null> {
  const pts = waypoints.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && !(lon === 0 && lat === 0));
  if (pts.length < 2) return null;
  const locs = JSON.stringify(pts);
  const prof = profile.replace(/[^a-z0-9-]/gi, '');
  const reg = sqlLiteral(region);
  const sql = `SELECT ST_ASGEOJSON(GEOJSON)::STRING AS G FROM TABLE(OPENROUTESERVICE_APP.CORE.DIRECTIONS('${prof}', OBJECT_CONSTRUCT('coordinates', PARSE_JSON('${locs}'))::VARIANT, '${reg}'))`;
  try {
    const rows = await sfRead(sql);
    const g = (rows[0] as { G?: string } | undefined)?.G;
    if (!g) return null;
    const parsed = JSON.parse(g) as { coordinates?: [number, number][] };
    const coords = parsed?.coordinates;
    return Array.isArray(coords) && coords.length > 1 ? coords : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const okPt = (lon: number, lat: number) => Number.isFinite(lon) && Number.isFinite(lat) && !(lon === 0 && lat === 0);

export function BackloadProposalsView({ onStateChange }: Partial<ViewProps> = {}) {
  const region = useAppStore((s) => s.context['region']) as string | undefined;

  const [cfg, setCfg] = useState<{ vehicleType: string; region: string } | null>(null);
  const [cls, setCls] = useState<VehicleClass | null>(null);
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [loads, setLoads] = useState<Load[]>([]);
  // Count only. The eligibility view is a cross join of the two pools, so the
  // page used to pull ~246k rows into the browser purely to display its size and
  // to look up five booleans per selected pair. The verb now returns those
  // booleans with each pair, so a scalar count is all that is left.
  const [eligibleCount, setEligibleCount] = useState(0);
  const [params, setParams] = useState<ParamRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [perspective, setPerspective] = useState<Perspective>('ensemble');
  const [strategy, setStrategy] = useState<string>('baseline');
  const [ensembleBasis, setEnsembleBasis] = useState<EnsembleBasis>('road');
  const [maxVehicles, setMaxVehicles] = useState(20);
  const [maxLoads, setMaxLoads] = useState(120);
  const [weights, setWeights] = useState<EnsembleWeights>(DEFAULT_WEIGHTS);
  const [weightsOpen, setWeightsOpen] = useState(true);

  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [busy, setBusy] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [suspended, setSuspended] = useState<SuspendedInfo | null>(null);
  const [pairs, setPairs] = useState<ScoredPair[]>([]);
  const [gradedCount, setGradedCount] = useState(0);
  const [ranAt, setRanAt] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [routeGeo, setRouteGeo] = useState<Record<string, [number, number][]>>({});
  const [decisions, setDecisions] = useState<Record<string, DecisionState>>({});
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [rationaleByKey, setRationaleByKey] = useState<Record<string, string>>({});
  const [explaining, setExplaining] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);

  useEffect(() => { setWeights(loadWeights()); }, []);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const cfgRows = await sfRead(`SELECT VEHICLE_TYPE, REGION FROM ${BM}.VW_CONFIG LIMIT 1`);
      const c = cfgRows[0] as { VEHICLE_TYPE?: string; REGION?: string } | undefined;
      const vehicleType = String(c?.VEHICLE_TYPE ?? 'hgv');
      // The APP's selected region wins over CONFIG's single row. CONFIG is a
      // default-selection hint, not the scope.
      const cfgRegion = String(region ?? c?.REGION ?? 'SanFrancisco');
      setCfg({ vehicleType, region: cfgRegion });

      // Region scoping is mandatory and NOT optional tidying. VW_TRAILERS_GEO,
      // VW_LOADS and VW_CANDIDATES_SCORED do not project REGION (their sources
      // do), so reading them bare pools every loaded region into one cockpit -
      // measured 191 vehicles and 5,632 loads account-wide against 100 and 5,300
      // for San Francisco. The result is not merely noisy: it proposes a backload
      // the vehicle physically cannot reach, and it scores WELL, because the empty
      // leg is computed from coordinates that are perfectly valid in isolation.
      // The FLEET_APP contract views do carry REGION, so scope through them.
      const scope = { region: cfgRegion };
      const scopedTrailerIds = `SELECT TRAILER_ID FROM ${BM}.VW_TRAILERS WHERE REGION = :region`;
      const scopedLoadIds =
        `SELECT ID AS LOAD_ID FROM ${BM}.VW_INTERNAL_VOLUMES WHERE REGION = :region`
        + ` UNION ALL SELECT OFFER_ID AS LOAD_ID FROM ${BM}.VW_EXTERNAL_OFFERS WHERE REGION = :region`;
      const [clsRows, tRows, lRows, scRows, pRows] = await Promise.all([
        sfRead(`SELECT * FROM ${BM}.VW_VEHICLE_CLASS WHERE VEHICLE_TYPE = '${sqlLiteral(vehicleType)}' LIMIT 1`),
        sfRead(`SELECT TRAILER_ID, OPERATING_COUNTRY, HOME_LON, HOME_LAT, EMPTY_CITY, EMPTY_LON, EMPTY_LAT, EMPTY_FROM_TS, NEXT_START_LON, NEXT_START_LAT, MAX_PAYLOAD_KG, HAZMAT_CERT FROM ${PHYS}.VW_TRAILERS_GEO WHERE TRAILER_ID IN (${scopedTrailerIds})`, { params: scope }),
        // The id set MUST be a CTE joined in: Snowflake rejects an IN (...) with a
        // UNION ALL inside it as "Unsupported subquery type cannot be evaluated".
        sfRead(`WITH scoped AS (${scopedLoadIds}) SELECT l.LOAD_ID, l.IS_INTERNAL, l.SOURCE, l.PICKUP_CITY, l.PICKUP_LON, l.PICKUP_LAT, l.DELIVERY_CITY, l.DELIVERY_LON, l.DELIVERY_LAT, l.REQUESTED_PICKUP_TS, l.WEIGHT_KG, l.PRODUCT, l.HAZMAT, l.PRICE_USD, l.APPROX_DISTANCE_KM FROM ${PHYS}.VW_LOADS l JOIN scoped s ON s.LOAD_ID = l.LOAD_ID`, { params: scope }),
        // Scoped on BOTH sides, not just the vehicle: this set feeds the visible
        // "Eligible pairs" KPI, so leaving loads unscoped would count in-region
        // vehicles paired with out-of-region loads and inflate the number the
        // dispatcher reads. A COUNT, not the rows: the page needs the size, and the
        // per-pair booleans now arrive with each pair from the verb.
        sfRead(`WITH scoped AS (${scopedLoadIds}) SELECT COUNT(*) AS N FROM ${PHYS}.VW_CANDIDATES_SCORED c JOIN scoped s ON s.LOAD_ID = c.LOAD_ID WHERE c.ELIGIBLE = TRUE AND c.TRAILER_ID IN (${scopedTrailerIds})`, { params: scope }),
        sfRead(`SELECT PARAM_KEY, PARAM_VALUE FROM ${PHYS}.MATCH_PARAMS`),
      ]);
      setCls((clsRows[0] as unknown as VehicleClass) ?? null);
      setTrailers(tRows as unknown as Trailer[]);
      setLoads(lRows as unknown as Load[]);
      setEligibleCount(Number((scRows[0] as { N?: number } | undefined)?.N ?? 0));
      setParams(pRows as unknown as ParamRow[]);
    } catch (e) {
      if (isRoutingSuspendedError(e)) { setSuspended(e.info); return; }
      const msg = e instanceof Error ? e.message : 'Failed to load backload data';
      // The cockpit data layer (VW_LOADS / VW_CANDIDATES_SCORED / MATCH_PARAMS in
      // FLEET_INTELLIGENCE.BACKLOAD_MATCHING) is provisioned by the admin app boot
      // init. Until it has run for the active dataset those objects do not exist;
      // show a clear, neutral message instead of the raw Snowflake 422.
      setLoadErr(/does not exist or not authorized/i.test(msg)
        ? 'Backload Proposals data is still provisioning for the active dataset. The admin app recreates it at boot from a generated dataset - generate/select a dataset for this region, then use Refresh.'
        : msg);
    }
  }, [region]);

  useEffect(() => { load(); }, [load]);

  const trailerById = useMemo(() => {
    const m = new Map<string, Trailer>();
    for (const t of trailers) m.set(t.TRAILER_ID, t);
    return m;
  }, [trailers]);
  const loadByLid = useMemo(() => {
    const m = new Map<string, Load>();
    for (const l of loads) m.set(l.LOAD_ID, l);
    return m;
  }, [loads]);

  // One verb call replaces the whole browser-side pipeline: strategy selection,
  // challenge construction, the routability pre-filter, the solve, the
  // unroutable-point shear-and-retry, and the seven-dimension scoring. It returns
  // pairs WITH their per-dimension scores, which is what lets the weight sliders
  // keep re-ranking locally with no round trip.
  const runStrategy = useCallback(async (strat: string) => {
    if (!cfg || !cls) return;
    setBusy(strat === 'ensemble' ? 'Solving all strategies\u2026' : 'Solving\u2026');
    setSolveError(null); setInfo(null);
    setPairs([]); setDecisions({}); setSelectedKey(null); setRouteGeo({}); setRationaleByKey({}); setSuspended(null);
    try {
      const result = await callVerb('backload_solve', [
        strat, maxVehicles, maxLoads, cfg.region, PAIR_LIMIT, 'pair',
      ]);
      const rows = (result.pairs as ScoredPair[] | undefined) ?? [];
      const counts = (result.counts ?? {}) as Record<string, number>;
      const ranSt = (result.strategies_run as string[] | undefined) ?? [];
      const excluded = Number(counts.excluded_unroutable ?? 0);
      const excludedNote = excluded > 0 ? ` Excluded ${excluded} unroutable stop(s).` : '';
      // A partially-degraded solve is still a success; say so rather than
      // presenting a thinner plan as complete.
      const degraded = result.degraded ? ` ${String(result.degraded)}` : '';
      if (!rows.length) {
        setSolveError('No proposals produced. Ensure the routing service is running for this region '
          + 'and that vehicles/loads exist for the active preset.' + excludedNote);
      } else {
        setInfo((ranSt.length > 1
          ? `Ensemble complete - ${ranSt.length} strategies graded. Tune the scoring weights to re-rank instantly.`
          : 'Match complete.') + excludedNote + degraded);
      }
      setPairs(rows);
      setGradedCount(Number(counts.graded_pairs ?? rows.length));
      setRanAt(Date.now());
    } catch (e) {
      if (e instanceof SuspendedError) setSuspended(e.info);
      else setSolveError(e instanceof Error ? e.message : 'Solve failed');
    } finally { setBusy(null); }
  }, [cfg, cls, maxVehicles, maxLoads]);

  const onRun = useCallback(() => runStrategy(strategy), [runStrategy, strategy]);
  // 'great_circle' basis means the estimate-only strategy, which is also the one
  // that still answers when the routing engine is suspended.
  const onRunEnsemble = useCallback(
    () => runStrategy(ensembleBasis === 'road' ? 'ensemble' : 'baseline'),
    [runStrategy, ensembleBasis]);

  // Pairs arrive already scored on all seven dimensions, so the only thing left
  // client-side is applying the dispatcher's weights - which is deliberate: it is
  // a pure function of (scores, weights), so a slider re-ranks instantly with no
  // server round trip.
  const rankedAll = useMemo(() => rankByWeights(pairs, weights), [pairs, weights]);
  const consolidationActive = useMemo(() => pairs.some((p) => p.scores?.consolidation != null), [pairs]);

  // Country options from operating countries.
  const countries = useMemo(() => Array.from(new Set(trailers.map((t) => t.OPERATING_COUNTRY).filter(Boolean))).sort(), [trailers]);
  const maxEmptyKmDefault = useMemo(() => {
    const v = Number(params.find((p) => p.PARAM_KEY === 'MAX_EMPTY_KM')?.PARAM_VALUE);
    return Number.isFinite(v) ? v : 100;
  }, [params]);

  // Apply cockpit filters to the ranked pairs.
  const ranked = useMemo(() => rankedAll.filter((p) => {
    if (filters.country && p.pickupCountry !== filters.country) return false;
    if (filters.source === 'internal' && !p.isInternal) return false;
    if (filters.source === 'external' && p.isInternal) return false;
    if (filters.feasibleOnly && p.feasible === false) return false;
    if (typeof filters.maxEmptyKm === 'number' && p.emptyKm != null && Number(p.emptyKm) > filters.maxEmptyKm) return false;
    if (filters.hideSameOriginDest && p.emptyCity && p.pickupCity && p.emptyCity === p.pickupCity) return false;
    if (filters.decision !== 'ANY') {
      const d = decisions[p.key];
      if (filters.decision === 'UNDECIDED') { if (d) return false; }
      else if (!d || d.action !== filters.decision) return false;
    }
    return true;
  }), [rankedAll, filters, decisions]);

  const grouped = useMemo(() => groupByTrailer(ranked), [ranked]);
  const uniqueLoads = useMemo(() => new Set(ranked.map((p) => p.loadId)).size, [ranked]);

  // Auto-select the top-ranked pair so exactly one route is shown after a run.
  useEffect(() => {
    if (!ranked.length) return;
    if (!selectedKey || !ranked.some((r) => r.key === selectedKey)) setSelectedKey(ranked[0].key);
  }, [ranked, selectedKey]);

  const selectedPair = useMemo(() => ranked.find((r) => r.key === selectedKey) ?? null, [ranked, selectedKey]);

  // Lazily fetch the selected pair's road path.
  useEffect(() => {
    if (!selectedKey || !cls || !cfg || !selectedPair) return;
    if (routeGeo[selectedKey]) return;
    const t = trailerById.get(selectedPair.trailerId);
    const l = loadByLid.get(selectedPair.loadId);
    if (!t || !l) return;
    const key = selectedKey;
    const wp: [number, number][] = [
      [num(t.EMPTY_LON), num(t.EMPTY_LAT)],
      [num(l.PICKUP_LON), num(l.PICKUP_LAT)],
      [num(l.DELIVERY_LON), num(l.DELIVERY_LAT)],
    ];
    let cancelled = false;
    fetchRouteCoords(cls.ORS_PROFILE, wp, cfg.region).then((coords) => {
      if (cancelled || !coords) return;
      setRouteGeo((prev) => (prev[key] ? prev : { ...prev, [key]: coords }));
    });
    return () => { cancelled = true; };
  }, [selectedKey, cls, cfg, selectedPair, trailerById, loadByLid, routeGeo]);

  const applyWeights = useCallback((w: EnsembleWeights) => { setWeights(w); saveWeights(w); }, []);

  // --- decisions (session-only) ---
  const onDecide = useCallback((key: string, action: Decision, reason?: string) => {
    setDecisions((p) => ({ ...p, [key]: { action, reason } }));
    setReasonFor(null);
  }, []);

  // --- per-pair constraint chips ---
  // Per-constraint verdicts now travel WITH each pair from the verb, so the page no
  // longer scans the whole eligibility view to find five booleans.
  const chipsFor = useCallback((trailerId: string, loadId: string): ChipDef[] => {
    const p = pairs.find((x) => x.trailerId === trailerId && x.loadId === loadId);
    const c = (p as unknown as { constraints?: Record<string, boolean> } | undefined)?.constraints;
    if (!c) return [];
    return [
      { label: 'Distance', ok: c.distance === true }, { label: 'Pickup time', ok: c.pickup_time === true },
      { label: 'Horizon', ok: c.horizon === true }, { label: 'Capacity', ok: c.capacity === true },
      { label: 'Hazmat', ok: c.hazmat === true },
    ];
  }, [pairs]);
  const selectedChips = useMemo(() => selectedPair ? chipsFor(selectedPair.trailerId, selectedPair.loadId) : [], [selectedPair, chipsFor]);

  // --- Cortex explain for one pair ---
  const explain = useCallback(async (key: string) => {
    const p = ranked.find((r) => r.key === key);
    if (!p) return;
    setExplaining(true);
    try {
      const desc = `${p.trailerId} -> ${p.loadId} (${FAMILY_LABELS[p.bestSource]}, grade ${p.grade}, empty ${(p.emptyKm ?? 0).toFixed(0)}km${p.isInternal ? ', internal' : ', external'})`;
      const prompt = `You are a fleet dispatch assistant. In 2 short sentences, explain why this backload proposal reduces empty running and improves asset utilization, and note the internal-first preference: ${desc}`;
      const promptLit = sqlLiteral(prompt);
      const rows = await sfRead(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${promptLit}') AS R`);
      const text = String((rows[0] as { R?: string })?.R ?? '').trim();
      setRationaleByKey((prev) => ({ ...prev, [key]: text }));
    } catch (e) {
      setRationaleByKey((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : 'Rationale unavailable' }));
    } finally { setExplaining(false); }
  }, [ranked]);

  // --- KPIs ---
  const kpis = useMemo(() => {
    const n = grouped.length;
    const internal = grouped.filter((r) => r.best.isInternal).length;
    const totalEmpty = grouped.reduce((s, r) => s + (r.best.emptyKm ?? 0), 0);
    const avg = n ? grouped.reduce((s, r) => s + r.composite, 0) / n : 0;
    return { n, internal, totalEmpty, avg };
  }, [grouped]);

  const internalCount = useMemo(() => loads.filter((l) => l.IS_INTERNAL).length, [loads]);
  const externalCount = loads.length - internalCount;
  const labelNoun = cls?.LABEL_NOUN ?? 'vehicle';

  const kpiStats = useMemo<KpiStat[]>(() => {
    const out: KpiStat[] = [
      { label: `Idle ${labelNoun}s`, value: trailers.length },
      { label: 'Internal loads', value: internalCount },
      { label: 'External offers', value: externalCount },
      { label: 'Eligible pairs', value: eligibleCount },
    ];
    if (grouped.length) {
      out.push({ label: `${labelNoun}s matched`, value: kpis.n, sub: `${ranked.length} graded pairs` });
      out.push({ label: 'Internal filled', value: kpis.internal });
      out.push({ label: 'Empty km (best)', value: kpis.totalEmpty.toFixed(0) });
      out.push({ label: 'Avg score', value: kpis.avg.toFixed(0) });
    }
    return out;
  }, [labelNoun, trailers.length, internalCount, externalCount, eligibleCount, grouped.length, kpis, ranked.length]);

  // --- map data ---
  const mapVehicles = useMemo<MapVehicle[]>(() => trailers
    .filter((t) => okPt(num(t.EMPTY_LON), num(t.EMPTY_LAT)))
    .map((t) => ({ id: t.TRAILER_ID, lon: num(t.EMPTY_LON), lat: num(t.EMPTY_LAT) })), [trailers]);
  const mapLoads = useMemo<MapLoad[]>(() => loads
    .filter((l) => okPt(num(l.PICKUP_LON), num(l.PICKUP_LAT)))
    .map((l) => ({ id: l.LOAD_ID, lon: num(l.PICKUP_LON), lat: num(l.PICKUP_LAT), internal: l.IS_INTERNAL, city: l.PICKUP_CITY, source: l.SOURCE })), [loads]);
  const mapLinks = useMemo<MapLink[]>(() => {
    const out: MapLink[] = [];
    for (const rt of grouped) {
      const t = trailerById.get(rt.best.trailerId);
      const l = loadByLid.get(rt.best.loadId);
      if (!t || !l) continue;
      const from: [number, number] = [num(t.EMPTY_LON), num(t.EMPTY_LAT)];
      const to: [number, number] = [num(l.PICKUP_LON), num(l.PICKUP_LAT)];
      if (okPt(from[0], from[1]) && okPt(to[0], to[1])) out.push({ from, to, key: rt.best.key });
    }
    return out;
  }, [grouped, trailerById, loadByLid]);
  const mapStops = useMemo<MapStop[]>(() => {
    if (!selectedPair) return [];
    const t = trailerById.get(selectedPair.trailerId);
    const l = loadByLid.get(selectedPair.loadId);
    if (!t || !l) return [];
    const s: MapStop[] = [];
    if (okPt(num(t.EMPTY_LON), num(t.EMPTY_LAT))) s.push({ idx: s.length + 1, kind: 'start', pos: [num(t.EMPTY_LON), num(t.EMPTY_LAT)], city: t.EMPTY_CITY });
    if (okPt(num(l.PICKUP_LON), num(l.PICKUP_LAT))) s.push({ idx: s.length + 1, kind: 'pickup', pos: [num(l.PICKUP_LON), num(l.PICKUP_LAT)], city: l.PICKUP_CITY });
    if (okPt(num(l.DELIVERY_LON), num(l.DELIVERY_LAT))) s.push({ idx: s.length + 1, kind: 'delivery', pos: [num(l.DELIVERY_LON), num(l.DELIVERY_LAT)], city: l.DELIVERY_CITY });
    return s;
  }, [selectedPair, trailerById, loadByLid]);
  const routePath = useMemo<[number, number][] | null>(() => {
    if (selectedKey && routeGeo[selectedKey] && routeGeo[selectedKey].length > 1) return routeGeo[selectedKey];
    if (selectedPair?.pathCoords && selectedPair.pathCoords.length > 1) return selectedPair.pathCoords;
    return null;
  }, [selectedKey, routeGeo, selectedPair]);

  // Agent grounding, Channel B. The layers live inside ProposalMap, so describe the
  // semantic arrays this page feeds it rather than reaching into the child: same
  // counts, and it stays correct if the child changes how it draws them. Gated on
  // having any vehicles or loads so a still-loading page publishes null instead of
  // an empty map the agent would report as "nothing to dispatch".
  usePublishMapState(
    useMemo(
      () => {
        const layers = [
          { id: 'vehicles', type: 'scatterplot', featureCount: mapVehicles.length },
          { id: 'loads', type: 'scatterplot', featureCount: mapLoads.length },
          { id: 'proposal-links', type: 'arc', featureCount: mapLinks.length },
          { id: 'selected-stops', type: 'scatterplot', featureCount: mapStops.length },
          { id: 'selected-route', type: 'path', featureCount: routePath ? 1 : 0 },
        ].map((l) => ({ ...l, rendered: l.featureCount > 0 }));
        if (!mapVehicles.length && !mapLoads.length) return null;
        return {
          layerCount: layers.length,
          layers,
          emptyLayers: layers.filter((l) => !l.rendered).map((l) => l.id),
          selection: selectedKey ? { selected_pair: selectedKey } : undefined,
        };
      },
      [mapVehicles.length, mapLoads.length, mapLinks.length, mapStops.length, routePath, selectedKey],
    ),
  );

  // --- agent grounding (ref pattern; publish only on change) ---
  const summary = useMemo(() => {
    const MAX_TRIPS = 12;
    const topList = grouped.slice(0, MAX_TRIPS).map((r) => {
      const margin = r.best.marginUsd != null ? `${r.best.marginUsd >= 0 ? '+' : ''}$${Math.round(r.best.marginUsd)}` : 'n/a';
      const loaded = (r.best.loadedKm ?? r.best.loadedKmEst ?? 0).toFixed(0);
      return `${r.trailerId}->${r.best.loadId} ${r.grade} (${FAMILY_LABELS[r.best.bestSource]}) ${r.best.pickupCity || '?'}->${r.best.deliveryCity || '?'}, empty ${(r.best.emptyKm ?? 0).toFixed(0)}km loaded ${loaded}km, margin ${margin}${r.best.isInternal ? ', internal' : ', external'}`;
    }).join('; ') + (grouped.length > MAX_TRIPS ? ` (+${grouped.length - MAX_TRIPS} more)` : '');
    const acc = Object.values(decisions);
    return {
      view: 'backload_proposals', region: region ?? null,
      perspective, strategy: perspective === 'ensemble' ? 'ensemble' : strategy,
      vehicle_type: cfg?.vehicleType ?? null,
      vehicles_loaded: trailers.length, loads_loaded: loads.length,
      eligible_pairs: eligibleCount || null,
      proposals_run: gradedCount || null,
      vehicles_matched: kpis.n || null,
      internal_matched: grouped.length ? kpis.internal : null,
      total_empty_km: grouped.length ? Math.round(kpis.totalEmpty) : null,
      total_margin_usd: grouped.length ? Math.round(grouped.reduce((s, r) => s + (r.best.marginUsd ?? 0), 0)) : null,
      avg_composite: grouped.length ? Math.round(kpis.avg) : null,
      accepted: acc.filter((d) => d.action === 'ACCEPT').length || null,
      rejected: acc.filter((d) => d.action === 'REJECT').length || null,
      __memo_backload: grouped.length ? topList : null,
    };
  }, [grouped, decisions, region, perspective, strategy, cfg, trailers.length, loads.length, eligibleCount, gradedCount, kpis]);

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const lastSentRef = useRef<string>('');
  useEffect(() => {
    const json = JSON.stringify(summary);
    if (json === lastSentRef.current) return;
    lastSentRef.current = json;
    onStateChangeRef.current?.(summary);
  }, [summary]);

  const runDisabled = !cls || trailers.length === 0;
  const swatch = (c: [number, number, number]) => ({ width: 12, height: 12, borderRadius: 3, background: `rgb(${c[0]},${c[1]},${c[2]})`, display: 'inline-block', flexShrink: 0 });
  const dataReady = trailers.length > 0 || loads.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, height: '100%', overflow: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20, lineHeight: '24px', fontWeight: 700 }}>Backload Proposals</h2>
        {cfg && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{cfg.vehicleType} {'\u00B7'} {cfg.region}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="btn secondary" disabled={!!busy} onClick={() => { setInfo(null); setSolveError(null); load(); }}>Refresh</button>
          <button type="button" className="btn secondary" onClick={() => setLegendOpen(true)}>Legend</button>
        </span>
      </div>

      {loadErr && (
        <div style={{ padding: 12, borderRadius: 8, border: '1px solid var(--border-error)', background: 'var(--surface-error)', color: 'var(--text-error)', fontSize: 13 }}>{loadErr}</div>
      )}

      {/* KPI strip */}
      <KpiStrip stats={kpiStats} />

      {/* Filter + strategy bar */}
      <FilterBar
        filters={filters}
        setFilters={setFilters}
        countries={countries}
        filteredCount={ranked.length}
        totalCount={rankedAll.length}
        maxEmptyKmDefault={maxEmptyKmDefault}
        perspective={perspective}
        onPerspective={setPerspective}
        strategies={STRATEGY_OPTIONS}
        strategy={strategy}
        onStrategyChange={setStrategy}
        onRun={onRun}
        onRunEnsemble={onRunEnsemble}
        busy={!!busy}
        runDisabled={runDisabled}
        ensembleBasis={ensembleBasis}
        onEnsembleBasisChange={setEnsembleBasis}
        ensembleCount={ranked.length}
        uniqueLoads={uniqueLoads}
      />

      {/* Vehicle / load count caps */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'end' }}>
        <label className="control-bar-group">
          <span className="control-bar-label">Max vehicles</span>
          <input type="number" className="sf-input" style={{ width: 72 }} min={1} max={Math.max(1, trailers.length)} value={maxVehicles} onChange={(e) => setMaxVehicles(Number(e.target.value))} />
        </label>
        <label className="control-bar-group">
          <span className="control-bar-label">Max loads</span>
          <input type="number" className="sf-input" style={{ width: 72 }} min={1} max={Math.max(1, loads.length)} value={maxLoads} onChange={(e) => setMaxLoads(Number(e.target.value))} />
        </label>
      </div>

      {/* Status bar */}
      {suspended && (<RoutingSuspendedNotice info={suspended} onRetry={onRun} />)}
      <StatusBar
        busy={busy}
        error={solveError}
        info={info}
        onClearError={() => setSolveError(null)}
        onClearInfo={() => setInfo(null)}
        onClearBusy={() => setBusy(null)}
      />

      {/* Weight sliders - ensemble only */}
      {perspective === 'ensemble' && (
        <WeightSliders weights={weights} onChange={applyWeights} open={weightsOpen} onToggle={() => setWeightsOpen((o) => !o)} consolidationActive={consolidationActive} />
      )}

      {/* Cockpit: master list (left) + map/legend/drawer (right) */}
      {dataReady && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 8, height: 'min(760px, calc(100vh - 320px))', minHeight: 460 }}>
          {perspective === 'ensemble' ? (
            <EnsembleList
              rows={grouped}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              decisions={decisions}
              reasonFor={reasonFor}
              onOpenReason={setReasonFor}
              onDecide={onDecide}
              onExplain={explain}
              chipsFor={chipsFor}
              busy={!!busy}
              consolidationActive={consolidationActive}
              labelNoun={labelNoun}
              ranAt={ranAt}
            />
          ) : perspective === 'loads' ? (
            <LoadList
              rows={ranked}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              decisions={decisions}
              reasonFor={reasonFor}
              onOpenReason={setReasonFor}
              onDecide={onDecide}
              onExplain={explain}
              busy={!!busy}
              ranAt={ranAt}
            />
          ) : (
            <VehicleList
              rows={grouped}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              expanded={expanded}
              onToggleExpand={(id) => setExpanded((e) => (e === id ? null : id))}
              decisions={decisions}
              reasonFor={reasonFor}
              onOpenReason={setReasonFor}
              onDecide={onDecide}
              onExplain={explain}
              chipsFor={chipsFor}
              busy={!!busy}
              labelNoun={labelNoun}
              ranAt={ranAt}
            />
          )}

          <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) auto minmax(0,1fr)', gap: 8, minHeight: 0 }}>
            <ProposalMap
              vehicles={mapVehicles}
              loads={mapLoads}
              links={mapLinks}
              stops={mapStops}
              routePath={routePath}
              focusKey={selectedKey ?? ''}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
              <button type="button" className="btn small secondary" onClick={() => setLegendOpen(true)}>Legend</button>
            </div>
            <DetailDrawer
              pair={selectedPair}
              chips={selectedChips}
              decision={selectedPair ? decisions[selectedPair.key] : undefined}
              reasonFor={reasonFor}
              onOpenReason={setReasonFor}
              onDecide={onDecide}
              onExplain={explain}
              rationale={selectedPair ? rationaleByKey[selectedPair.key] ?? null : null}
              explaining={explaining}
              busy={!!busy}
              labelNoun={labelNoun}
            />
          </div>
        </div>
      )}

      <LegendOverlay open={legendOpen} onClose={() => setLegendOpen(false)} title="Legend">
        <LegendSection title="Map symbols">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span style={swatch(COLOR_VEHICLE)} />Idle {labelNoun} (empty)</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span style={swatch(COLOR_INTERNAL)} />Internal load</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span style={swatch(COLOR_EXTERNAL)} />External offer</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span style={{ width: 16, height: 0, borderTop: `3px dashed rgb(${COLOR_LEG_EMPTY.join(',')})`, display: 'inline-block' }} />Empty leg - repositioning (no revenue)</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><span style={{ width: 16, height: 3, background: 'rgb(29,78,216)', display: 'inline-block' }} />Loaded route - pickup to delivery (revenue)</span>
            <span>Selected route stops: (1) start {'\u2192'} (2) pickup {'\u2192'} (3) delivery.</span>
          </div>
        </LegendSection>
      </LegendOverlay>
    </div>
  );
}
