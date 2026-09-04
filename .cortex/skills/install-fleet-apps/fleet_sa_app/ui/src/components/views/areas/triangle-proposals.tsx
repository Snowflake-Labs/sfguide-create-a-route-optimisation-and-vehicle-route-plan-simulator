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
//     output is never precomputed or cached into a table).
//
//  3. A STATUS-QUO BASELINE. Each chain is shown against what the planner
//     would otherwise do: run empty to the target. Without that delta a chain
//     is a black box, and an experienced planner will not act on a black box.
//     A chain that does not beat the baseline is labelled as such rather than
//     presented as a win.
//
// Read-only: no write-back, no persisted decisions. No vendor branding.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { usePublishMapState } from '@/lib/agent-memo';
import type { ViewProps } from '@/lib/types';
import { sfRead, sqlLiteral } from './backload-matching/helpers';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';
import { isRoutingSuspendedError, type SuspendedInfo } from '@/lib/routing-suspend';
import ProposalMap, { type MapVehicle, type MapLoad, type MapStop } from './backload-proposals/ProposalMap';
import LegendOverlay, { LegendSection } from './backload-proposals/LegendOverlay';
import { COLOR_VEHICLE, COLOR_INTERNAL, COLOR_EXTERNAL, COLOR_LEG_EMPTY } from './backload-proposals/constants';

const BM = 'FLEET_APP.BACKLOAD_MATCHING';
const PHYS = 'FLEET_INTELLIGENCE.BACKLOAD_MATCHING';

// The routing gateway guards the number of locations per matrix call. A square
// matrix over N points is N*N cells, so keep N well inside that guardrail and
// cost the highest-ranked chains rather than truncating a response.
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
  NET_BENEFIT_USD: number;
  COST_PER_EMPTY_KM: number; REV_PER_LOADED_KM: number;
  TOTAL_EMPTY_CHECK: boolean; LEG1_DETOUR_CHECK: boolean;
  TARGET_CHECK: boolean; SEQUENCE_CHECK: boolean; ELIGIBLE: boolean;
}

/** A chain after live road costing + baseline comparison. */
interface Costed extends Chain {
  key: string;
  roadEmptyKm: number | null;    // road km across both empty runs
  roadLoadedKm: number | null;   // road km across both paying legs
  roadTotalKm: number | null;
  baselineEmptyKm: number | null;   // running empty straight to target instead
  emptySavedKm: number | null;      // baseline empty minus chain empty
  netUsd: number;                   // road-based when available
  baselineNetUsd: number;           // the status quo: empty run, no revenue
  beatsBaseline: boolean;
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

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmtKm(v: number | null | undefined): string {
  return v == null ? '-' : `${Math.round(v).toLocaleString()} km`;
}
function fmtUsd(v: number | null | undefined): string {
  return v == null ? '-' : `$${Math.round(v).toLocaleString()}`;
}
function place(s: string | null | undefined): string { return s && s.trim() ? s : 'unknown'; }
function toGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C+';
  if (score >= 50) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function TriangleProposalsView({ onStateChange }: Partial<ViewProps> = {}) {
  const region = useAppStore((s) => s.context['region']) as string | undefined;

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [suspended, setSuspended] = useState<SuspendedInfo | null>(null);
  const [chains, setChains] = useState<Chain[]>([]);
  const [costed, setCosted] = useState<Costed[]>([]);
  const [vehicles, setVehicles] = useState<MapVehicle[]>([]);
  const [loads, setLoads] = useState<MapLoad[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [threshold, setThreshold] = useState(70);
  const [profile, setProfile] = useState('driving-car');
  const [status, setStatus] = useState('');
  const [legendOpen, setLegendOpen] = useState(false);
  const [rungReached, setRungReached] = useState<number | null>(null);
  const [costBasis, setCostBasis] = useState<'great_circle' | 'road'>('great_circle');

  // ---------------------------------------------------------------------
  // Load the pruned chain skeletons + the estate for map context.
  // ---------------------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true); setErr(null); setSuspended(null);
    setCosted([]); setRungReached(null); setCostBasis('great_circle');
    try {
      const cfg = await sfRead(`SELECT VEHICLE_TYPE, REGION FROM ${BM}.VW_CONFIG LIMIT 1`);
      const vt = String(cfg[0]?.VEHICLE_TYPE ?? '');
      const [cls, tri, prm, veh, lds] = await Promise.all([
        sfRead(`SELECT ORS_PROFILE FROM ${BM}.VW_VEHICLE_CLASS WHERE VEHICLE_TYPE = '${sqlLiteral(vt)}' LIMIT 1`),
        sfRead(`SELECT * FROM ${PHYS}.VW_TRIANGLES`),
        sfRead(`SELECT PARAM_KEY, PARAM_VALUE FROM ${PHYS}.MATCH_PARAMS WHERE PARAM_KEY = 'CASCADE_GRADE_THRESHOLD'`),
        sfRead(`SELECT TRAILER_ID, EMPTY_LON, EMPTY_LAT FROM ${PHYS}.VW_TRAILERS_GEO`),
        sfRead(`SELECT LOAD_ID, IS_INTERNAL, SOURCE, PICKUP_CITY, PICKUP_LON, PICKUP_LAT FROM ${PHYS}.VW_LOADS`),
      ]);
      setProfile(String(cls[0]?.ORS_PROFILE ?? 'driving-car'));
      const t = Number(prm[0]?.PARAM_VALUE);
      if (Number.isFinite(t)) setThreshold(t);
      setChains(tri as unknown as Chain[]);
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
      setStatus((tri as unknown[]).length
        ? `${(tri as unknown[]).length} chain skeletons found. Run costing to price the legs on the road network.`
        : 'No chain is needed here: every load already delivers within the target radius, so a direct return exists. Chains are a long-haul pattern - switch to a wide-area dataset to see them.');
    } catch (e: unknown) {
      if (isRoutingSuspendedError(e)) setSuspended((e as { info: SuspendedInfo }).info);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, region]);

  // ---------------------------------------------------------------------
  // The cascade ladder. Chains already carry their rung; the ladder is the
  // POLICY over them: take the lowest rung that yields something acceptable,
  // and only then widen. Scoring is deliberately simple and explainable -
  // a dispatcher has to be able to reconstruct it.
  // ---------------------------------------------------------------------
  const scoreChain = useCallback((c: Chain, roadEmpty: number | null, baseline: number | null): number => {
    const empty = roadEmpty ?? c.TOTAL_EMPTY_KM;
    const loaded = c.TOTAL_LOADED_KM;
    // Utilisation: share of the chain that is revenue-bearing.
    const util = loaded / Math.max(1, loaded + empty);
    // Empty saved against running home empty, as a share of that baseline.
    const saved = baseline != null && baseline > 0
      ? Math.max(0, Math.min(1, (baseline - empty) / baseline))
      : 0;
    // How completely the chain closes the return.
    const closed = Math.max(0, Math.min(1,
      (c.TARGET_GAP_KM - c.FINAL_GAP_KM) / Math.max(1, c.TARGET_GAP_KM)));
    const raw = 100 * (0.45 * util + 0.35 * closed + 0.20 * saved);
    return Math.max(0, Math.min(100, raw));
  }, []);

  // ---------------------------------------------------------------------
  // Live road costing. ONE matrix call over every distinct point in the
  // candidate set, then each leg is looked up from it. The same matrix also
  // yields the baseline (empty straight to target), so the comparison is on
  // identical road data rather than one road figure against one straight line.
  //
  // MATRIX_TABULAR takes (profile, ORIGIN coords, DESTINATION coords, region)
  // and the gateway derives sources/destinations from the two arrays' LENGTHS,
  // so a full square matrix means passing the same coordinate list twice. It
  // requests metrics ['distance','duration'], hence distances in metres.
  // ---------------------------------------------------------------------
  const runCosting = useCallback(async () => {
    if (!chains.length) return;
    setLoading(true); setErr(null); setSuspended(null);
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

      const out: Costed[] = rows.map(({ c, iEmpty, iP1, iD1, iP2, iD2, iTgt }) => {
        const e1 = km(iEmpty, iP1), l1 = km(iP1, iD1);
        const e2 = km(iD1, iP2), l2 = km(iP2, iD2);
        const baseline = km(iEmpty, iTgt);
        const roadEmptyKm = e1 != null && e2 != null ? e1 + e2 : null;
        const roadLoadedKm = l1 != null && l2 != null ? l1 + l2 : null;
        const emptyKm = roadEmptyKm ?? c.TOTAL_EMPTY_KM;
        const loadedKm = roadLoadedKm ?? c.TOTAL_LOADED_KM;
        const netUsd = loadedKm * c.REV_PER_LOADED_KM - emptyKm * c.COST_PER_EMPTY_KM;
        // The status quo earns nothing and still burns the empty run home.
        const baselineNetUsd = -(baseline ?? c.TARGET_GAP_KM) * c.COST_PER_EMPTY_KM;
        const score = scoreChain(c, roadEmptyKm, baseline);
        return {
          ...c,
          key: `${c.TRAILER_ID}::${c.LEG1_LOAD_ID}::${c.LEG2_LOAD_ID}`,
          roadEmptyKm, roadLoadedKm,
          roadTotalKm: roadEmptyKm != null && roadLoadedKm != null ? roadEmptyKm + roadLoadedKm : null,
          baselineEmptyKm: baseline,
          emptySavedKm: baseline != null ? baseline - emptyKm : null,
          netUsd, baselineNetUsd,
          beatsBaseline: netUsd > baselineNetUsd,
          score, grade: toGrade(score),
        };
      });

      // Apply the ladder: lowest rung that clears the threshold wins.
      const eligible = out.filter((c) => c.ELIGIBLE);
      let reached: number | null = null;
      for (const rung of [1, 2, 3, 4]) {
        if (eligible.some((c) => c.CASCADE_RUNG === rung && c.score >= threshold)) { reached = rung; break; }
      }
      // Nothing cleared the bar anywhere: show every rung rather than an empty
      // page, and say so. A planner still wants to see the near misses.
      const kept = reached == null ? out : out.filter((c) => c.CASCADE_RUNG <= reached);
      kept.sort((a, b) => a.CASCADE_RUNG - b.CASCADE_RUNG || b.score - a.score);
      setCosted(kept);
      setRungReached(reached);
      setCostBasis('road');
      setSelectedKey(kept[0]?.key ?? '');
      setStatus(reached == null
        ? `Costed ${out.length} chains on the road network${dropped ? `, ${dropped} deferred to stay inside the matrix location limit` : ''}. None reached the ${threshold} acceptance score, so every rung is shown as a near miss.`
        : `Costed ${out.length} chains on the road network${dropped ? `, ${dropped} deferred to stay inside the matrix location limit` : ''}. Stopped at rung ${reached} (${RUNG_LABEL[reached]}) - the cascade did not need to widen further.`);
    } catch (e: unknown) {
      if (isRoutingSuspendedError(e)) setSuspended((e as { info: SuspendedInfo }).info);
      else setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [chains, profile, region, scoreChain, threshold]);

  const shown: Costed[] = useMemo(() => {
    if (costed.length) return costed;
    // Pre-costing: show the great-circle skeletons so the page is never blank.
    return chains.map((c) => ({
      ...c,
      key: `${c.TRAILER_ID}::${c.LEG1_LOAD_ID}::${c.LEG2_LOAD_ID}`,
      roadEmptyKm: null, roadLoadedKm: null, roadTotalKm: null,
      baselineEmptyKm: c.TARGET_GAP_KM,
      emptySavedKm: c.TARGET_GAP_KM - c.TOTAL_EMPTY_KM,
      netUsd: c.NET_BENEFIT_USD,
      baselineNetUsd: -c.TARGET_GAP_KM * c.COST_PER_EMPTY_KM,
      beatsBaseline: c.NET_BENEFIT_USD > -c.TARGET_GAP_KM * c.COST_PER_EMPTY_KM,
      score: 0, grade: '-',
    }));
  }, [chains, costed]);

  const selected = useMemo(
    () => shown.find((c) => c.key === selectedKey) ?? shown[0] ?? null,
    [shown, selectedKey],
  );

  useEffect(() => {
    if (shown.length && !shown.some((c) => c.key === selectedKey)) setSelectedKey(shown[0].key);
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

  // ---------------------------------------------------------------------
  // Agent grounding (Tenet 10). Publishes the SAME numbers the cards show,
  // pre-joined and bounded, plus the cascade outcome - otherwise the agent
  // answers chain questions from a different fact than the one on screen.
  // ---------------------------------------------------------------------
  const memoLine = useMemo(() => {
    if (!shown.length) {
      return chains.length === 0
        ? 'No two-hop chain is needed on this dataset: every load already delivers within the target radius of its vehicle, so a direct return exists. Chaining is a long-haul pattern.'
        : 'Chain skeletons loaded but not yet costed on the road network.';
    }
    const head = [
      `basis=${costBasis}`,
      `chains=${shown.length}`,
      `vehicles=${new Set(shown.map((c) => c.TRAILER_ID)).size}`,
      rungReached != null
        ? `cascade_stopped_at_rung=${rungReached} (${RUNG_LABEL[rungReached]})`
        : 'cascade=no rung cleared the acceptance score',
      `acceptance_score=${threshold}`,
    ].join(', ');
    const lines = shown.slice(0, 12).map((c) =>
      `${c.TRAILER_ID}: rung ${c.CASCADE_RUNG} ${RUNG_LABEL[c.CASCADE_RUNG]}; ` +
      `hop1 ${place(c.LEG1_PICKUP_CITY)} -> ${place(c.LEG1_DELIVERY_CITY)} (${c.LEG1_IS_INTERNAL ? 'internal' : 'external'}); ` +
      `hop2 ${place(c.LEG2_PICKUP_CITY)} -> ${place(c.LEG2_DELIVERY_CITY)} (${c.LEG2_IS_INTERNAL ? 'internal' : 'external'}); ` +
      `empty ${fmtKm(c.roadEmptyKm ?? c.TOTAL_EMPTY_KM)}, loaded ${fmtKm(c.roadLoadedKm ?? c.TOTAL_LOADED_KM)}; ` +
      `net ${fmtUsd(c.netUsd)} vs empty-run-home baseline ${fmtUsd(c.baselineNetUsd)}; ` +
      `${c.beatsBaseline ? 'beats baseline' : 'does NOT beat baseline'}; ` +
      `grade ${c.grade}; ${c.ELIGIBLE ? 'eligible' : 'near miss'}`,
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
    total_empty_km: shown.length
      ? Math.round(shown.reduce((s, c) => s + (c.roadEmptyKm ?? c.TOTAL_EMPTY_KM), 0)) : null,
    __memo_triangle_proposals: memoLine,
  }), [region, costBasis, chains.length, shown, rungReached, threshold, memoLine]);

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
          hop1: `${place(selected.LEG1_PICKUP_CITY)} -> ${place(selected.LEG1_DELIVERY_CITY)}`,
          hop2: `${place(selected.LEG2_PICKUP_CITY)} -> ${place(selected.LEG2_DELIVERY_CITY)}`,
          empty_km: String(Math.round(selected.roadEmptyKm ?? selected.TOTAL_EMPTY_KM)),
          beats_baseline: String(selected.beatsBaseline),
        }
        : undefined,
    };
  }, [vehicles.length, loads.length, stops.length, selected]));

  if (suspended) return <RoutingSuspendedNotice info={suspended} onRetry={() => void load()} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button onClick={() => void load()} disabled={loading}
          style={{ padding: '6px 12px', borderRadius: 6, cursor: loading ? 'wait' : 'pointer' }}>
          Reload chains
        </button>
        <button onClick={() => void runCosting()} disabled={loading || !chains.length}
          style={{ padding: '6px 12px', borderRadius: 6, fontWeight: 600, cursor: loading ? 'wait' : 'pointer' }}>
          Cost legs on road network
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          Acceptance score
          <input type="number" min={0} max={100} value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            style={{ width: 64, padding: '2px 4px' }} />
        </label>
        <span style={{ fontSize: 12, opacity: 0.75 }}>
          Cost basis: {costBasis === 'road' ? 'live road network' : 'straight-line estimate'}
        </span>
      </div>

      {status && <div style={{ fontSize: 12, opacity: 0.8 }}>{status}</div>}
      {err && <div style={{ fontSize: 12, color: '#b91c1c' }}>{err}</div>}

      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 380 }}>
        {/* Chain cards */}
        <div style={{ width: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.length === 0 && !loading && (
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              No chains to show.
            </div>
          )}
          {shown.map((c) => {
            const sel = c.key === selectedKey;
            return (
              <div key={c.key} onClick={() => setSelectedKey(c.key)}
                style={{
                  border: `1px solid ${sel ? '#29b5e8' : 'rgba(128,128,128,0.35)'}`,
                  borderRadius: 8, padding: 10, cursor: 'pointer',
                  background: sel ? 'rgba(41,181,232,0.08)' : 'transparent',
                }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>{c.TRAILER_ID}</strong>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>
                    {c.grade !== '-' && <>grade {c.grade} &middot; </>}
                    rung {c.CASCADE_RUNG}
                  </span>
                </div>
                <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>
                  {RUNG_LABEL[c.CASCADE_RUNG]} &middot; {RUNG_NOTE[c.CASCADE_RUNG]}
                </div>

                {/* Leg-by-leg, which is the level a planner acts at */}
                <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5 }}>
                  <div>
                    <span style={{ opacity: 0.65 }}>Empty to hop 1:</span>{' '}
                    {place(c.EMPTY_CITY)} &rarr; {place(c.LEG1_PICKUP_CITY)}{' '}
                    ({fmtKm(c.roadEmptyKm != null ? null : c.LEG1_EMPTY_KM)})
                  </div>
                  <div>
                    <span style={{ opacity: 0.65 }}>Hop 1:</span>{' '}
                    {place(c.LEG1_PICKUP_CITY)} &rarr; {place(c.LEG1_DELIVERY_CITY)}{' '}
                    <em style={{ opacity: 0.7 }}>({c.LEG1_IS_INTERNAL ? 'own load' : 'external'})</em>
                  </div>
                  <div>
                    <span style={{ opacity: 0.65 }}>Hop 2:</span>{' '}
                    {place(c.LEG2_PICKUP_CITY)} &rarr; {place(c.LEG2_DELIVERY_CITY)}{' '}
                    <em style={{ opacity: 0.7 }}>({c.LEG2_IS_INTERNAL ? 'own load' : 'external'})</em>
                  </div>
                  <div>
                    <span style={{ opacity: 0.65 }}>Remaining to {place(c.TARGET_LABEL)}:</span>{' '}
                    {fmtKm(c.FINAL_GAP_KM)}
                  </div>
                </div>

                {/* Status quo comparison - the reason a planner would act */}
                <div style={{
                  marginTop: 6, paddingTop: 6, borderTop: '1px dashed rgba(128,128,128,0.3)',
                  fontSize: 11,
                }}>
                  <div>
                    Empty km: <strong>{fmtKm(c.roadEmptyKm ?? c.TOTAL_EMPTY_KM)}</strong>{' '}
                    vs <strong>{fmtKm(c.baselineEmptyKm)}</strong> running home empty
                    {c.emptySavedKm != null && (
                      <span style={{ color: c.emptySavedKm > 0 ? '#15803d' : '#b91c1c' }}>
                        {' '}({c.emptySavedKm > 0 ? '-' : '+'}{fmtKm(Math.abs(c.emptySavedKm))})
                      </span>
                    )}
                  </div>
                  <div>
                    Net: <strong>{fmtUsd(c.netUsd)}</strong> vs <strong>{fmtUsd(c.baselineNetUsd)}</strong> doing nothing
                    {' '}
                    <span style={{ color: c.beatsBaseline ? '#15803d' : '#b91c1c' }}>
                      {c.beatsBaseline ? 'better than the status quo' : 'does not beat the status quo'}
                    </span>
                  </div>
                </div>

                {/* Per-constraint chips */}
                <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {([
                    ['Total empty', c.TOTAL_EMPTY_CHECK],
                    ['Hop-1 detour', c.LEG1_DETOUR_CHECK],
                    ['Reaches target', c.TARGET_CHECK],
                    ['Hop order', c.SEQUENCE_CHECK],
                  ] as [string, boolean][]).map(([label, ok]) => (
                    <span key={label} style={{
                      fontSize: 10, padding: '1px 6px', borderRadius: 10,
                      border: `1px solid ${ok ? 'rgba(21,128,61,0.5)' : 'rgba(185,28,28,0.5)'}`,
                      color: ok ? '#15803d' : '#b91c1c',
                    }}>{ok ? '\u2713' : '\u2717'} {label}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* Map */}
        <div style={{ flex: 1, position: 'relative', minHeight: 380 }}>
          <ProposalMap
            vehicles={vehicles} loads={loads} links={[]} stops={stops}
            routePath={null} focusKey={selectedKey}
          />
          <LegendOverlay open={legendOpen} onClose={() => setLegendOpen(false)} title="Legend">
            <LegendSection title="Estate">
              <span style={{ color: `rgb(${COLOR_VEHICLE.join(',')})` }}>Vehicles</span>
              <span style={{ color: `rgb(${COLOR_INTERNAL.join(',')})` }}>Own loads</span>
              <span style={{ color: `rgb(${COLOR_EXTERNAL.join(',')})` }}>External offers</span>
            </LegendSection>
            <LegendSection title="Chain">
              <span style={{ color: `rgb(${COLOR_LEG_EMPTY.join(',')})` }}>
                Stops 1-6: start, hop-1 pickup and delivery, hop-2 pickup and delivery, target
              </span>
            </LegendSection>
          </LegendOverlay>
        </div>
      </div>
    </div>
  );
}

export default TriangleProposalsView;
