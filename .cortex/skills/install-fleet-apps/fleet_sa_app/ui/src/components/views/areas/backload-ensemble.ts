// Ensemble scoring engine for the Backload Proposals cockpit.
//
// Pure, client-side, no React. Given proposal rows produced by running the four
// optimizer strategies (baseline / per-load VRP / fleet 1:1 / profit-max) into
// one working set, it de-duplicates to one row per (trailer, load) pair, scores
// each pair on seven 0-100 dimensions, assigns letter grades, counts how many
// strategies agreed, and - given dispatcher weights - produces a composite score
// and a ranked list. Splitting "score the pairs" (depends on proposals+params)
// from "rank by weights" (depends only on weights) lets the UI re-rank instantly
// when a slider moves, with no server round-trip. Ported from an internal Backload
// Proposals cockpit and made brand-neutral (LOAD_ID, neutral param keys).

export type EnsembleDimension =
  | 'costEff' | 'revenue' | 'margin' | 'feasibility' | 'utilization' | 'consolidation' | 'urgency';
export type EnsembleWeights = Record<EnsembleDimension, number>;
export type StrategyFamily = 'baseline' | 'vrp' | 'fleet' | 'bpmp';
export type LetterGrade = 'A' | 'B+' | 'B' | 'C+' | 'C' | 'D' | 'F';

export interface ProposalRow {
  PROPOSAL_ID: string;
  TRAILER_ID: string;
  LOAD_ID: string;
  DISTANCE_BASIS: string | null;
  EMPTY_KM: number | null;
  LOADED_KM: number | null;
  DETOUR_KM: number | null;
  TOTAL_KM: number | null;
  PICKUP_SLACK_HRS: number | null;
  FEASIBLE: boolean | null;
  STOP_SEQ: number | null;
  PICKUP_LON: number | null; PICKUP_LAT: number | null;
  DELIVERY_LON: number | null; DELIVERY_LAT: number | null;
  PICKUP_CITY: string | null; PICKUP_COUNTRY: string | null;
  DELIVERY_CITY: string | null; EMPTY_CITY: string | null;
  IS_INTERNAL?: boolean; SOURCE?: string | null;
}
export interface ParamRow { PARAM_KEY: string; PARAM_VALUE: string | null; }
export interface TrailerLoc { TRAILER_ID: string; EMPTY_FROM_TS: string | null; }

export interface ScoredPair {
  key: string; trailerId: string; loadId: string;
  bestProposalId: string; bestSource: StrategyFamily;
  agreement: number; families: StrategyFamily[];
  trailerConsensus: number; trailerConsensusOf: number;
  loadConsensus: number; loadConsensusOf: number;
  emptyKm: number | null; loadedKm: number | null; loadedKmEst: number | null;
  detourKm: number | null; totalKm: number | null; marginUsd: number | null;
  pickupSlackHrs: number | null; maxStopSeq: number | null; idleHours: number | null;
  feasible: boolean | null; isInternal: boolean;
  pickupCity: string | null; pickupCountry: string | null;
  deliveryCity: string | null; emptyCity: string | null;
  scores: Record<EnsembleDimension, number | null>;
  grades: Record<EnsembleDimension, LetterGrade | null>;
}
export interface RankedPair extends ScoredPair { composite: number; grade: LetterGrade; }
export interface RankedTrailer {
  trailerId: string; orders: RankedPair[]; best: RankedPair;
  composite: number; grade: LetterGrade; orderCount: number;
}

export const DIMENSIONS: EnsembleDimension[] = [
  'costEff', 'revenue', 'margin', 'feasibility', 'utilization', 'consolidation', 'urgency',
];

export const DIMENSION_LABELS: Record<EnsembleDimension, string> = {
  costEff: 'Cost efficiency',
  revenue: 'Revenue',
  margin: 'Net margin',
  feasibility: 'Feasibility',
  utilization: 'Utilization',
  consolidation: 'Consolidation',
  urgency: 'Asset urgency',
};

export const DIMENSION_HELP: Record<EnsembleDimension, string> = {
  costEff: 'Low empty (repositioning) km to reach the load',
  revenue: 'Loaded km times revenue benchmark - how much the backload earns',
  margin: 'Revenue minus repositioning cost (net economic value)',
  feasibility: 'Pickup slack + whether the solver found it time-feasible',
  utilization: 'Loaded / (loaded + empty) km - asset productivity',
  consolidation: 'Multi-stop tour potential (loads consolidated on one vehicle)',
  urgency: 'How long the vehicle has been idle - longer-idle assets score higher to prioritize re-employing them (asset velocity)',
};

// Named weight presets. Weights are relative - they need not sum to 1; the
// composite renormalizes per pair.
export const WEIGHT_PRESETS: Record<string, EnsembleWeights> = {
  Balanced:        { costEff: 0.12, revenue: 0.13, margin: 0.20, feasibility: 0.18, utilization: 0.15, consolidation: 0.10, urgency: 0.12 },
  'Cost-first':    { costEff: 0.30, revenue: 0.10, margin: 0.18, feasibility: 0.17, utilization: 0.10, consolidation: 0.05, urgency: 0.10 },
  'Margin-first':  { costEff: 0.10, revenue: 0.18, margin: 0.32, feasibility: 0.13, utilization: 0.10, consolidation: 0.07, urgency: 0.10 },
  'Asset-velocity':{ costEff: 0.15, revenue: 0.00, margin: 0.15, feasibility: 0.10, utilization: 0.25, consolidation: 0.00, urgency: 0.35 },
};

export const DEFAULT_WEIGHTS: EnsembleWeights = WEIGHT_PRESETS.Balanced;

const WEIGHTS_LS_KEY = 'backload.ensembleWeights';

export function loadWeights(): EnsembleWeights {
  try {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(WEIGHTS_LS_KEY) : null;
    if (!v) return { ...DEFAULT_WEIGHTS };
    const parsed = JSON.parse(v);
    const out = { ...DEFAULT_WEIGHTS };
    for (const d of DIMENSIONS) if (Number.isFinite(Number(parsed?.[d]))) out[d] = Number(parsed[d]);
    return out;
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

export function saveWeights(w: EnsembleWeights): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(WEIGHTS_LS_KEY, JSON.stringify(w));
  } catch { /* ignore quota / disabled storage */ }
}

// Map a DISTANCE_BASIS to its optimizer family.
export function familyOf(basis: string | null | undefined): StrategyFamily {
  const b = String(basis || '').toLowerCase();
  if (b.startsWith('vrp')) return 'vrp';
  if (b.startsWith('fleet')) return 'fleet';
  if (b.startsWith('bpmp')) return 'bpmp';
  return 'baseline';
}

export const FAMILY_LABELS: Record<StrategyFamily, string> = {
  baseline: 'Quick scan',
  vrp: 'Per-load VRP',
  fleet: 'Fleet 1:1',
  bpmp: 'Profit-max',
};

export function toGrade(score: number | null): LetterGrade | null {
  if (score == null || !Number.isFinite(score)) return null;
  if (score >= 90) return 'A';
  if (score >= 80) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C+';
  if (score >= 50) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function gradeColor(grade: LetterGrade | null): string {
  switch (grade) {
    case 'A':
    case 'B+': return 'var(--text-success, #16a34a)';
    case 'B':
    case 'C+': return 'var(--text-warning, #d97706)';
    case 'C':
    case 'D': return '#E8730C';
    case 'F': return 'var(--text-error, #dc2626)';
    default: return 'var(--text-secondary, #888)';
  }
}

const numParam = (params: ParamRow[], key: string, dflt: number): number => {
  const v = Number(params.find((p) => p.PARAM_KEY === key)?.PARAM_VALUE);
  return Number.isFinite(v) ? v : dflt;
};

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(Number(v));

function greatCircleKm(
  lon1: number | null, lat1: number | null, lon2: number | null, lat2: number | null,
): number | null {
  if (!finite(lon1) || !finite(lat1) || !finite(lon2) || !finite(lat2)) return null;
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLon = toRad(Number(lon2) - Number(lon1));
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(a))) * 10) / 10;
}

function rowCost(r: ProposalRow): number {
  if (finite(r.DETOUR_KM)) return Number(r.DETOUR_KM);
  if (finite(r.EMPTY_KM)) return Number(r.EMPTY_KM);
  return Number.POSITIVE_INFINITY;
}

// Phase A - de-duplicate proposals to one ScoredPair per (trailer, load) and
// compute per-dimension 0-100 scores + letter grades. Independent of weights.
export function computeScoredPairs(
  proposals: ProposalRow[], params: ParamRow[], trailers: TrailerLoc[] = [],
): ScoredPair[] {
  if (!proposals.length) return [];
  const costEmpty = numParam(params, 'COST_PER_EMPTY_KM', 1.2);
  const revLoaded = numParam(params, 'REVENUE_PER_LOADED_KM', 1.10);
  const maxEmptyKm = Math.max(1, numParam(params, 'MAX_EMPTY_KM', 100));
  const maxStops = Math.max(2, numParam(params, 'BPMP_MAX_STOPS', 4));
  const IDEAL_SLACK_HRS = 24;

  const nowMs = Date.now();
  const trailerIdleHrs: Record<string, number> = {};
  for (const t of trailers) {
    if (!t.EMPTY_FROM_TS) continue;
    const raw = String(t.EMPTY_FROM_TS);
    let ms = Date.parse(raw);
    if (!Number.isFinite(ms)) {
      const n = Number(raw);
      if (Number.isFinite(n)) ms = n * 1000;
    }
    if (!Number.isFinite(ms)) continue;
    trailerIdleHrs[t.TRAILER_ID] = Math.max(0, (nowMs - ms) / 3_600_000);
  }
  const idleValues = Object.values(trailerIdleHrs).sort((a, b) => a - b);
  const idlePercentile = (hrs: number): number => {
    if (!idleValues.length) return 50;
    let countLe = 0;
    for (const v of idleValues) { if (v <= hrs) countLe++; else break; }
    return clamp((countLe / idleValues.length) * 100);
  };

  const trailerStops: Record<string, number> = {};
  for (const p of proposals) {
    if (familyOf(p.DISTANCE_BASIS) === 'bpmp' && finite(p.STOP_SEQ)) {
      trailerStops[p.TRAILER_ID] = Math.max(trailerStops[p.TRAILER_ID] ?? 0, Number(p.STOP_SEQ));
    }
  }

  const bestLoadForTrailer = new Map<StrategyFamily, Map<string, string>>();
  const bestTrailerForLoad = new Map<StrategyFamily, Map<string, string>>();
  const bestCostByFamTrailer = new Map<string, number>();
  const bestCostByFamLoad = new Map<string, number>();
  const familiesPerTrailer = new Map<string, Set<StrategyFamily>>();
  const familiesPerLoad = new Map<string, Set<StrategyFamily>>();
  const addTo = <K>(m: Map<K, Set<StrategyFamily>>, k: K, f: StrategyFamily) => {
    const s = m.get(k); if (s) s.add(f); else m.set(k, new Set([f]));
  };
  for (const r of proposals) {
    const fam = familyOf(r.DISTANCE_BASIS);
    const c = rowCost(r);
    addTo(familiesPerTrailer, r.TRAILER_ID, fam);
    addTo(familiesPerLoad, r.LOAD_ID, fam);
    const tk = `${fam}::${r.TRAILER_ID}`;
    if (!bestCostByFamTrailer.has(tk) || c < (bestCostByFamTrailer.get(tk) as number)) {
      bestCostByFamTrailer.set(tk, c);
      if (!bestLoadForTrailer.has(fam)) bestLoadForTrailer.set(fam, new Map());
      bestLoadForTrailer.get(fam)!.set(r.TRAILER_ID, r.LOAD_ID);
    }
    const ok = `${fam}::${r.LOAD_ID}`;
    if (!bestCostByFamLoad.has(ok) || c < (bestCostByFamLoad.get(ok) as number)) {
      bestCostByFamLoad.set(ok, c);
      if (!bestTrailerForLoad.has(fam)) bestTrailerForLoad.set(fam, new Map());
      bestTrailerForLoad.get(fam)!.set(r.LOAD_ID, r.TRAILER_ID);
    }
  }
  const trailerConsensusFor = (trailerId: string, loadId: string): number => {
    let n = 0;
    const fams = familiesPerTrailer.get(trailerId);
    if (fams) for (const f of fams) if (bestLoadForTrailer.get(f)?.get(trailerId) === loadId) n++;
    return n;
  };
  const loadConsensusFor = (loadId: string, trailerId: string): number => {
    let n = 0;
    const fams = familiesPerLoad.get(loadId);
    if (fams) for (const f of fams) if (bestTrailerForLoad.get(f)?.get(loadId) === trailerId) n++;
    return n;
  };

  const groups = new Map<string, ProposalRow[]>();
  for (const p of proposals) {
    const key = `${p.TRAILER_ID}::${p.LOAD_ID}`;
    const g = groups.get(key);
    if (g) g.push(p); else groups.set(key, [p]);
  }

  const pairs: ScoredPair[] = [];
  for (const [key, rows] of groups) {
    const best = rows.reduce((a, b) => (rowCost(b) < rowCost(a) ? b : a));
    const families = Array.from(new Set(rows.map((r) => familyOf(r.DISTANCE_BASIS))));
    const minOf = (sel: (r: ProposalRow) => number | null) => {
      const vals = rows.map(sel).filter(finite) as number[];
      return vals.length ? Math.min(...vals) : null;
    };
    const maxOf = (sel: (r: ProposalRow) => number | null) => {
      const vals = rows.map(sel).filter(finite) as number[];
      return vals.length ? Math.max(...vals) : null;
    };
    const emptyKm = minOf((r) => r.EMPTY_KM);
    const loadedKm = maxOf((r) => r.LOADED_KM);
    const detourKm = minOf((r) => r.DETOUR_KM);
    const totalKm = minOf((r) => r.TOTAL_KM);
    const slack = maxOf((r) => r.PICKUP_SLACK_HRS);
    const feasible = rows.some((r) => r.FEASIBLE === true)
      ? true
      : rows.some((r) => r.FEASIBLE === false) ? false : null;
    const maxStopSeq = trailerStops[best.TRAILER_ID] ?? null;
    const idleHours = trailerIdleHrs[best.TRAILER_ID] ?? null;
    const loadedKmEst = greatCircleKm(best.PICKUP_LON, best.PICKUP_LAT, best.DELIVERY_LON, best.DELIVERY_LAT);
    const marginUsd = finite(loadedKm) && finite(emptyKm)
      ? Number(loadedKm) * revLoaded - Number(emptyKm) * costEmpty
      : (finite(loadedKm) ? Number(loadedKm) * revLoaded : null);

    pairs.push({
      key,
      trailerId: best.TRAILER_ID,
      loadId: best.LOAD_ID,
      bestProposalId: best.PROPOSAL_ID,
      bestSource: familyOf(best.DISTANCE_BASIS),
      agreement: families.length,
      families,
      trailerConsensus: trailerConsensusFor(best.TRAILER_ID, best.LOAD_ID),
      trailerConsensusOf: familiesPerTrailer.get(best.TRAILER_ID)?.size ?? 0,
      loadConsensus: loadConsensusFor(best.LOAD_ID, best.TRAILER_ID),
      loadConsensusOf: familiesPerLoad.get(best.LOAD_ID)?.size ?? 0,
      emptyKm, loadedKm, loadedKmEst, detourKm, totalKm, marginUsd,
      pickupSlackHrs: slack, maxStopSeq, idleHours, feasible,
      isInternal: best.IS_INTERNAL === true,
      pickupCity: best.PICKUP_CITY, pickupCountry: best.PICKUP_COUNTRY,
      deliveryCity: best.DELIVERY_CITY, emptyCity: best.EMPTY_CITY,
      scores: { costEff: null, revenue: null, margin: null, feasibility: null, utilization: null, consolidation: null, urgency: null },
      grades: { costEff: null, revenue: null, margin: null, feasibility: null, utilization: null, consolidation: null, urgency: null },
    });
  }

  const econLoaded = (p: ScoredPair): number | null =>
    finite(p.loadedKm) ? Number(p.loadedKm) : (finite(p.loadedKmEst) ? Number(p.loadedKmEst) : null);
  const econMargin = (p: ScoredPair): number | null => {
    const L = econLoaded(p);
    if (L == null) return null;
    return finite(p.emptyKm) ? L * revLoaded - Number(p.emptyKm) * costEmpty : L * revLoaded;
  };

  const revenues = pairs.map((p) => { const L = econLoaded(p); return L != null ? L * revLoaded : null; }).filter(finite) as number[];
  const margins = pairs.map(econMargin).filter(finite) as number[];
  const revP90 = percentile(revenues, 0.90);
  const marginMin = margins.length ? Math.min(...margins) : 0;
  const marginMax = margins.length ? Math.max(...margins) : 0;

  for (const p of pairs) {
    p.scores.costEff = finite(p.emptyKm)
      ? clamp(100 - (Number(p.emptyKm) / maxEmptyKm) * 100)
      : null;

    const econL = econLoaded(p);
    const rev = econL != null ? econL * revLoaded : null;
    p.scores.revenue = rev != null && revP90 > 0 ? clamp((rev / revP90) * 100) : null;

    const m = econMargin(p);
    p.scores.margin = m != null && marginMax > marginMin
      ? clamp(((m - marginMin) / (marginMax - marginMin)) * 100)
      : (m != null ? 60 : null);

    if (p.feasible === false) p.scores.feasibility = 0;
    else if (finite(p.pickupSlackHrs)) p.scores.feasibility = clamp((Number(p.pickupSlackHrs) / IDEAL_SLACK_HRS) * 100);
    else p.scores.feasibility = p.feasible === true ? 70 : null;

    p.scores.utilization = econL != null && finite(p.emptyKm) && (econL + Number(p.emptyKm)) > 0
      ? clamp((econL / (econL + Number(p.emptyKm))) * 100)
      : null;

    if (finite(p.maxStopSeq)) {
      const stops = Number(p.maxStopSeq);
      p.scores.consolidation = stops <= 1 ? 50 : clamp((stops / maxStops) * 100);
    } else {
      p.scores.consolidation = null;
    }

    p.scores.urgency = finite(p.idleHours) ? idlePercentile(Number(p.idleHours)) : null;

    for (const d of DIMENSIONS) p.grades[d] = toGrade(p.scores[d]);
  }

  return pairs;
}

// Phase B - apply weights to produce a composite 0-100 + overall grade.
export function rankByWeights(pairs: ScoredPair[], weights: EnsembleWeights): RankedPair[] {
  const ranked = pairs.map((p) => {
    let wSum = 0, acc = 0;
    for (const d of DIMENSIONS) {
      const s = p.scores[d];
      const w = Math.max(0, Number(weights[d]) || 0);
      if (s == null || w === 0) continue;
      acc += s * w;
      wSum += w;
    }
    const composite = wSum > 0 ? acc / wSum : 0;
    return { ...p, composite, grade: toGrade(composite) ?? 'F' };
  });
  ranked.sort((a, b) =>
    b.composite - a.composite
    || b.agreement - a.agreement
    || (a.emptyKm ?? Infinity) - (b.emptyKm ?? Infinity));
  return ranked;
}

// Phase C - group ranked pairs into one entry per trailer for the per-trailer card.
export function groupByTrailer(ranked: RankedPair[]): RankedTrailer[] {
  const byTrailer = new Map<string, RankedPair[]>();
  for (const p of ranked) {
    const g = byTrailer.get(p.trailerId);
    if (g) g.push(p); else byTrailer.set(p.trailerId, [p]);
  }
  const trailers: RankedTrailer[] = [];
  for (const [trailerId, orders] of byTrailer) {
    orders.sort((a, b) =>
      b.composite - a.composite
      || b.agreement - a.agreement
      || (a.emptyKm ?? Infinity) - (b.emptyKm ?? Infinity));
    const best = orders[0];
    trailers.push({ trailerId, orders, best, composite: best.composite, grade: best.grade, orderCount: orders.length });
  }
  trailers.sort((a, b) => b.composite - a.composite || b.orderCount - a.orderCount);
  return trailers;
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const arr = [...sorted].sort((a, b) => a - b);
  const idx = clamp(q, 0, 1) * (arr.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}
