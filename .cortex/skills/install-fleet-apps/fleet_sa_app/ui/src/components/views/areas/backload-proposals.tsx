'use client';

// Tier-3 showcase: Backload Proposals cockpit (neutral, industry-agnostic).
//
// The advanced sibling of Backload Matching. Instead of a single solve it runs a
// selectable set of optimizer STRATEGIES over the same neutral, synthetic-backed
// FLEET_APP.BACKLOAD_MATCHING views, then (in ensemble mode) fuses them into one
// graded recommendation per vehicle:
//   - Quick scan     nearest waiting load per idle vehicle (client-side, no solve)
//   - Per-load VRP   VROOM, one load per vehicle (max_tasks=1)
//   - Fleet 1:1      VROOM shipments, internal-first priority
//   - Profit-max     VROOM, multi-stop consolidation + revenue-scaled priority
// Ensemble scoring (backload-ensemble.ts) de-duplicates to one pair per
// (vehicle, load), scores 7 dimensions, grades A..F, and re-ranks instantly on
// dispatcher weight sliders. Per-constraint pass/fail chips come from
// VW_CANDIDATES_SCORED; a Cortex rationale explains the top matches. Accept /
// Reject / Flag decisions are session-only (no write-back). Solves reuse the
// robust /api/backload/solve raw-scalar contract seam. No vendor branding.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RouteMapInline } from '@/components/inline/route-map-inline';
import { useAppStore } from '@/lib/store';
import type { ViewProps } from '@/lib/types';
import {
  computeScoredPairs, rankByWeights, groupByTrailer, loadWeights, saveWeights,
  WEIGHT_PRESETS, DEFAULT_WEIGHTS, DIMENSIONS, DIMENSION_LABELS, FAMILY_LABELS,
  familyOf, gradeColor,
  type ProposalRow, type ParamRow, type TrailerLoc, type EnsembleWeights,
  type RankedTrailer, type StrategyFamily,
} from './backload-ensemble';

const BM = 'FLEET_APP.BACKLOAD_MATCHING';
const PHYS = 'FLEET_INTELLIGENCE.BACKLOAD_MATCHING';

type StrategyKey = StrategyFamily | 'ensemble';
const STRATEGY_OPTIONS: { key: StrategyKey; label: string; hint: string }[] = [
  { key: 'ensemble', label: 'Ensemble (all strategies)', hint: 'Run every strategy and fuse into one graded recommendation per vehicle.' },
  { key: 'baseline', label: 'Quick scan', hint: 'Nearest waiting load per idle vehicle (great-circle, no solve).' },
  { key: 'vrp', label: 'Per-load VRP', hint: 'VROOM road solve, one load per vehicle.' },
  { key: 'fleet', label: 'Fleet 1:1', hint: 'VROOM road solve, internal loads ranked first.' },
  { key: 'bpmp', label: 'Profit-max backhaul', hint: 'VROOM multi-stop consolidation, revenue-scaled priority.' },
];

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
type Decision = 'ACCEPT' | 'REJECT' | 'FLAG';

const COST_SCALE = 100;

// Map marker/leg colors (read per-feature by RouteMapInline).
const COL_TRAILER: [number, number, number, number] = [37, 99, 235, 200];
const COL_INTERNAL: [number, number, number, number] = [22, 163, 74, 200];
const COL_EXTERNAL: [number, number, number, number] = [217, 119, 6, 200];
const COL_ROUTE: [number, number, number, number] = [37, 99, 235, 150];
const COL_ROUTE_SEL: [number, number, number, number] = [29, 78, 216, 255];

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
  // /api/query returns column keys lowercased; normalize to UPPERCASE so the
  // view's uppercase field access (t.EMPTY_LON, l.LOAD_ID etc.) resolves.
  // Without this, coords read as undefined -> NaN -> VROOM "Invalid start array".
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

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function BackloadProposalsView({ onStateChange }: Partial<ViewProps> = {}) {
  const region = useAppStore((s) => s.context['region']) as string | undefined;

  const [cfg, setCfg] = useState<{ vehicleType: string; region: string } | null>(null);
  const [cls, setCls] = useState<VehicleClass | null>(null);
  const [trailers, setTrailers] = useState<Trailer[]>([]);
  const [loads, setLoads] = useState<Load[]>([]);
  const [scored, setScored] = useState<ScoredCandidate[]>([]);
  const [params, setParams] = useState<ParamRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [strategy, setStrategy] = useState<StrategyKey>('ensemble');
  const [maxVehicles, setMaxVehicles] = useState(20);
  const [maxLoads, setMaxLoads] = useState(120);
  const [weights, setWeights] = useState<EnsembleWeights>(DEFAULT_WEIGHTS);
  const [preset, setPreset] = useState<string>('Balanced');

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [solveError, setSolveError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [ranAt, setRanAt] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [rationale, setRationale] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);

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
        sfRead(`SELECT * FROM ${BM}.VW_VEHICLE_CLASS WHERE VEHICLE_TYPE = '${vehicleType.replace(/'/g, "''")}' LIMIT 1`),
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
      setLoadErr(e instanceof Error ? e.message : 'Failed to load backload data');
    }
  }, [region]);

  useEffect(() => { load(); }, [load]);

  // Slack (hours) lookup per (trailer, load) from the scored candidates - drives
  // the feasibility dimension in the ensemble scorer.
  const slackByPair = useMemo(() => {
    const m = new Map<string, number>();
    // scored view is filtered to ELIGIBLE here; slack is not selected, so we
    // approximate feasibility=true for eligible pairs and leave slack null.
    return m;
  }, [scored]);

  const eligibleSet = useMemo(() => {
    const s = new Set<string>();
    for (const c of scored) if (c.ELIGIBLE) s.add(`${c.TRAILER_ID}::${c.LOAD_ID}`);
    return s;
  }, [scored]);

  // Build the VROOM challenge for a strategy. Returns the challenge plus the
  // id->trailer / id->load lookups so the response can be parsed back to pairs.
  const buildChallenge = useCallback((fam: StrategyFamily) => {
    if (!cls) return null;
    const profile = cls.ORS_PROFILE;
    const classCapacityKg = cls.PAYLOAD_KG_TYP || 1000;
    const effPerKm = cls.COST_EUR_PER_KM || 0.85;
    const maxStops = fam === 'bpmp' ? 4 : fam === 'vrp' ? 1 : 2;

    const trailerById = new Map<number, Trailer>();
    const vehicles = trailers.slice(0, maxVehicles).map((t, i) => {
      const id = i + 1;
      trailerById.set(id, t);
      const veh: Record<string, unknown> = {
        id, profile,
        start: [num(t.EMPTY_LON), num(t.EMPTY_LAT)],
        end: [num(t.NEXT_START_LON), num(t.NEXT_START_LAT)],
        capacity: [num(t.MAX_PAYLOAD_KG) || classCapacityKg],
        skills: t.HAZMAT_CERT ? [1, 2, 3] : [1, 2],
        max_tasks: maxStops,
        costs: { fixed: 120 * COST_SCALE, per_km: Math.round(effPerKm * COST_SCALE) },
      };
      return veh;
    });

    const loadById = new Map<number, Load>();
    let nextId = 1000;
    const shipments: Record<string, unknown>[] = [];
    for (const l of loads.slice(0, maxLoads)) {
      const id = nextId++;
      loadById.set(id, l);
      const kg = Math.min(num(l.WEIGHT_KG), classCapacityKg);
      // Priority: internal-first for fleet; revenue-scaled for profit-max; flat otherwise.
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
    const challenge = { vehicles, shipments, options: { g: true } };
    return { challenge, trailerById, loadById };
  }, [cls, trailers, loads, maxVehicles, maxLoads]);

  // Parse a VROOM response into ProposalRows for a family. STOP_SEQ tracks the
  // multi-stop position (profit-max). Distances are great-circle (consistent
  // with the Backload Matching view) so cards never depend on step km echoes.
  const parseSolve = useCallback((
    resp: Record<string, unknown> | null, fam: StrategyFamily,
    trailerById: Map<number, Trailer>, loadById: Map<number, Load>,
  ): ProposalRow[] => {
    const basis = fam === 'vrp' ? 'vrp_road' : fam === 'fleet' ? 'fleet_vrp' : fam === 'bpmp' ? 'bpmp' : 'great_circle';
    const routes = Array.isArray(resp?.routes) ? (resp!.routes as Record<string, unknown>[]) : [];
    const out: ProposalRow[] = [];
    for (const route of routes) {
      const t = trailerById.get(Number(route.vehicle));
      if (!t) continue;
      // Actual road path for this vehicle's whole tour ([lon,lat][], decoded by
      // the routing gateway). Shared by every proposal derived from this route;
      // null-guarded so a geometry-less response falls back to straight legs.
      const geom = Array.isArray(route.geometry) && (route.geometry as unknown[]).length > 1
        ? (route.geometry as [number, number][])
        : null;
      const steps = Array.isArray(route.steps) ? (route.steps as Record<string, unknown>[]) : [];
      const pickups = steps.filter((s) => s.type === 'pickup');
      let seq = 0;
      for (const s of pickups) {
        const l = loadById.get(Number(s.id));
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

  // Quick scan: nearest eligible load per vehicle, purely client-side.
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

  const run = useCallback(async () => {
    if (!cfg || !cls) return;
    setBusy(true); setSolveError(null); setRationale(null); setNotice(null);
    setProposals([]); setDecisions({}); setSelectedKey(null);
    try {
      const families: StrategyFamily[] = strategy === 'ensemble'
        ? ['baseline', 'vrp', 'fleet', 'bpmp'] : [strategy];
      const all: ProposalRow[] = [];
      for (const fam of families) {
        if (fam === 'baseline') { all.push(...baselineProposals()); continue; }
        const built = buildChallenge(fam);
        if (!built || !built.challenge.vehicles.length || !built.challenge.shipments.length) continue;
        setNotice(`Solving ${FAMILY_LABELS[fam]}...`);
        const resp = await apiSolve(built.challenge, cfg.region);
        all.push(...parseSolve(resp, fam, built.trailerById, built.loadById));
      }
      if (!all.length) setSolveError('No proposals produced. Ensure the routing service is running for this region and that trailers/loads exist for the active preset.');
      setProposals(all);
      setRanAt(Date.now());
    } catch (e) {
      setSolveError(e instanceof Error ? e.message : 'Solve failed');
    } finally { setBusy(false); setNotice(null); }
  }, [cfg, cls, strategy, baselineProposals, buildChallenge, parseSolve]);

  // Ensemble scoring pipeline (client-side, re-ranks on weight change).
  const trailerLocs = useMemo<TrailerLoc[]>(
    () => trailers.map((t) => ({ TRAILER_ID: t.TRAILER_ID, EMPTY_FROM_TS: t.EMPTY_FROM_TS })), [trailers]);
  const scoredPairs = useMemo(
    () => computeScoredPairs(proposals, params, trailerLocs), [proposals, params, trailerLocs]);
  const ranked = useMemo(() => groupByTrailer(rankByWeights(scoredPairs, weights)), [scoredPairs, weights]);

  const applyPreset = useCallback((name: string) => {
    setPreset(name);
    const w = WEIGHT_PRESETS[name] ?? DEFAULT_WEIGHTS;
    setWeights(w); saveWeights(w);
  }, []);
  const setWeight = useCallback((d: keyof EnsembleWeights, v: number) => {
    setPreset('Custom');
    setWeights((prev) => { const next = { ...prev, [d]: v }; saveWeights(next); return next; });
  }, []);

  // Map: empty + loaded legs for the best pair of each vehicle.
  // Map: ALWAYS show colored base markers (idle vehicles, internal loads,
  // external offers) so the estate is visible on open; overlay the best-pair
  // empty (grey) + loaded (blue) legs once proposals are ranked. RouteMapInline
  // reads properties.color / properties.lineColor per feature.
  const mapResult = useMemo(() => {
    const features: GeoJSON.Feature[] = [];
    const okPt = (lon: number, lat: number) => Number.isFinite(lon) && Number.isFinite(lat) && !(lon === 0 && lat === 0);
    for (const t of trailers) {
      const lon = num(t.EMPTY_LON), lat = num(t.EMPTY_LAT);
      if (okPt(lon, lat)) features.push({ type: 'Feature', properties: { kind: 'vehicle', name: t.TRAILER_ID, color: COL_TRAILER }, geometry: { type: 'Point', coordinates: [lon, lat] } });
    }
    for (const l of loads) {
      const lon = num(l.PICKUP_LON), lat = num(l.PICKUP_LAT);
      if (okPt(lon, lat)) features.push({ type: 'Feature', properties: { kind: l.IS_INTERNAL ? 'internal' : 'offer', name: l.PICKUP_CITY, category: l.SOURCE, color: l.IS_INTERNAL ? COL_INTERNAL : COL_EXTERNAL }, geometry: { type: 'Point', coordinates: [lon, lat] } });
    }
    const loadByIdMap = new Map(loads.map((l) => [l.LOAD_ID, l]));
    const trailerByIdMap = new Map(trailers.map((t) => [t.TRAILER_ID, t]));
    const hasSel = selectedKey != null;
    for (const rt of ranked) {
      const p = rt.best; const l = loadByIdMap.get(p.loadId); const t = trailerByIdMap.get(p.trailerId);
      if (!l || !t) continue;
      const sel = selectedKey === p.key;
      const coords = p.pathCoords && p.pathCoords.length > 1
        ? p.pathCoords
        : [[num(t.EMPTY_LON), num(t.EMPTY_LAT)], [num(l.PICKUP_LON), num(l.PICKUP_LAT)], [num(l.DELIVERY_LON), num(l.DELIVERY_LAT)]];
      features.push({
        type: 'Feature',
        properties: {
          leg: 'route', name: `${p.trailerId} -> ${p.loadId}`, selKey: p.key,
          lineColor: sel ? COL_ROUTE_SEL : (hasSel ? [37, 99, 235, 70] : COL_ROUTE),
          lineWidth: sel ? 6 : 3,
        },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
    return { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection;
  }, [ranked, loads, trailers, selectedKey]);

  // Camera-fit override: when a proposal is selected, frame its route only.
  const selectedCoords = useMemo<[number, number][] | undefined>(() => {
    if (!selectedKey) return undefined;
    const rt = ranked.find((r) => r.best.key === selectedKey);
    if (!rt) return undefined;
    const p = rt.best;
    if (p.pathCoords && p.pathCoords.length > 1) return p.pathCoords;
    const l = loads.find((x) => x.LOAD_ID === p.loadId);
    const t = trailers.find((x) => x.TRAILER_ID === p.trailerId);
    if (!l || !t) return undefined;
    return [[num(t.EMPTY_LON), num(t.EMPTY_LAT)], [num(l.PICKUP_LON), num(l.PICKUP_LAT)], [num(l.DELIVERY_LON), num(l.DELIVERY_LAT)]];
  }, [selectedKey, ranked, loads, trailers]);

  // Per-pair constraint chips from the scored candidates (eligible-only load).
  const chipsFor = useCallback((trailerId: string, loadId: string) => {
    const c = scored.find((x) => x.TRAILER_ID === trailerId && x.LOAD_ID === loadId);
    if (!c) return [];
    return [
      { label: 'Distance', ok: c.DIST_CHECK }, { label: 'Pickup time', ok: c.TIME_CHECK },
      { label: 'Horizon', ok: c.HORIZON_CHECK }, { label: 'Capacity', ok: c.CAP_CHECK },
      { label: 'Hazmat', ok: c.HAZMAT_CHECK },
    ];
  }, [scored]);

  const kpis = useMemo(() => {
    const n = ranked.length;
    const internal = ranked.filter((r) => r.best.isInternal).length;
    const totalEmpty = ranked.reduce((s, r) => s + (r.best.emptyKm ?? 0), 0);
    const avgGrade = n ? ranked.reduce((s, r) => s + r.composite, 0) / n : 0;
    return { n, internal, totalEmpty, avgGrade };
  }, [ranked]);

  const explain = useCallback(async () => {
    if (!ranked.length) return;
    setExplaining(true);
    try {
      const top = ranked.slice(0, 8).map((r) =>
        `${r.trailerId} -> ${r.best.loadId} (${FAMILY_LABELS[r.best.bestSource]}, ${r.grade}, empty ${(r.best.emptyKm ?? 0).toFixed(0)}km${r.best.isInternal ? ', internal' : ''})`).join('; ');
      const prompt = `You are a fleet dispatch assistant. In 3 short sentences, explain why these backload proposals reduce empty running and improve asset utilization, and note the internal-first preference: ${top}`.replace(/'/g, "''");
      const rows = await sfRead(`SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${prompt}') AS R`);
      setRationale(String((rows[0] as { R?: string })?.R ?? '').trim());
    } catch (e) {
      setRationale(e instanceof Error ? e.message : 'Rationale unavailable');
    } finally { setExplaining(false); }
  }, [ranked]);

  // Publish a compact, scalar-only summary into panel context for the agent.
  const summary = useMemo(() => {
    const topList = ranked.slice(0, 12).map((r) =>
      `${r.trailerId}->${r.best.loadId} ${r.grade} (${FAMILY_LABELS[r.best.bestSource]}, empty ${(r.best.emptyKm ?? 0).toFixed(0)}km${r.best.isInternal ? ', internal' : ', external'})`).join('; ');
    const acc = Object.values(decisions);
    return {
      view: 'backload_proposals', region: region ?? null,
      strategy, vehicle_type: cfg?.vehicleType ?? null,
      trailers_loaded: trailers.length, loads_loaded: loads.length,
      eligible_pairs: eligibleSet.size || null,
      proposals_run: proposals.length || null,
      vehicles_matched: kpis.n || null,
      internal_matched: ranked.length ? kpis.internal : null,
      total_empty_km: ranked.length ? Math.round(kpis.totalEmpty) : null,
      avg_composite: ranked.length ? Math.round(kpis.avgGrade) : null,
      accepted: acc.filter((d) => d === 'ACCEPT').length || null,
      rejected: acc.filter((d) => d === 'REJECT').length || null,
      __memo_backload: ranked.length ? topList : null,
    };
  }, [ranked, decisions, region, strategy, cfg, trailers.length, loads.length, eligibleSet.size, proposals.length, kpis]);

  // onStateChange is held in a ref (its identity changes every render, since the
  // panel passes a fresh inline fn), and we only publish when the serialized
  // summary actually changes. This avoids the store write-back -> re-render ->
  // effect loop that otherwise throws React #185 (max update depth).
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const lastSentRef = useRef<string>('');
  useEffect(() => {
    const json = JSON.stringify(summary);
    if (json === lastSentRef.current) return;
    lastSentRef.current = json;
    onStateChangeRef.current?.(summary);
  }, [summary]);

  // ---- styles ----
  const label = { fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #6b7280)', textTransform: 'uppercase' as const, marginBottom: 2, display: 'block' };
  const card: React.CSSProperties = { padding: 12, borderRadius: 8, border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)' };
  const btn = (enabled: boolean): React.CSSProperties => ({ padding: '8px 16px', fontSize: 13, fontWeight: 600, borderRadius: 6, border: 'none', cursor: enabled ? 'pointer' : 'not-allowed', backgroundColor: 'var(--surface-accent-strong, #2563eb)', color: '#fff', opacity: enabled ? 1 : 0.6 });
  const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 6, border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)' };

  const strategyHint = STRATEGY_OPTIONS.find((s) => s.key === strategy)?.hint ?? '';

  // Shared height for the 50/50 results row: scrollable proposal list (left) and
  // map (right) are the same height; the list scrolls internally.
  const SPLIT_H = 560;

  const legend = (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary, #6b7280)', margin: '2px 0' }}>
      {([['Idle vehicle', COL_TRAILER], ['Internal load', COL_INTERNAL], ['External offer', COL_EXTERNAL], ['Route', COL_ROUTE_SEL]] as [string, number[]][]).map(([lbl, c]) => (
        <span key={lbl} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${c[0]},${c[1]},${c[2]})`, display: 'inline-block' }} />
          {lbl}
        </span>
      ))}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16, height: '100%', overflow: 'auto' }}>
      <div>
        <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 4px' }}>Backload Proposals</h2>
        <p style={{ fontSize: 13, color: 'var(--text-secondary, #6b7280)', margin: 0 }}>
          Multi-strategy backhaul recommendations for idle {cls?.LABEL_NOUN ?? 'vehicles'}: run one strategy or fuse them all into a graded, internal-first proposal per vehicle
          {cfg ? ` (${cfg.vehicleType} / ${cfg.region})` : ''}.
        </p>
      </div>

      {loadErr && <div style={{ ...card, borderColor: 'var(--border-error, #fecaca)', backgroundColor: 'var(--surface-error, #fef2f2)', color: 'var(--text-error, #dc2626)', fontSize: 13 }}>{loadErr}</div>}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>
        <span><strong>{trailers.length}</strong> idle vehicles</span>
        <span><strong>{loads.filter((l) => l.IS_INTERNAL).length}</strong> internal loads</span>
        <span><strong>{loads.filter((l) => !l.IS_INTERNAL).length}</strong> external offers</span>
        <span><strong>{eligibleSet.size}</strong> eligible pairs</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 12, alignItems: 'end' }}>
        <div>
          <label style={label}>Strategy</label>
          <select style={inputStyle} value={strategy} onChange={(e) => setStrategy(e.target.value as StrategyKey)}>
            {STRATEGY_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label style={label}>Max vehicles</label>
          <input type="number" min={1} max={Math.max(1, trailers.length)} style={inputStyle} value={maxVehicles} onChange={(e) => setMaxVehicles(Number(e.target.value))} />
        </div>
        <div>
          <label style={label}>Max loads</label>
          <input type="number" min={1} max={Math.max(1, loads.length)} style={inputStyle} value={maxLoads} onChange={(e) => setMaxLoads(Number(e.target.value))} />
        </div>
        <button onClick={run} disabled={busy || !cls} style={btn(!busy && !!cls)}>{busy ? 'Running…' : 'Run proposals'}</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)', marginTop: -8 }}>{strategyHint}</div>

      {strategy === 'ensemble' && proposals.length > 0 && (
        <div style={{ ...card }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700 }}>Ranking weights</div>
            <select style={{ ...inputStyle, width: 'auto' }} value={preset} onChange={(e) => applyPreset(e.target.value)}>
              {Object.keys(WEIGHT_PRESETS).map((n) => <option key={n} value={n}>{n}</option>)}
              <option value="Custom">Custom</option>
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {DIMENSIONS.map((d) => (
              <div key={d}>
                <label style={label}>{DIMENSION_LABELS[d]}: {Math.round((weights[d] ?? 0) * 100)}</label>
                <input type="range" min={0} max={0.5} step={0.01} value={weights[d] ?? 0} onChange={(e) => setWeight(d, Number(e.target.value))} style={{ width: '100%' }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {notice && <div style={{ ...card, backgroundColor: 'var(--surface-info, #eff6ff)', borderColor: 'var(--border-info, #bfdbfe)', color: 'var(--text-info, #1d4ed8)', fontSize: 12 }}>{notice}</div>}
      {solveError && <div style={{ ...card, borderColor: 'var(--border-error, #fecaca)', backgroundColor: 'var(--surface-error, #fef2f2)', color: 'var(--text-error, #dc2626)', fontSize: 13 }}>{solveError}</div>}

      {ranked.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <div style={card}><div style={label}>Vehicles matched</div><div style={{ fontSize: 22, fontWeight: 700 }}>{kpis.n}</div></div>
            <div style={card}><div style={label}>Internal filled</div><div style={{ fontSize: 22, fontWeight: 700 }}>{kpis.internal}</div></div>
            <div style={card}><div style={label}>Empty km</div><div style={{ fontSize: 22, fontWeight: 700 }}>{kpis.totalEmpty.toFixed(0)}</div></div>
            <div style={card}><div style={label}>Avg score</div><div style={{ fontSize: 22, fontWeight: 700 }}>{kpis.avgGrade.toFixed(0)}</div></div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={explain} disabled={explaining} style={btn(!explaining)}>{explaining ? 'Explaining…' : 'Explain (Cortex)'}</button>
          </div>
          {rationale && <div style={{ ...card, fontSize: 13, lineHeight: 1.5 }}>{rationale}</div>}
        </>
      )}

      {/* 50/50 results row: scrollable proposal list (left) + map (right), equal height. */}
      {(trailers.length > 0 || loads.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, height: SPLIT_H }}>
          <div style={{ minWidth: 0, height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
            {ranked.length > 0 ? (
              ranked.map((rt) => <TrailerCard key={rt.trailerId} rt={rt} expanded={expanded === rt.trailerId}
                selected={selectedKey === rt.best.key}
                onToggle={() => { setExpanded(expanded === rt.trailerId ? null : rt.trailerId); setSelectedKey(selectedKey === rt.best.key ? null : rt.best.key); }}
                chipsFor={chipsFor} decision={decisions[rt.best.key]} setDecision={(d) => setDecisions((p) => ({ ...p, [rt.best.key]: d }))} />)
            ) : (
              <div style={{ ...card, fontSize: 13, color: 'var(--text-secondary, #6b7280)' }}>
                {ranAt > 0 && !solveError
                  ? 'No proposals for the active preset. Try raising Max vehicles / loads or check the region routing service.'
                  : 'Run proposals to generate ranked recommendations.'}
              </div>
            )}
          </div>
          <div style={{ minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {legend}
            <div style={{ flex: 1, minHeight: 0 }}>
              <RouteMapInline result={mapResult} height="100%" fitCoords={selectedCoords} focusKey={selectedKey ? `sel:${selectedKey}` : ''} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TrailerCard({ rt, expanded, selected, onToggle, chipsFor, decision, setDecision }: {
  rt: RankedTrailer; expanded: boolean; selected: boolean; onToggle: () => void;
  chipsFor: (t: string, l: string) => { label: string; ok: boolean }[];
  decision: Decision | undefined; setDecision: (d: Decision) => void;
}) {
  const card: React.CSSProperties = { padding: 12, borderRadius: 8, border: `1px solid ${selected ? 'var(--surface-accent-strong, #2563eb)' : 'var(--border-default, #e5e7eb)'}`, backgroundColor: selected ? 'var(--surface-accent, #dbeafe)' : 'var(--surface-primary, #fff)' };
  const chip = (ok: boolean): React.CSSProperties => ({ fontSize: 10, padding: '1px 6px', borderRadius: 4, marginRight: 4, backgroundColor: ok ? 'var(--surface-success, #dcfce7)' : 'var(--surface-error, #fee2e2)', color: ok ? 'var(--text-success, #16a34a)' : 'var(--text-error, #dc2626)' });
  const b = rt.best;
  const dbtn = (d: Decision, lbl: string): React.CSSProperties => ({ fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer', border: '1px solid var(--border-default, #e5e7eb)', background: decision === d ? 'var(--surface-accent, #dbeafe)' : 'transparent', color: 'var(--text-primary, #111827)' });
  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, cursor: 'pointer' }} onClick={onToggle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 30, height: 30, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', background: gradeColor(rt.grade) }}>{rt.grade}</span>
          <div>
            <div style={{ fontSize: 13 }}><strong>{rt.trailerId}</strong> &rarr; {b.loadId}
              <span style={{ marginLeft: 8, padding: '1px 6px', borderRadius: 4, fontSize: 11, backgroundColor: b.isInternal ? 'var(--surface-accent, #dbeafe)' : 'var(--surface-secondary, #f3f4f6)' }}>{b.isInternal ? 'INTERNAL' : (b.pickupCountry ? 'EXTERNAL' : 'EXTERNAL')}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>{b.emptyCity} &rarr; {b.pickupCity} &rarr; {b.deliveryCity} · {FAMILY_LABELS[b.bestSource]} · {b.agreement}/{4} strategies agree</div>
          </div>
        </div>
        <div style={{ textAlign: 'right', whiteSpace: 'nowrap', fontSize: 12 }}>
          <div>empty {(b.emptyKm ?? 0).toFixed(0)} km · loaded {(b.loadedKm ?? 0).toFixed(0)} km</div>
          <div style={{ fontWeight: 600 }}>score {rt.composite.toFixed(0)}{rt.orderCount > 1 ? ` · ${rt.orderCount} options` : ''}</div>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border-default, #e5e7eb)', paddingTop: 10 }}>
          <div style={{ marginBottom: 8 }}>
            {chipsFor(rt.trailerId, b.loadId).map((c) => <span key={c.label} style={chip(c.ok)}>{c.label} {c.ok ? '✓' : '✗'}</span>)}
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {(['ACCEPT', 'REJECT', 'FLAG'] as Decision[]).map((d) => (
              <button key={d} style={dbtn(d, d)} onClick={() => setDecision(d)}>{d[0] + d.slice(1).toLowerCase()}</button>
            ))}
            {decision && <span style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)', alignSelf: 'center' }}>({decision.toLowerCase()} · session only)</span>}
          </div>
          {rt.orderCount > 1 && (
            <div style={{ fontSize: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Alternative loads</div>
              {rt.orders.slice(1, 5).map((o) => (
                <div key={o.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', color: 'var(--text-secondary, #6b7280)' }}>
                  <span>{o.loadId} · {o.pickupCity} &rarr; {o.deliveryCity} ({FAMILY_LABELS[o.bestSource]})</span>
                  <span>score {o.composite.toFixed(0)} · empty {(o.emptyKm ?? 0).toFixed(0)} km</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
