'use client';

// Triangle Proposals - chained (two-hop) backhaul cockpit, neutral and
// industry-agnostic.
//
// The case this page exists for: a vehicle empties a long way from where it
// needs to get back to, and there is NO single load that makes the return. A
// chain does it in two hops - carry load A part of the way, then load B the
// rest - and that is a pattern single-hop matching structurally cannot find.
//
// Three things make a chain actionable rather than merely clever:
//
//  1. INTERNAL-FIRST CASCADE. Own loads are exhausted before an outside
//     exchange is consulted. The ladder is explicit (rung 1 internal/internal
//     .. rung 4 external/external) and stops at the first rung producing a
//     chain that clears CASCADE_GRADE_THRESHOLD, so the page can say "no
//     internal-only chain existed" instead of quietly showing an external one.
//
//  2. LIVE ROAD COST. Chain skeletons are enumerated and pruned in SQL on
//     great-circle distance; every leg of every surviving chain is then costed
//     by ONE live matrix call against the routing engine (Tenet 9 - routing
//     output is never precomputed or cached into a table). The SELECTED chain
//     additionally gets a live DIRECTIONS polyline so the drawn route follows
//     the road network instead of five straight lines.
//
//  3. A STATUS-QUO BASELINE. Each chain is shown against what the planner
//     would otherwise do: run empty to the target. Without that delta a chain
//     is a black box, and an experienced planner will not act on a black box.
//     A chain that does not beat the baseline is labelled as such rather than
//     presented as a win. The chain's empty distance INCLUDES the residual run
//     from the hop-2 delivery to the target, because the baseline is a
//     complete run home - comparing it against a partial chain cost silently
//     overstated every saving on this page.
//
// Read-only: no write-back, no persisted decisions. No vendor branding.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { usePublishMapState } from '@/lib/agent-memo';
import type { ViewProps } from '@/lib/types';
import { sfRead, sqlLiteral } from './backload-matching/helpers';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';
import { isRoutingSuspendedError, type SuspendedInfo } from '@/lib/routing-suspend';
import ProposalMap, { type MapVehicle, type MapLoad, type MapStop, type MapLegKind, type MapRouteLeg } from './backload-proposals/ProposalMap';
import LegendOverlay, { LegendSection } from './backload-proposals/LegendOverlay';
import {
  COLOR_VEHICLE, COLOR_INTERNAL, COLOR_EXTERNAL,
  COLOR_LEG_EMPTY, COLOR_LEG_LOADED,
} from './backload-proposals/constants';

const BM = 'FLEET_APP.BACKLOAD_MATCHING';
const PHYS = 'FLEET_INTELLIGENCE.BACKLOAD_MATCHING';

// The routing gateway guards the number of locations per matrix call
// (ORS_GUARDRAIL_MATRIX_MAX_LOCATIONS, 1500) and the engine caps the resulting
// route count (matrix_maximum_routes 2,000,000, i.e. ~1414 locations square).
// This ceiling is far below both: it bounds the page's own render cost, and a
// chain contributes at most 6 points, so it admits ~25 chains per costing run.
const MAX_MATRIX_POINTS = 150;

/** One chain skeleton straight out of VW_TRIANGLES (great-circle costed). */
interface Chain {
  TRAILER_ID: string;
  AVAILABILITY_BASIS: string | null;
  EMPTY_CITY: string | null; EMPTY_LON: number; EMPTY_LAT: number;
  EMPTY_FROM_TS: string | null;
  TARGET_LABEL: string | null; TARGET_LON: number; TARGET_LAT: number; TARGET_GAP_KM: number;
  VEHICLE_EQUIPMENT: string | null;

  LEG1_LOAD_ID: string; LEG1_IS_INTERNAL: boolean; LEG1_SOURCE_SYSTEM: string | null;
  LEG1_PICKUP_CITY: string | null; LEG1_PICKUP_LON: number; LEG1_PICKUP_LAT: number;
  LEG1_DELIVERY_CITY: string | null; LEG1_DELIVERY_LON: number; LEG1_DELIVERY_LAT: number;
  LEG1_PICKUP_TS: string | null; LEG1_DELIVERY_ETA_TS: string | null;
  LEG1_WEIGHT_KG: number | null; LEG1_PRODUCT: string | null;
  LEG1_EMPTY_KM: number; LEG1_LOADED_KM: number;
  LEG1_PROGRESS_KM: number; LEG1_PROGRESS_PCT: number; GAP_AFTER_LEG1_KM: number;

  LEG2_LOAD_ID: string; LEG2_IS_INTERNAL: boolean; LEG2_SOURCE_SYSTEM: string | null;
  LEG2_PICKUP_CITY: string | null; LEG2_PICKUP_LON: number; LEG2_PICKUP_LAT: number;
  LEG2_DELIVERY_CITY: string | null; LEG2_DELIVERY_LON: number; LEG2_DELIVERY_LAT: number;
  LEG2_PICKUP_TS: string | null;
  LEG2_WEIGHT_KG: number | null; LEG2_PRODUCT: string | null;
  LEG2_EMPTY_KM: number; LEG2_LOADED_KM: number; FINAL_GAP_KM: number;

  CASCADE_RUNG: number;
  TOTAL_EMPTY_KM: number; TOTAL_LOADED_KM: number; TOTAL_KM: number;
  // Every empty km the chain incurs, INCLUDING the residual run from the hop-2
  // delivery to the target. TOTAL_EMPTY_KM is only the two-leg subtotal (the
  // constraint chips are calibrated against it), so anything compared with the
  // run-home-empty baseline must use this column - the baseline is a COMPLETE
  // run home, and comparing it against a partial chain cost overstates the win.
  TOTAL_EMPTY_WITH_RESIDUAL_KM: number;
  NET_BENEFIT_USD: number;
  COST_PER_EMPTY_KM: number; REV_PER_LOADED_KM: number;
  TOTAL_EMPTY_CHECK: boolean; LEG1_DETOUR_CHECK: boolean;
  TARGET_CHECK: boolean; SEQUENCE_CHECK: boolean; ELIGIBLE: boolean;
}

/** The four chain-shaping constraints a planner can tighten on the page. */
interface Constraints {
  targetRadiusKm: number;
  maxTotalEmptyKm: number;
  maxLeg1DetourKm: number;
  maxPerVehicle: number;
}

/** Per-km economics, editable so a planner can test their own rates. */
interface Economics { costPerEmptyKm: number; revPerLoadedKm: number; }

/** Road km per leg for one chain, straight out of the live matrix. */
interface RoadLegs {
  e1: number | null; loaded1: number | null;
  e2: number | null; loaded2: number | null;
  residual: number | null;
  baseline: number | null;
}

/** A chain after live road costing + baseline comparison. */
interface Costed extends Chain {
  key: string;
  // Per-leg road km, kept so each card line can show the road figure it was
  // costed on rather than falling back to a dash.
  roadE1Km: number | null;        // start -> hop-1 pickup (empty)
  roadLoaded1Km: number | null;   // hop-1 pickup -> delivery (paying)
  roadE2Km: number | null;        // hop-1 delivery -> hop-2 pickup (empty)
  roadLoaded2Km: number | null;   // hop-2 pickup -> delivery (paying)
  roadResidualKm: number | null;  // hop-2 delivery -> target (empty)
  roadEmptyKm: number | null;     // e1 + e2 + residual
  roadLoadedKm: number | null;    // road km across both paying legs
  roadTotalKm: number | null;
  // The figures the card actually prints: road when costed, great-circle before.
  emptyKm: number;                // residual-inclusive
  loadedKm: number;
  residualKm: number;
  baselineEmptyKm: number;          // running empty straight to target instead
  emptySavedKm: number;             // baseline empty minus chain empty
  netUsd: number;                   // road-based when available
  baselineNetUsd: number;           // the status quo: empty run, no revenue
  beatsBaseline: boolean;
  // Constraint verdicts recomputed against the CURRENT slider values, so a
  // tightened constraint is reflected in the chips and in eligibility.
  totalEmptyOk: boolean;
  leg1DetourOk: boolean;
  targetOk: boolean;
  sequenceOk: boolean;
  eligible: boolean;
  grade: string;
  score: number;
}

const RUNG_LABEL: Record<number, string> = {
  1: 'Own loads only',
  2: 'Own load, then external',
  3: 'External, then own load',
  4: 'External on both hops',
};

const RUNG_NOTE: Record<number, string> = {
  1: 'Both hops came from our own waiting loads.',
  2: 'No own load completed the return, so the second hop is external.',
  3: 'No own load started the return, so the first hop is external.',
  4: 'No own load fitted either hop; both come from outside.',
};

// A chain is start -> pickup1 -> delivery1 -> pickup2 -> delivery2 -> target.
// Only hops 2->3 and 4->5 earn revenue; the other three are empty running. The
// map has to be told this, otherwise the repositioning between hops and the
// residual run to the target are painted as paying legs.
const CHAIN_LEG_KINDS: MapLegKind[] = ['empty', 'loaded', 'empty', 'loaded', 'empty'];

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmtKm(v: number | null | undefined): string {
  return v == null ? '-' : `${Math.round(v).toLocaleString()} km`;
}
function fmtUsd(v: number | null | undefined): string {
  return v == null ? '-' : `$${Math.round(v).toLocaleString()}`;
}

// Upstream POI names arrive wrapped in literal double quotes (every row of
// DIM_POIS.NAME), and the load pool falls back to the bare words 'Origin' /
// 'Destination' / 'Drop-off' whenever a trip endpoint was never a POI - which
// is the majority of rows. Printing either verbatim gives cards that read
// "Origin -> Destination", so unwrap the quotes and, for a placeholder, fall
// back to the coordinate, which at least locates the stop.
const PLACEHOLDER_NAMES = new Set(['origin', 'destination', 'drop-off', 'dropoff', 'unknown', 'depot']);
function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t;
}
function place(s: string | null | undefined, lon?: number, lat?: number): string {
  const t = s ? unquote(s) : '';
  if (t && !PLACEHOLDER_NAMES.has(t.toLowerCase())) return t;
  if (Number.isFinite(lon) && Number.isFinite(lat) && !(lon === 0 && lat === 0)) {
    return `near ${(lat as number).toFixed(2)}, ${(lon as number).toFixed(2)}`;
  }
  return t || 'unknown';
}
function toGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C+';
  if (score >= 50) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

// Road polyline PER LEG for the selected chain. One SQL round trip carrying a
// DIRECTIONS call per consecutive stop pair, because a single call through all
// six waypoints returns one unsplittable polyline - and a chain's legs are not
// all the same kind, so a single line cannot be coloured honestly.
// Waypoints are numeric-only, so the inlined arrays are injection-safe.
async function fetchLegPaths(
  profile: string, stops: [number, number][], region: string,
): Promise<([number, number][] | null)[] | null> {
  const ok = (p: [number, number]) =>
    Number.isFinite(p[0]) && Number.isFinite(p[1]) && !(p[0] === 0 && p[1] === 0);
  if (stops.length < 2) return null;
  const prof = profile.replace(/[^a-z0-9-]/gi, '');
  const reg = sqlLiteral(region);
  const parts: string[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]; const b = stops[i + 1];
    if (!ok(a) || !ok(b)) continue;
    const locs = JSON.stringify([a, b]);
    parts.push(
      `SELECT ${i} AS I, ST_ASGEOJSON(GEOJSON)::STRING AS G FROM TABLE(` +
      `OPENROUTESERVICE_APP.CORE.DIRECTIONS('${prof}', ` +
      `OBJECT_CONSTRUCT('coordinates', PARSE_JSON('${locs}'))::VARIANT, '${reg}'))`,
    );
  }
  if (!parts.length) return null;
  const rows = await sfRead(parts.join(' UNION ALL '));
  const byIdx = new Map<number, [number, number][]>();
  for (const r of rows as unknown as { I: number; G: string | null }[]) {
    if (!r.G || byIdx.has(Number(r.I))) continue;
    try {
      const parsed = JSON.parse(r.G) as { coordinates?: [number, number][] };
      const coords = parsed?.coordinates;
      if (Array.isArray(coords) && coords.length > 1) byIdx.set(Number(r.I), coords);
    } catch { /* a malformed leg simply falls back to its straight line */ }
  }
  if (!byIdx.size) return null;
  return Array.from({ length: stops.length - 1 }, (_, i) => byIdx.get(i) ?? null);
}


export function TriangleProposalsView({ onStateChange }: Partial<ViewProps> = {}) {
  const region = useAppStore((s) => s.context['region']) as string | undefined;

  const [loading, setLoading] = useState(false);
  const [costing, setCosting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [suspended, setSuspended] = useState<SuspendedInfo | null>(null);
  const [chains, setChains] = useState<Chain[]>([]);
  const [vehicles, setVehicles] = useState<MapVehicle[]>([]);
  const [loads, setLoads] = useState<MapLoad[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [threshold, setThreshold] = useState(70);
  const [profile, setProfile] = useState('driving-car');
  const [status, setStatus] = useState('');
  const [legendOpen, setLegendOpen] = useState(false);
  const [costBasis, setCostBasis] = useState<'great_circle' | 'road'>('great_circle');

  // Road km per chain key, from the last matrix call. Kept separate from the
  // derived cards so moving a slider re-grades instantly without re-costing.
  const [roadByKey, setRoadByKey] = useState<Record<string, RoadLegs>>({});
  const [droppedFromMatrix, setDroppedFromMatrix] = useState(0);
  // Road polyline per leg, per chain key, fetched lazily for the selection only.
  const [routeGeo, setRouteGeo] = useState<Record<string, ([number, number][] | null)[]>>({});

  // The envelope VW_TRIANGLES itself pruned at. Sliders can tighten inside it
  // but cannot loosen past it, because the view has already discarded whatever
  // fell outside - showing a slider that silently does nothing above a certain
  // value would be worse than not offering it, so the envelope is displayed.
  const [envelope, setEnvelope] = useState<Constraints | null>(null);
  const [constraints, setConstraints] = useState<Constraints | null>(null);
  const [econ, setEcon] = useState<Economics | null>(null);

  // Filters over the graded set.
  const [rungFilter, setRungFilter] = useState<number | 'all'>('all');
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [beatsOnly, setBeatsOnly] = useState(false);
  const [vehicleFilter, setVehicleFilter] = useState<string>('all');

  // ---------------------------------------------------------------------
  // Load the pruned chain skeletons + the estate for map context.
  // ---------------------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true); setErr(null); setSuspended(null);
    setRoadByKey({}); setRouteGeo({}); setDroppedFromMatrix(0);
    setCostBasis('great_circle');
    try {
      const cfg = await sfRead(`SELECT VEHICLE_TYPE, REGION FROM ${BM}.VW_CONFIG LIMIT 1`);
      const vt = String(cfg[0]?.VEHICLE_TYPE ?? '');
      const [cls, tri, prm, veh, lds] = await Promise.all([
        sfRead(`SELECT ORS_PROFILE FROM ${BM}.VW_VEHICLE_CLASS WHERE VEHICLE_TYPE = '${sqlLiteral(vt)}' LIMIT 1`),
        sfRead(`SELECT * FROM ${PHYS}.VW_TRIANGLES`),
        sfRead(`SELECT PARAM_KEY, PARAM_VALUE FROM ${PHYS}.MATCH_PARAMS`),
        sfRead(`SELECT TRAILER_ID, EMPTY_LON, EMPTY_LAT FROM ${PHYS}.VW_TRAILERS_GEO`),
        sfRead(`SELECT LOAD_ID, IS_INTERNAL, SOURCE, PICKUP_CITY, PICKUP_LON, PICKUP_LAT FROM ${PHYS}.VW_LOADS`),
      ]);
      setProfile(String(cls[0]?.ORS_PROFILE ?? 'driving-car'));

      const params = new Map<string, number>();
      for (const r of prm as unknown as { PARAM_KEY: string; PARAM_VALUE: string }[]) {
        const n = Number(r.PARAM_VALUE);
        if (Number.isFinite(n)) params.set(r.PARAM_KEY, n);
      }
      const t = params.get('CASCADE_GRADE_THRESHOLD');
      if (t != null) setThreshold(t);
      const rows = tri as unknown as Chain[];
      const env: Constraints = {
        targetRadiusKm: params.get('TARGET_RADIUS_KM') ?? 250,
        maxTotalEmptyKm: params.get('TRIANGLE_MAX_TOTAL_EMPTY_KM') ?? 250,
        maxLeg1DetourKm: params.get('TRIANGLE_MAX_LEG1_DETOUR_KM') ?? 400,
        maxPerVehicle: params.get('MAX_TRIANGLES_PER_TRAILER') ?? 5,
      };
      setEnvelope(env);
      setConstraints(env);
      // A rate of 0 would silently zero the economics, so fall back through
      // MATCH_PARAMS, then the rate the view itself costed with, then the
      // documented default - taking the first STRICTLY POSITIVE value.
      const rate = (...candidates: (number | undefined)[]): number => {
        for (const v of candidates) if (v != null && Number.isFinite(v) && v > 0) return v;
        return 1;
      };
      setEcon({
        costPerEmptyKm: rate(params.get('COST_PER_EMPTY_KM'), num(rows[0]?.COST_PER_EMPTY_KM), 1.2),
        revPerLoadedKm: rate(params.get('REVENUE_PER_LOADED_KM'), num(rows[0]?.REV_PER_LOADED_KM), 1.1),
      });

      setChains(rows);
      setVehicles((veh as unknown as { TRAILER_ID: string; EMPTY_LON: number; EMPTY_LAT: number }[])
        .filter((v) => v.EMPTY_LON != null)
        .map((v) => ({ id: v.TRAILER_ID, lon: num(v.EMPTY_LON), lat: num(v.EMPTY_LAT) })));
      setLoads((lds as unknown as Record<string, unknown>[])
        .filter((l) => l.PICKUP_LON != null)
        .map((l) => ({
          id: String(l.LOAD_ID), lon: num(l.PICKUP_LON), lat: num(l.PICKUP_LAT),
          internal: Boolean(l.IS_INTERNAL), city: (l.PICKUP_CITY as string) ?? null,
          source: (l.SOURCE as string) ?? null,
        })));
      setStatus(rows.length
        ? `${rows.length} chain skeletons found. Run costing to price the legs on the road network.`
        : 'No chain is needed here: every load already delivers within the target radius, so a direct return exists. Chains are a long-haul pattern - switch to a wide-area dataset to see them.');
    } catch (e: unknown) {
      if (isRoutingSuspendedError(e)) setSuspended((e as { info: SuspendedInfo }).info);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, region]);

  const chainKey = useCallback(
    (c: Chain) => `${c.TRAILER_ID}::${c.LEG1_LOAD_ID}::${c.LEG2_LOAD_ID}`, []);

  // ---------------------------------------------------------------------
  // Live road costing. ONE matrix call over every distinct point in the
  // candidate set, then each leg is looked up from it. The same matrix also
  // yields the baseline (empty straight to target) AND the residual run from
  // the hop-2 delivery to the target, so the comparison is on identical road
  // data rather than one road figure against one straight line.
  //
  // MATRIX_TABULAR takes (profile, ORIGIN coords, DESTINATION coords, region)
  // and the gateway derives sources/destinations from the two arrays' LENGTHS,
  // so a full square matrix means passing the same coordinate list twice. It
  // requests metrics ['distance','duration'], hence distances in metres.
  // ---------------------------------------------------------------------
  const runCosting = useCallback(async () => {
    if (!chains.length) return;
    setCosting(true); setErr(null); setSuspended(null);
    try {
      // Distinct points, de-duplicated to a 5dp key so the matrix stays small.
      // Chains are consumed in rank order (internal-first, then best net) and
      // cut off at the gateway's location guardrail rather than silently
      // truncating the matrix, which would return a short row and mis-cost the
      // legs that fell off the end.
      const idx = new Map<string, number>();
      const pts: [number, number][] = [];
      const add = (lon: number, lat: number): number => {
        const k = `${lon.toFixed(5)},${lat.toFixed(5)}`;
        const hit = idx.get(k);
        if (hit != null) return hit;
        const i = pts.length;
        pts.push([lon, lat]); idx.set(k, i);
        return i;
      };
      const rows: { c: Chain; iEmpty: number; iP1: number; iD1: number; iP2: number; iD2: number; iTgt: number }[] = [];
      let dropped = 0;
      for (const c of chains) {
        // A chain contributes at most 6 points; stop before overshooting.
        if (pts.length + 6 > MAX_MATRIX_POINTS) { dropped += 1; continue; }
        rows.push({
          c,
          iEmpty: add(num(c.EMPTY_LON), num(c.EMPTY_LAT)),
          iP1: add(num(c.LEG1_PICKUP_LON), num(c.LEG1_PICKUP_LAT)),
          iD1: add(num(c.LEG1_DELIVERY_LON), num(c.LEG1_DELIVERY_LAT)),
          iP2: add(num(c.LEG2_PICKUP_LON), num(c.LEG2_PICKUP_LAT)),
          iD2: add(num(c.LEG2_DELIVERY_LON), num(c.LEG2_DELIVERY_LAT)),
          iTgt: add(num(c.TARGET_LON), num(c.TARGET_LAT)),
        });
      }

      const coords = `ARRAY_CONSTRUCT(${pts.map(([lo, la]) => `ARRAY_CONSTRUCT(${lo}, ${la})`).join(', ')})`;
      const sql =
        `SELECT TO_VARCHAR(M:distances) AS D, TO_VARCHAR(M:durations) AS T FROM (SELECT ` +
        `OPENROUTESERVICE_APP.CORE.MATRIX_TABULAR('${sqlLiteral(profile)}', ` +
        `${coords}, ${coords}, ${region ? `'${sqlLiteral(region)}'` : 'NULL'}) AS M)`;
      const res = await sfRead(sql);
      const parse = (v: unknown): number[][] | null => {
        if (v == null) return null;
        try { return typeof v === 'string' ? JSON.parse(v) : (v as number[][]); } catch { return null; }
      };
      const dist = parse(res[0]?.D);
      if (!Array.isArray(dist) || !Array.isArray(dist[0])) {
        throw new Error('The routing engine returned no distance matrix, so legs cannot be costed on the road network. Check that the region services are running.');
      }
      const km = (a: number, b: number): number | null => {
        const v = dist?.[a]?.[b];
        return typeof v === 'number' && Number.isFinite(v) ? v / 1000 : null;
      };

      const next: Record<string, RoadLegs> = {};
      for (const { c, iEmpty, iP1, iD1, iP2, iD2, iTgt } of rows) {
        next[chainKey(c)] = {
          e1: km(iEmpty, iP1),
          loaded1: km(iP1, iD1),
          e2: km(iD1, iP2),
          loaded2: km(iP2, iD2),
          // The residual empty run the vehicle still has to make. The target is
          // already a matrix point, so this costs nothing extra to obtain - and
          // leaving it out is what made every saving on this page look larger
          // than it is.
          residual: km(iD2, iTgt),
          baseline: km(iEmpty, iTgt),
        };
      }
      setRoadByKey(next);
      setDroppedFromMatrix(dropped);
      setCostBasis('road');
      setStatus(`Costed ${rows.length} chains on the road network${dropped ? `, ${dropped} deferred to stay inside the matrix location limit` : ''}.`);
    } catch (e: unknown) {
      if (isRoutingSuspendedError(e)) setSuspended((e as { info: SuspendedInfo }).info);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCosting(false);
    }
  }, [chains, chainKey, profile, region]);

  // ---------------------------------------------------------------------
  // Grade every chain against the CURRENT constraints and economics. Pure
  // derivation, so both the sliders and the rate boxes take effect with no
  // further routing calls. Scoring is deliberately simple and explainable -
  // a dispatcher has to be able to reconstruct it.
  // ---------------------------------------------------------------------
  const graded = useMemo<Costed[]>(() => {
    if (!constraints || !econ) return [];
    return chains.map((c) => {
      const r = roadByKey[chainKey(c)];
      const roadE1Km = r?.e1 ?? null;
      const roadLoaded1Km = r?.loaded1 ?? null;
      const roadE2Km = r?.e2 ?? null;
      const roadLoaded2Km = r?.loaded2 ?? null;
      const roadResidualKm = r?.residual ?? null;
      const roadEmptyKm = roadE1Km != null && roadE2Km != null && roadResidualKm != null
        ? roadE1Km + roadE2Km + roadResidualKm : null;
      const roadLoadedKm = roadLoaded1Km != null && roadLoaded2Km != null
        ? roadLoaded1Km + roadLoaded2Km : null;

      const emptyKm = roadEmptyKm ?? c.TOTAL_EMPTY_WITH_RESIDUAL_KM;
      const loadedKm = roadLoadedKm ?? c.TOTAL_LOADED_KM;
      const residualKm = roadResidualKm ?? c.FINAL_GAP_KM;
      const baselineEmptyKm = r?.baseline ?? c.TARGET_GAP_KM;

      const netUsd = loadedKm * econ.revPerLoadedKm - emptyKm * econ.costPerEmptyKm;
      // The status quo earns nothing and still burns the empty run home.
      const baselineNetUsd = -baselineEmptyKm * econ.costPerEmptyKm;

      // Constraints are re-evaluated here so a tightened slider is visible in
      // the chips. TOTAL_EMPTY_CHECK is defined on the two-leg subtotal, which
      // is what MAX_TOTAL_EMPTY_KM was calibrated against - keep it that way.
      const twoLegEmpty = roadE1Km != null && roadE2Km != null
        ? roadE1Km + roadE2Km : c.TOTAL_EMPTY_KM;
      const totalEmptyOk = twoLegEmpty <= constraints.maxTotalEmptyKm;
      const leg1DetourOk = (roadE1Km ?? c.LEG1_EMPTY_KM) <= constraints.maxLeg1DetourKm;
      const targetOk = residualKm <= constraints.targetRadiusKm;
      // Hop ordering is structural (enforced by the join), so it cannot be
      // relaxed on the page - carry the view's verdict through unchanged.
      const sequenceOk = Boolean(c.SEQUENCE_CHECK);
      const eligible = totalEmptyOk && leg1DetourOk && targetOk && sequenceOk;

      // Utilisation: share of the chain that is revenue-bearing.
      const util = loadedKm / Math.max(1, loadedKm + emptyKm);
      // Empty saved against running home empty, as a share of that baseline.
      const saved = baselineEmptyKm > 0
        ? Math.max(0, Math.min(1, (baselineEmptyKm - emptyKm) / baselineEmptyKm))
        : 0;
      // How completely the chain closes the return.
      const closed = Math.max(0, Math.min(1,
        (c.TARGET_GAP_KM - residualKm) / Math.max(1, c.TARGET_GAP_KM)));
      const score = Math.max(0, Math.min(100, 100 * (0.45 * util + 0.35 * closed + 0.20 * saved)));

      return {
        ...c,
        key: chainKey(c),
        roadE1Km, roadLoaded1Km, roadE2Km, roadLoaded2Km, roadResidualKm,
        roadEmptyKm, roadLoadedKm,
        roadTotalKm: roadEmptyKm != null && roadLoadedKm != null ? roadEmptyKm + roadLoadedKm : null,
        emptyKm, loadedKm, residualKm,
        baselineEmptyKm,
        emptySavedKm: baselineEmptyKm - emptyKm,
        netUsd, baselineNetUsd,
        beatsBaseline: netUsd > baselineNetUsd,
        totalEmptyOk, leg1DetourOk, targetOk, sequenceOk, eligible,
        score, grade: costBasis === 'road' ? toGrade(score) : '-',
      };
    });
  }, [chains, chainKey, roadByKey, constraints, econ, costBasis]);

  // The cascade ladder is the POLICY over the graded chains: take the lowest
  // rung that yields something acceptable, and only then widen. Applied only
  // once road costing has run - grading straight-line skeletons would stop the
  // cascade on an estimate.
  const rungReached = useMemo<number | null>(() => {
    if (costBasis !== 'road') return null;
    const eligible = graded.filter((c) => c.eligible);
    for (const rung of [1, 2, 3, 4]) {
      if (eligible.some((c) => c.CASCADE_RUNG === rung && c.score >= threshold)) return rung;
    }
    return null;
  }, [graded, costBasis, threshold]);

  const vehicleIds = useMemo(
    () => Array.from(new Set(graded.map((c) => c.TRAILER_ID))).sort(),
    [graded]);

  // Cascade cut, then the per-vehicle cap, then the filters.
  const shown = useMemo<Costed[]>(() => {
    if (!constraints) return [];
    let out = rungReached == null ? graded : graded.filter((c) => c.CASCADE_RUNG <= rungReached);
    out = [...out].sort((a, b) =>
      a.TRAILER_ID.localeCompare(b.TRAILER_ID)
      || a.CASCADE_RUNG - b.CASCADE_RUNG
      || b.score - a.score
      || b.netUsd - a.netUsd);
    // Per-vehicle cap applies to the RANKED chains of each vehicle, so lowering
    // it keeps each vehicle's best chains rather than an arbitrary slice.
    const seen = new Map<string, number>();
    out = out.filter((c) => {
      const n = (seen.get(c.TRAILER_ID) ?? 0) + 1;
      seen.set(c.TRAILER_ID, n);
      return n <= constraints.maxPerVehicle;
    });
    if (rungFilter !== 'all') out = out.filter((c) => c.CASCADE_RUNG === rungFilter);
    if (eligibleOnly) out = out.filter((c) => c.eligible);
    if (beatsOnly) out = out.filter((c) => c.beatsBaseline);
    if (vehicleFilter !== 'all') out = out.filter((c) => c.TRAILER_ID === vehicleFilter);
    return out;
  }, [graded, rungReached, constraints, rungFilter, eligibleOnly, beatsOnly, vehicleFilter]);

  // Cards grouped per vehicle. MAX_TRIANGLES_PER_TRAILER admits several chains
  // per vehicle, and a flat list of them reads as duplicated rows.
  const groups = useMemo(() => {
    const m = new Map<string, Costed[]>();
    for (const c of shown) {
      const arr = m.get(c.TRAILER_ID);
      if (arr) arr.push(c); else m.set(c.TRAILER_ID, [c]);
    }
    return Array.from(m.entries()).map(([trailer, items]) => ({ trailer, items }));
  }, [shown]);

  const selected = useMemo(
    () => shown.find((c) => c.key === selectedKey) ?? shown[0] ?? null,
    [shown, selectedKey],
  );

  useEffect(() => {
    if (shown.length && !shown.some((c) => c.key === selectedKey)) setSelectedKey(shown[0].key);
    if (!shown.length && selectedKey) setSelectedKey('');
  }, [shown, selectedKey]);

  // Six stops: start, both pickups, both deliveries, target.
  const stops: MapStop[] = useMemo(() => {
    if (!selected) return [];
    return [
      { idx: 1, kind: 'start',    pos: [num(selected.EMPTY_LON), num(selected.EMPTY_LAT)], city: selected.EMPTY_CITY },
      { idx: 2, kind: 'pickup',   pos: [num(selected.LEG1_PICKUP_LON), num(selected.LEG1_PICKUP_LAT)], city: selected.LEG1_PICKUP_CITY },
      { idx: 3, kind: 'delivery', pos: [num(selected.LEG1_DELIVERY_LON), num(selected.LEG1_DELIVERY_LAT)], city: selected.LEG1_DELIVERY_CITY },
      { idx: 4, kind: 'pickup',   pos: [num(selected.LEG2_PICKUP_LON), num(selected.LEG2_PICKUP_LAT)], city: selected.LEG2_PICKUP_CITY },
      { idx: 5, kind: 'delivery', pos: [num(selected.LEG2_DELIVERY_LON), num(selected.LEG2_DELIVERY_LAT)], city: selected.LEG2_DELIVERY_CITY },
      { idx: 6, kind: 'end',      pos: [num(selected.TARGET_LON), num(selected.TARGET_LAT)], city: selected.TARGET_LABEL },
    ];
  }, [selected]);

  // Lazily fetch the selected chain's per-leg road geometry. A suspended region
  // is surfaced through the shared notice rather than silently degrading to
  // straight lines, which is indistinguishable from "the route IS straight".
  useEffect(() => {
    if (!selected || !region || stops.length < 2) return;
    const key = selected.key;
    if (routeGeo[key]) return;
    const wp: [number, number][] = stops.map((s) => s.pos);
    let cancelled = false;
    fetchLegPaths(profile, wp, region)
      .then((legs) => {
        if (cancelled || !legs) return;
        setRouteGeo((prev) => (prev[key] ? prev : { ...prev, [key]: legs }));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (isRoutingSuspendedError(e)) setSuspended((e as { info: SuspendedInfo }).info);
        // Any other failure leaves the legs unresolved and the straight-line
        // fallback stands; the legend states which of the two is on screen.
      });
    return () => { cancelled = true; };
  }, [selected, region, profile, stops, routeGeo]);

  // Per-leg road geometry paired with each leg's kind. A leg the engine could
  // not resolve is dropped rather than substituted, so a partial result cannot
  // silently attribute one leg's geometry to another.
  const routeLegs = useMemo<MapRouteLeg[] | undefined>(() => {
    const legs = selected ? routeGeo[selected.key] : undefined;
    if (!legs) return undefined;
    const out: MapRouteLeg[] = [];
    legs.forEach((path, i) => {
      if (path && path.length > 1) out.push({ path, kind: CHAIN_LEG_KINDS[i] ?? 'loaded' });
    });
    return out.length ? out : undefined;
  }, [selected, routeGeo]);

  const routeOnRoads = Boolean(routeLegs && routeLegs.length === CHAIN_LEG_KINDS.length);


  // ---------------------------------------------------------------------
  // Agent grounding (Tenet 10). Publishes the SAME numbers the cards show,
  // pre-joined and bounded, plus the cascade outcome - otherwise the agent
  // answers chain questions from a different fact than the one on screen.
  // ---------------------------------------------------------------------
  const memoLine = useMemo(() => {
    if (!shown.length) {
      return chains.length === 0
        ? 'No two-hop chain is needed on this dataset: every load already delivers within the target radius of its vehicle, so a direct return exists. Chaining is a long-haul pattern.'
        : 'Chain skeletons loaded but every one is filtered out by the current constraints or filters.';
    }
    const head = [
      `basis=${costBasis}`,
      `chains=${shown.length}`,
      `vehicles=${new Set(shown.map((c) => c.TRAILER_ID)).size}`,
      rungReached != null
        ? `cascade_stopped_at_rung=${rungReached} (${RUNG_LABEL[rungReached]})`
        : costBasis === 'road'
          ? 'cascade=no rung cleared the acceptance score, so every rung is shown as a near miss'
          : 'cascade=not applied until legs are costed on the road network',
      `acceptance_score=${threshold}`,
      `empty_km_includes_residual_run_to_target=yes`,
    ].join(', ');
    const lines = shown.slice(0, 12).map((c) =>
      `${c.TRAILER_ID}: rung ${c.CASCADE_RUNG} ${RUNG_LABEL[c.CASCADE_RUNG]}; ` +
      `hop1 ${place(c.LEG1_PICKUP_CITY, c.LEG1_PICKUP_LON, c.LEG1_PICKUP_LAT)} -> ${place(c.LEG1_DELIVERY_CITY, c.LEG1_DELIVERY_LON, c.LEG1_DELIVERY_LAT)} (${c.LEG1_IS_INTERNAL ? 'internal' : 'external'}); ` +
      `hop2 ${place(c.LEG2_PICKUP_CITY, c.LEG2_PICKUP_LON, c.LEG2_PICKUP_LAT)} -> ${place(c.LEG2_DELIVERY_CITY, c.LEG2_DELIVERY_LON, c.LEG2_DELIVERY_LAT)} (${c.LEG2_IS_INTERNAL ? 'internal' : 'external'}); ` +
      `empty ${fmtKm(c.emptyKm)} (of which ${fmtKm(c.residualKm)} is the residual run to the target), loaded ${fmtKm(c.loadedKm)}; ` +
      `vs running home empty ${fmtKm(c.baselineEmptyKm)} -> ${c.emptySavedKm >= 0 ? `saves ${fmtKm(c.emptySavedKm)}` : `runs ${fmtKm(-c.emptySavedKm)} MORE empty`}; ` +
      `net ${fmtUsd(c.netUsd)} vs empty-run-home baseline ${fmtUsd(c.baselineNetUsd)}; ` +
      `${c.beatsBaseline ? 'beats baseline' : 'does NOT beat baseline'}; ` +
      `grade ${c.grade}; ${c.eligible ? 'eligible' : 'near miss'}`,
    );
    return `${head}\n${lines.join('\n')}`;
  }, [shown, chains.length, costBasis, rungReached, threshold]);

  const summary = useMemo(() => ({
    view: 'triangle_proposals', region: region ?? null,
    cost_basis: costBasis,
    chain_skeletons: chains.length || null,
    chains_shown: shown.length || null,
    vehicles_with_chain: shown.length ? new Set(shown.map((c) => c.TRAILER_ID)).size : null,
    cascade_rung_reached: rungReached,
    acceptance_score: threshold,
    chains_beating_baseline: shown.length ? shown.filter((c) => c.beatsBaseline).length : null,
    chains_saving_empty_km: shown.length ? shown.filter((c) => c.emptySavedKm > 0).length : null,
    total_empty_km: shown.length
      ? Math.round(shown.reduce((s, c) => s + c.emptyKm, 0)) : null,
    total_residual_empty_km: shown.length
      ? Math.round(shown.reduce((s, c) => s + c.residualKm, 0)) : null,
    cost_per_empty_km: econ?.costPerEmptyKm ?? null,
    revenue_per_loaded_km: econ?.revPerLoadedKm ?? null,
    __memo_triangle_proposals: memoLine,
  }), [region, costBasis, chains.length, shown, rungReached, threshold, econ, memoLine]);

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const lastSentRef = useRef<string>('');
  useEffect(() => {
    const json = JSON.stringify(summary);
    if (json === lastSentRef.current) return;
    lastSentRef.current = json;
    onStateChangeRef.current?.(summary);
  }, [summary]);

  // Map-layer grounding: exact per-layer counts plus the selected chain, so a
  // question about the map is answered from what the map actually painted.
  usePublishMapState(useMemo(() => {
    const layers = [
      { id: 'vehicles', type: 'scatterplot', featureCount: vehicles.length },
      { id: 'loads', type: 'scatterplot', featureCount: loads.length },
      { id: 'chain-stops', type: 'scatterplot', featureCount: stops.length },
      { id: 'chain-empty-legs', type: 'path', featureCount: stops.length ? 3 : 0 },
      { id: 'chain-loaded-legs', type: 'path', featureCount: stops.length ? 2 : 0 },
      { id: 'road-route', type: 'path', featureCount: routeLegs?.length ?? 0 },
    ].map((l) => ({ ...l, rendered: l.featureCount > 0 }));
    if (!vehicles.length && !loads.length) return null;
    return {
      layerCount: layers.length,
      layers,
      emptyLayers: layers.filter((l) => !l.rendered).map((l) => l.id),
      selection: selected
        ? {
          trailer: selected.TRAILER_ID,
          cascade_rung: `${selected.CASCADE_RUNG} ${RUNG_LABEL[selected.CASCADE_RUNG]}`,
          hop1: `${place(selected.LEG1_PICKUP_CITY, selected.LEG1_PICKUP_LON, selected.LEG1_PICKUP_LAT)} -> ${place(selected.LEG1_DELIVERY_CITY, selected.LEG1_DELIVERY_LON, selected.LEG1_DELIVERY_LAT)}`,
          hop2: `${place(selected.LEG2_PICKUP_CITY, selected.LEG2_PICKUP_LON, selected.LEG2_PICKUP_LAT)} -> ${place(selected.LEG2_DELIVERY_CITY, selected.LEG2_DELIVERY_LON, selected.LEG2_DELIVERY_LAT)}`,
          empty_km_incl_residual: String(Math.round(selected.emptyKm)),
          residual_km: String(Math.round(selected.residualKm)),
          beats_baseline: String(selected.beatsBaseline),
          route_follows_roads: String(routeOnRoads),
        }
        : undefined,
    };
  }, [vehicles.length, loads.length, stops.length, selected, routeLegs, routeOnRoads]));

  if (suspended) return <RoutingSuspendedNotice info={suspended} onRetry={() => void load()} />;

  const busy = loading || costing;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, height: '100%', overflow: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20, lineHeight: '24px', fontWeight: 700 }}>Triangle Proposals</h2>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {costBasis === 'road' ? 'live road network' : 'straight-line estimate'}
          {region ? ` \u00B7 ${region}` : ''}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => void load()}>
            Reload chains
          </button>
          <button type="button" className="btn secondary" onClick={() => setLegendOpen(true)}>
            Legend
          </button>
        </span>
      </div>

      {/* Controls */}
      <div className="control-bar">
        <button type="button" className="btn primary" disabled={busy || !chains.length}
          onClick={() => void runCosting()}>
          {costing ? 'Costing\u2026' : 'Cost legs on road network'}
        </button>
        <div className="control-bar-group">
          <span className="control-bar-label">Acceptance score</span>
          <input type="number" className="sf-input" style={{ width: 72 }} min={0} max={100}
            value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </div>
      </div>

      {/* Constraint sliders + economics. Both are session-only: MATCH_PARAMS is
          shared state and this page is read-only by design. */}
      {constraints && envelope && econ && (
        <div className="control-bar" style={{ gap: 16, alignItems: 'flex-start' }}>
          <Slider label="Target radius" unit="km" value={constraints.targetRadiusKm}
            max={envelope.targetRadiusKm}
            onChange={(v) => setConstraints({ ...constraints, targetRadiusKm: v })} />
          <Slider label="Max total empty" unit="km" value={constraints.maxTotalEmptyKm}
            max={envelope.maxTotalEmptyKm}
            onChange={(v) => setConstraints({ ...constraints, maxTotalEmptyKm: v })} />
          <Slider label="Max hop-1 detour" unit="km" value={constraints.maxLeg1DetourKm}
            max={envelope.maxLeg1DetourKm}
            onChange={(v) => setConstraints({ ...constraints, maxLeg1DetourKm: v })} />
          <Slider label="Chains per vehicle" unit="" value={constraints.maxPerVehicle}
            max={envelope.maxPerVehicle} step={1}
            onChange={(v) => setConstraints({ ...constraints, maxPerVehicle: v })} />
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <label className="control-bar-group" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
              <span className="control-bar-label">Cost / empty km</span>
              <input type="number" className="sf-input" step={0.05} min={0} value={econ.costPerEmptyKm}
                onChange={(e) => setEcon({ ...econ, costPerEmptyKm: Number(e.target.value) })}
                style={{ width: 72 }} />
            </label>
            <label className="control-bar-group" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
              <span className="control-bar-label">Revenue / loaded km</span>
              <input type="number" className="sf-input" step={0.05} min={0} value={econ.revPerLoadedKm}
                onChange={(e) => setEcon({ ...econ, revPerLoadedKm: Number(e.target.value) })}
                style={{ width: 72 }} />
            </label>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: 260, lineHeight: 1.4 }}>
            Sliders tighten inside the envelope the chain view already pruned at
            (each maximum above). Loosening past it would show nothing new,
            because those chains were never enumerated.
          </div>
        </div>
      )}

      {/* Filters */}
      {graded.length > 0 && (
        <div className="control-bar">
          <div className="control-bar-group">
            <span className="control-bar-label">Rung</span>
            <select className="sf-select" value={String(rungFilter)}
              onChange={(e) => setRungFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">All</option>
              {[1, 2, 3, 4].map((r) => (
                <option key={r} value={r}>{r} - {RUNG_LABEL[r]}</option>
              ))}
            </select>
          </div>
          <div className="control-bar-group">
            <span className="control-bar-label">Vehicle</span>
            <select className="sf-select" value={vehicleFilter}
              onChange={(e) => setVehicleFilter(e.target.value)}>
              <option value="all">All ({vehicleIds.length})</option>
              {vehicleIds.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <label className="control-bar-check">
            <input type="checkbox" checked={eligibleOnly}
              onChange={(e) => setEligibleOnly(e.target.checked)} />
            Eligible only
          </label>
          <label className="control-bar-check">
            <input type="checkbox" checked={beatsOnly}
              onChange={(e) => setBeatsOnly(e.target.checked)} />
            Beats the status quo only
          </label>
          <span className="control-bar-count">
            {shown.length} of {graded.length} chains shown
            {droppedFromMatrix ? ` (${droppedFromMatrix} deferred from costing)` : ''}
          </span>
        </div>
      )}

      {status && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{status}</div>}
      {rungReached == null && costBasis === 'road' && shown.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          No rung reached the {threshold} acceptance score, so every rung is shown as a near miss.
        </div>
      )}
      {err && <div style={{ fontSize: 12, color: 'var(--text-error)' }}>{err}</div>}

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 380 }}>
        {/* Chain cards, grouped per vehicle */}
        <div style={{ width: 470, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {shown.length === 0 && !busy && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {graded.length === 0
                ? 'No chains to show.'
                : 'Every chain is filtered out. Loosen a slider or clear a filter.'}
            </div>
          )}
          {groups.map(({ trailer, items }) => (
            <div key={trailer} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                fontSize: 12, fontWeight: 700, paddingBottom: 4,
                borderBottom: '1px solid var(--border)',
              }}>
                <span>{trailer}</span>
                <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>
                  {items.length} {items.length === 1 ? 'chain' : 'chains'}
                  {' '}&middot; back to {place(items[0].TARGET_LABEL, items[0].TARGET_LON, items[0].TARGET_LAT)}
                </span>
              </div>
              {items.map((c) => (
                <ChainCard key={c.key} c={c} selected={c.key === selectedKey}
                  costed={costBasis === 'road'} onSelect={() => setSelectedKey(c.key)} />
              ))}
            </div>
          ))}
        </div>

        {/* Map */}
        <div style={{ display: 'grid', gridTemplateRows: 'minmax(0,1fr) auto', gap: 8, flex: 1, minHeight: 380 }}>
          <ProposalMap
            vehicles={vehicles} loads={loads} links={[]} stops={stops}
            legKinds={CHAIN_LEG_KINDS} endLabel="Return target"
            routeLegs={routeLegs} routePath={null} focusKey={selectedKey}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
            <button type="button" className="btn small secondary" onClick={() => setLegendOpen(true)}>
              Legend
            </button>
          </div>
          <LegendOverlay open={legendOpen} onClose={() => setLegendOpen(false)} title="Legend">
            <LegendSection title="Estate">
              <Swatch color={COLOR_VEHICLE} label="Vehicles waiting for a return" />
              <Swatch color={COLOR_INTERNAL} label="Own waiting loads" />
              <Swatch color={COLOR_EXTERNAL} label="External offers" />
            </LegendSection>
            <LegendSection title="Selected chain: stops">
              <Swatch color={[156, 163, 175]} label="1 - Start, where the vehicle empties" ring />
              <Swatch color={[245, 158, 11]} label="2, 4 - Pickups (hop 1, hop 2)" ring />
              <Swatch color={[22, 163, 74]} label="3, 5 - Deliveries (hop 1, hop 2)" ring />
              <Swatch color={[41, 181, 232]} label="6 - Return target" ring />
            </LegendSection>
            <LegendSection title="Selected chain: legs">
              <Line color={COLOR_LEG_EMPTY} dashed
                label="Empty running - to hop 1, between the hops, and the residual run from hop 2 to the target. No revenue." />
              <Line color={COLOR_LEG_LOADED}
                label="Loaded, revenue-bearing - hop 1 and hop 2 only." />
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
                {routeOnRoads
                  ? 'Legs follow the road network (live DIRECTIONS call per leg).'
                  : 'Some legs are drawn straight: the road geometry has not been returned for them. Distances on the cards are still road distances once costing has run.'}
              </div>
            </LegendSection>
          </LegendOverlay>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Presentational helpers
// --------------------------------------------------------------------------

function Slider({ label, unit, value, max, step = 5, onChange }: {
  label: string; unit: string; value: number; max: number; step?: number;
  onChange: (v: number) => void;
}) {
  const min = step;
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, minWidth: 150 }}>
      <span style={{ color: 'var(--text-secondary)' }}>
        {label}: <strong>{value}{unit && ` ${unit}`}</strong>
        <span style={{ color: 'var(--text-tertiary)' }}> / max {max}</span>
      </span>
      <input type="range" min={Math.min(min, max)} max={max} step={step} value={Math.min(value, max)}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Swatch({ color, label, ring = false }: {
  color: [number, number, number]; label: string; ring?: boolean;
}) {
  const rgb = `rgb(${color.join(',')})`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 6 }}>
      <span style={{
        width: 12, height: 12, borderRadius: ring ? '50%' : 3, flex: '0 0 auto',
        background: ring ? 'var(--surface)' : rgb,
        border: ring ? `2px solid ${rgb}` : 'none',
      }} />
      <span>{label}</span>
    </div>
  );
}

function Line({ color, label, dashed = false }: {
  color: [number, number, number]; label: string; dashed?: boolean;
}) {
  const rgb = `rgb(${color.join(',')})`;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, marginBottom: 6 }}>
      <span style={{
        width: 22, flex: '0 0 auto', marginTop: 7,
        borderTop: `3px ${dashed ? 'dashed' : 'solid'} ${rgb}`,
      }} />
      <span>{label}</span>
    </div>
  );
}

/** One chain card. Leg-by-leg, which is the level a planner acts at. */
function ChainCard({ c, selected, costed, onSelect }: {
  c: Costed; selected: boolean; costed: boolean; onSelect: () => void;
}) {
  return (
    <div onClick={onSelect}
      style={{
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 8, padding: 12, cursor: 'pointer',
        background: selected ? 'var(--surface-accent)' : 'var(--surface)',
      }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 12 }}>
          {RUNG_LABEL[c.CASCADE_RUNG]}
        </strong>
        <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {c.grade !== '-' && <>grade {c.grade} &middot; </>}
          rung {c.CASCADE_RUNG}
        </span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
        {RUNG_NOTE[c.CASCADE_RUNG]}
      </div>

      <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
        <div>
          <span style={{ color: 'var(--text-secondary)' }}>Empty to hop 1:</span>{' '}
          {place(c.EMPTY_CITY, c.EMPTY_LON, c.EMPTY_LAT)} &rarr;{' '}
          {place(c.LEG1_PICKUP_CITY, c.LEG1_PICKUP_LON, c.LEG1_PICKUP_LAT)}{' '}
          ({fmtKm(c.roadE1Km ?? c.LEG1_EMPTY_KM)})
        </div>
        <div>
          <span style={{ color: 'var(--text-secondary)' }}>Hop 1:</span>{' '}
          {place(c.LEG1_PICKUP_CITY, c.LEG1_PICKUP_LON, c.LEG1_PICKUP_LAT)} &rarr;{' '}
          {place(c.LEG1_DELIVERY_CITY, c.LEG1_DELIVERY_LON, c.LEG1_DELIVERY_LAT)}{' '}
          ({fmtKm(c.roadLoaded1Km ?? c.LEG1_LOADED_KM)}){' '}
          <em style={{ color: 'var(--text-secondary)' }}>({c.LEG1_IS_INTERNAL ? 'own load' : 'external'})</em>
        </div>
        <div>
          <span style={{ color: 'var(--text-secondary)' }}>Empty between hops:</span>{' '}
          {place(c.LEG1_DELIVERY_CITY, c.LEG1_DELIVERY_LON, c.LEG1_DELIVERY_LAT)} &rarr;{' '}
          {place(c.LEG2_PICKUP_CITY, c.LEG2_PICKUP_LON, c.LEG2_PICKUP_LAT)}{' '}
          ({fmtKm(c.roadE2Km ?? c.LEG2_EMPTY_KM)})
        </div>
        <div>
          <span style={{ color: 'var(--text-secondary)' }}>Hop 2:</span>{' '}
          {place(c.LEG2_PICKUP_CITY, c.LEG2_PICKUP_LON, c.LEG2_PICKUP_LAT)} &rarr;{' '}
          {place(c.LEG2_DELIVERY_CITY, c.LEG2_DELIVERY_LON, c.LEG2_DELIVERY_LAT)}{' '}
          ({fmtKm(c.roadLoaded2Km ?? c.LEG2_LOADED_KM)}){' '}
          <em style={{ color: 'var(--text-secondary)' }}>({c.LEG2_IS_INTERNAL ? 'own load' : 'external'})</em>
        </div>
        <div>
          <span style={{ color: 'var(--text-secondary)' }}>Empty residual to {place(c.TARGET_LABEL, c.TARGET_LON, c.TARGET_LAT)}:</span>{' '}
          {fmtKm(c.residualKm)}
        </div>
      </div>

      {/* Status quo comparison - the reason a planner would act. The chain's
          empty total includes the residual run, because the baseline is a
          complete run home. */}
      <div style={{
        marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)',
        fontSize: 11,
      }}>
        <div>
          Empty km: <strong>{fmtKm(c.emptyKm)}</strong>{' '}
          vs <strong>{fmtKm(c.baselineEmptyKm)}</strong> running home empty
          <span style={{ color: c.emptySavedKm > 0 ? 'var(--text-success)' : 'var(--text-error)' }}>
            {' '}({c.emptySavedKm > 0 ? '-' : '+'}{fmtKm(Math.abs(c.emptySavedKm))})
          </span>
        </div>
        <div>
          Net: <strong>{fmtUsd(c.netUsd)}</strong> vs <strong>{fmtUsd(c.baselineNetUsd)}</strong> doing nothing
          {' '}
          <span style={{ color: c.beatsBaseline ? 'var(--text-success)' : 'var(--text-error)' }}>
            {c.beatsBaseline ? 'better than the status quo' : 'does not beat the status quo'}
          </span>
        </div>
        {!costed && (
          <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>
            Straight-line estimate. Run costing for road distances.
          </div>
        )}
      </div>

      {/* Per-constraint chips, evaluated against the current slider values */}
      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {([
          ['Total empty', c.totalEmptyOk],
          ['Hop-1 detour', c.leg1DetourOk],
          ['Reaches target', c.targetOk],
          ['Hop order', c.sequenceOk],
        ] as [string, boolean][]).map(([label, ok]) => (
          <span key={label} className={`status-badge ${ok ? 'success' : 'critical'}`}>
            {ok ? '\u2713' : '\u2717'} {label}
          </span>
        ))}
      </div>
    </div>
  );
}

export default TriangleProposalsView;
