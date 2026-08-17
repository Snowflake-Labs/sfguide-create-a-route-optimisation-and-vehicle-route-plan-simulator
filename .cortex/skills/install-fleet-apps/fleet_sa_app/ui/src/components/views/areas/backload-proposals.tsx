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
import type { ViewProps } from '@/lib/types';
import {
  computeScoredPairs, rankByWeights, groupByTrailer, loadWeights, saveWeights,
  DEFAULT_WEIGHTS, FAMILY_LABELS,
  type ProposalRow, type ParamRow, type TrailerLoc, type EnsembleWeights,
  type StrategyFamily,
} from './backload-ensemble';
import { sqlLiteral } from './backload-matching/helpers';
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
  AVG_SPEED_KMH: number; COST_EUR_PER_KM: number; HOME_RANGE_KM: number; LABEL_NOUN: string;
}
interface ScoredCandidate {
  TRAILER_ID: string; LOAD_ID: string;
  DIST_CHECK: boolean; TIME_CHECK: boolean; HORIZON_CHECK: boolean;
  CAP_CHECK: boolean; HAZMAT_CHECK: boolean; ELIGIBLE: boolean;
}

const COST_SCALE = 100;

// Single-strategy options (non-ensemble perspectives).
const STRATEGY_OPTIONS: StrategyOption[] = [
  { key: 'baseline', label: 'Quick scan - nearest load' },
  { key: 'vrp', label: 'Per-load VRP (road)' },
  { key: 'fleet', label: 'Fleet 1:1 (road)' },
  { key: 'bpmp', label: 'Profit-max backhaul (road)' },
];

function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371, toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

async function sfRead(sql: string): Promise<Record<string, unknown>[]> {
  const res = await fetch('/api/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  const rows = (body.rows as Record<string, unknown>[]) || [];
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(r)) o[k.toUpperCase()] = r[k];
    return o;
  });
}

async function apiSolve(challenge: object, region: string): Promise<Record<string, unknown> | null> {
  const res = await fetch('/api/backload/solve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge, region }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return (body.result as Record<string, unknown>) ?? null;
}

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
  const [scored, setScored] = useState<ScoredCandidate[]>([]);
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
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
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
      const cfgRegion = String(c?.REGION ?? region ?? 'SanFrancisco');
      setCfg({ vehicleType, region: cfgRegion });

      const [clsRows, tRows, lRows, scRows, pRows] = await Promise.all([
        sfRead(`SELECT * FROM ${BM}.VW_VEHICLE_CLASS WHERE VEHICLE_TYPE = '${sqlLiteral(vehicleType)}' LIMIT 1`),
        sfRead(`SELECT TRAILER_ID, OPERATING_COUNTRY, HOME_LON, HOME_LAT, EMPTY_CITY, EMPTY_LON, EMPTY_LAT, EMPTY_FROM_TS, NEXT_START_LON, NEXT_START_LAT, MAX_PAYLOAD_KG, HAZMAT_CERT FROM ${PHYS}.VW_TRAILERS_GEO`),
        sfRead(`SELECT LOAD_ID, IS_INTERNAL, SOURCE, PICKUP_CITY, PICKUP_LON, PICKUP_LAT, DELIVERY_CITY, DELIVERY_LON, DELIVERY_LAT, REQUESTED_PICKUP_TS, WEIGHT_KG, PRODUCT, HAZMAT, PRICE_USD, APPROX_DISTANCE_KM FROM ${PHYS}.VW_LOADS`),
        sfRead(`SELECT TRAILER_ID, LOAD_ID, DIST_CHECK, TIME_CHECK, HORIZON_CHECK, CAP_CHECK, HAZMAT_CHECK, ELIGIBLE FROM ${PHYS}.VW_CANDIDATES_SCORED WHERE ELIGIBLE = TRUE`),
        sfRead(`SELECT PARAM_KEY, PARAM_VALUE FROM ${PHYS}.MATCH_PARAMS`),
      ]);
      setCls((clsRows[0] as unknown as VehicleClass) ?? null);
      setTrailers(tRows as unknown as Trailer[]);
      setLoads(lRows as unknown as Load[]);
      setScored(scRows as unknown as ScoredCandidate[]);
      setParams(pRows as unknown as ParamRow[]);
    } catch (e) {
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

  const eligibleSet = useMemo(() => {
    const s = new Set<string>();
    for (const c of scored) if (c.ELIGIBLE) s.add(`${c.TRAILER_ID}::${c.LOAD_ID}`);
    return s;
  }, [scored]);

  // Build the VROOM challenge for a strategy family.
  const buildChallenge = useCallback((fam: StrategyFamily) => {
    if (!cls) return null;
    const profile = cls.ORS_PROFILE;
    const classCapacityKg = cls.PAYLOAD_KG_TYP || 1000;
    const effPerKm = cls.COST_EUR_PER_KM || 0.85;
    const maxStops = fam === 'bpmp' ? 4 : fam === 'vrp' ? 1 : 2;

    const idToTrailer = new Map<number, Trailer>();
    const vehicles = trailers.slice(0, maxVehicles).map((t, i) => {
      const id = i + 1;
      idToTrailer.set(id, t);
      return {
        id, profile,
        start: [num(t.EMPTY_LON), num(t.EMPTY_LAT)],
        end: [num(t.NEXT_START_LON), num(t.NEXT_START_LAT)],
        capacity: [num(t.MAX_PAYLOAD_KG) || classCapacityKg],
        skills: t.HAZMAT_CERT ? [1, 2, 3] : [1, 2],
        max_tasks: maxStops,
        costs: { fixed: 120 * COST_SCALE, per_km: Math.round(effPerKm * COST_SCALE) },
      } as Record<string, unknown>;
    });

    const idToLoad = new Map<number, Load>();
    let nextId = 1000;
    const shipments: Record<string, unknown>[] = [];
    for (const l of loads.slice(0, maxLoads)) {
      const id = nextId++;
      idToLoad.set(id, l);
      const kg = Math.min(num(l.WEIGHT_KG), classCapacityKg);
      let priority = l.IS_INTERNAL ? 90 : 10;
      if (fam === 'bpmp') {
        const rev = l.PRICE_USD != null ? num(l.PRICE_USD) : num(l.APPROX_DISTANCE_KM) * 1.1;
        priority = Math.max(1, Math.min(100, Math.round(rev / 25)));
      }
      shipments.push({
        pickup: { id, location: [num(l.PICKUP_LON), num(l.PICKUP_LAT)], service: 1800 },
        delivery: { id, location: [num(l.DELIVERY_LON), num(l.DELIVERY_LAT)], service: 600 },
        amount: [kg],
        skills: l.HAZMAT ? (l.IS_INTERNAL ? [1, 3] : [2, 3]) : (l.IS_INTERNAL ? [1] : [2]),
        priority,
      });
    }
    return { challenge: { vehicles, shipments, options: { g: true } }, idToTrailer, idToLoad };
  }, [cls, trailers, loads, maxVehicles, maxLoads]);

  const parseSolve = useCallback((
    resp: Record<string, unknown> | null, fam: StrategyFamily,
    idToTrailer: Map<number, Trailer>, idToLoad: Map<number, Load>,
  ): ProposalRow[] => {
    const basis = fam === 'vrp' ? 'vrp_road' : fam === 'fleet' ? 'fleet_vrp' : fam === 'bpmp' ? 'bpmp' : 'great_circle';
    const routes = Array.isArray(resp?.routes) ? (resp!.routes as Record<string, unknown>[]) : [];
    const out: ProposalRow[] = [];
    for (const route of routes) {
      const t = idToTrailer.get(Number(route.vehicle));
      if (!t) continue;
      const geom = Array.isArray(route.geometry) && (route.geometry as unknown[]).length > 1 ? (route.geometry as [number, number][]) : null;
      const steps = Array.isArray(route.steps) ? (route.steps as Record<string, unknown>[]) : [];
      const pickups = steps.filter((s) => s.type === 'pickup');
      let seq = 0;
      for (const s of pickups) {
        const l = idToLoad.get(Number(s.id));
        if (!l) continue;
        seq += 1;
        const emptyKm = haversineKm(num(t.EMPTY_LON), num(t.EMPTY_LAT), num(l.PICKUP_LON), num(l.PICKUP_LAT));
        const loadedKm = haversineKm(num(l.PICKUP_LON), num(l.PICKUP_LAT), num(l.DELIVERY_LON), num(l.DELIVERY_LAT));
        const nextKm = haversineKm(num(l.DELIVERY_LON), num(l.DELIVERY_LAT), num(t.NEXT_START_LON), num(t.NEXT_START_LAT));
        const baselineKm = haversineKm(num(t.EMPTY_LON), num(t.EMPTY_LAT), num(t.NEXT_START_LON), num(t.NEXT_START_LAT));
        const totalKm = emptyKm + loadedKm + nextKm;
        out.push({
          PROPOSAL_ID: `${fam}:${t.TRAILER_ID}:${l.LOAD_ID}`,
          TRAILER_ID: t.TRAILER_ID, LOAD_ID: l.LOAD_ID, DISTANCE_BASIS: basis,
          EMPTY_KM: emptyKm, LOADED_KM: loadedKm, DETOUR_KM: Math.max(0, totalKm - loadedKm - baselineKm),
          TOTAL_KM: totalKm, PICKUP_SLACK_HRS: null, FEASIBLE: true, STOP_SEQ: fam === 'bpmp' ? seq : null,
          PICKUP_LON: num(l.PICKUP_LON), PICKUP_LAT: num(l.PICKUP_LAT),
          DELIVERY_LON: num(l.DELIVERY_LON), DELIVERY_LAT: num(l.DELIVERY_LAT),
          PICKUP_CITY: l.PICKUP_CITY, PICKUP_COUNTRY: t.OPERATING_COUNTRY,
          DELIVERY_CITY: l.DELIVERY_CITY, EMPTY_CITY: t.EMPTY_CITY,
          IS_INTERNAL: l.IS_INTERNAL, SOURCE: l.SOURCE,
          PATH_COORDS: geom,
        });
      }
    }
    return out;
  }, []);

  const baselineProposals = useCallback((): ProposalRow[] => {
    const out: ProposalRow[] = [];
    for (const t of trailers.slice(0, maxVehicles)) {
      let best: { l: Load; km: number } | null = null;
      for (const l of loads.slice(0, maxLoads)) {
        if (eligibleSet.size && !eligibleSet.has(`${t.TRAILER_ID}::${l.LOAD_ID}`)) continue;
        const km = haversineKm(num(t.EMPTY_LON), num(t.EMPTY_LAT), num(l.PICKUP_LON), num(l.PICKUP_LAT));
        if (!best || km < best.km) best = { l, km };
      }
      if (!best) continue;
      const l = best.l;
      const loadedKm = haversineKm(num(l.PICKUP_LON), num(l.PICKUP_LAT), num(l.DELIVERY_LON), num(l.DELIVERY_LAT));
      out.push({
        PROPOSAL_ID: `baseline:${t.TRAILER_ID}:${l.LOAD_ID}`,
        TRAILER_ID: t.TRAILER_ID, LOAD_ID: l.LOAD_ID, DISTANCE_BASIS: 'great_circle',
        EMPTY_KM: best.km, LOADED_KM: loadedKm, DETOUR_KM: null, TOTAL_KM: best.km + loadedKm,
        PICKUP_SLACK_HRS: null, FEASIBLE: true, STOP_SEQ: null,
        PICKUP_LON: num(l.PICKUP_LON), PICKUP_LAT: num(l.PICKUP_LAT),
        DELIVERY_LON: num(l.DELIVERY_LON), DELIVERY_LAT: num(l.DELIVERY_LAT),
        PICKUP_CITY: l.PICKUP_CITY, PICKUP_COUNTRY: t.OPERATING_COUNTRY,
        DELIVERY_CITY: l.DELIVERY_CITY, EMPTY_CITY: t.EMPTY_CITY,
        IS_INTERNAL: l.IS_INTERNAL, SOURCE: l.SOURCE,
        PATH_COORDS: null,
      });
    }
    return out;
  }, [trailers, loads, maxVehicles, maxLoads, eligibleSet]);

  const runFamilies = useCallback(async (families: StrategyFamily[]) => {
    if (!cfg || !cls) return;
    setBusy('Generating proposals\u2026'); setSolveError(null); setInfo(null);
    setProposals([]); setDecisions({}); setSelectedKey(null); setRouteGeo({}); setRationaleByKey({});
    try {
      const all: ProposalRow[] = [];
      for (const fam of families) {
        if (fam === 'baseline') { all.push(...baselineProposals()); continue; }
        const built = buildChallenge(fam);
        if (!built || !built.challenge.vehicles.length || !built.challenge.shipments.length) continue;
        setBusy(`Solving ${FAMILY_LABELS[fam]}\u2026`);
        const resp = await apiSolve(built.challenge, cfg.region);
        all.push(...parseSolve(resp, fam, built.idToTrailer, built.idToLoad));
      }
      if (!all.length) setSolveError('No proposals produced. Ensure the routing service is running for this region and that vehicles/loads exist for the active preset.');
      else setInfo(families.length > 1 ? `Ensemble complete - ${families.length} strategies graded. Tune the scoring weights to re-rank instantly.` : 'Match complete.');
      setProposals(all);
      setRanAt(Date.now());
    } catch (e) {
      setSolveError(e instanceof Error ? e.message : 'Solve failed');
    } finally { setBusy(null); }
  }, [cfg, cls, baselineProposals, buildChallenge, parseSolve]);

  const onRun = useCallback(() => runFamilies([strategy as StrategyFamily]), [runFamilies, strategy]);
  const onRunEnsemble = useCallback(() => runFamilies(ensembleBasis === 'road' ? ['baseline', 'vrp', 'fleet', 'bpmp'] : ['baseline']), [runFamilies, ensembleBasis]);

  // Ensemble scoring pipeline (client-side, re-ranks on weight change).
  const trailerLocs = useMemo<TrailerLoc[]>(() => trailers.map((t) => ({ TRAILER_ID: t.TRAILER_ID, EMPTY_FROM_TS: t.EMPTY_FROM_TS })), [trailers]);
  const scoredPairs = useMemo(() => computeScoredPairs(proposals, params, trailerLocs), [proposals, params, trailerLocs]);
  const rankedAll = useMemo(() => rankByWeights(scoredPairs, weights), [scoredPairs, weights]);
  const consolidationActive = useMemo(() => scoredPairs.some((p) => p.scores.consolidation != null), [scoredPairs]);

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
  const chipsFor = useCallback((trailerId: string, loadId: string): ChipDef[] => {
    const c = scored.find((x) => x.TRAILER_ID === trailerId && x.LOAD_ID === loadId);
    if (!c) return [];
    return [
      { label: 'Distance', ok: c.DIST_CHECK }, { label: 'Pickup time', ok: c.TIME_CHECK },
      { label: 'Horizon', ok: c.HORIZON_CHECK }, { label: 'Capacity', ok: c.CAP_CHECK },
      { label: 'Hazmat', ok: c.HAZMAT_CHECK },
    ];
  }, [scored]);
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
      { label: 'Eligible pairs', value: eligibleSet.size },
    ];
    if (grouped.length) {
      out.push({ label: `${labelNoun}s matched`, value: kpis.n, sub: `${ranked.length} graded pairs` });
      out.push({ label: 'Internal filled', value: kpis.internal });
      out.push({ label: 'Empty km (best)', value: kpis.totalEmpty.toFixed(0) });
      out.push({ label: 'Avg score', value: kpis.avg.toFixed(0) });
    }
    return out;
  }, [labelNoun, trailers.length, internalCount, externalCount, eligibleSet.size, grouped.length, kpis, ranked.length]);

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

  // --- agent grounding (ref pattern; publish only on change) ---
  const summary = useMemo(() => {
    const topList = grouped.slice(0, 12).map((r) => `${r.trailerId}->${r.best.loadId} ${r.grade} (${FAMILY_LABELS[r.best.bestSource]}, empty ${(r.best.emptyKm ?? 0).toFixed(0)}km${r.best.isInternal ? ', internal' : ', external'})`).join('; ');
    const acc = Object.values(decisions);
    return {
      view: 'backload_proposals', region: region ?? null,
      perspective, strategy: perspective === 'ensemble' ? 'ensemble' : strategy,
      vehicle_type: cfg?.vehicleType ?? null,
      vehicles_loaded: trailers.length, loads_loaded: loads.length,
      eligible_pairs: eligibleSet.size || null,
      proposals_run: proposals.length || null,
      vehicles_matched: kpis.n || null,
      internal_matched: grouped.length ? kpis.internal : null,
      total_empty_km: grouped.length ? Math.round(kpis.totalEmpty) : null,
      avg_composite: grouped.length ? Math.round(kpis.avg) : null,
      accepted: acc.filter((d) => d.action === 'ACCEPT').length || null,
      rejected: acc.filter((d) => d.action === 'REJECT').length || null,
      __memo_backload: grouped.length ? topList : null,
    };
  }, [grouped, decisions, region, perspective, strategy, cfg, trailers.length, loads.length, eligibleSet.size, proposals.length, kpis]);

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
