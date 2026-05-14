// parseOrsBuildLogs() — extracts a structured BuildSummary from an ORS service
// log tail produced by SYSTEM$GET_SERVICE_LOGS. Pure regex parsing, never
// throws — on any failure returns a safe `unknown`/0 fallback so the
// /api/regions/:region/build-progress endpoint can never 500.
//
// Issue #40: surfaces phase / LM N/4 / current profile / elapsed / ETA /
// memory pressure / warnings to the Region Builder UI.

export type BuildPhase =
  | 'waiting'
  | 'initializing'
  | 'importing'
  | 'ch_preparing'
  | 'ch_contracting'
  | 'lm_preparing'
  | 'ready'
  | 'unknown';

export type ProfileState =
  | 'pending'
  | 'importing'
  | 'ch'
  | 'lm'
  | 'done';

export interface BuildSummary {
  phase: BuildPhase;
  /** 0..100 derived progress estimate */
  progress: number;
  currentProfile: string | null;
  profiles: {
    name: string;
    state: ProfileState;
    startedAt?: string;
    finishedAt?: string;
  }[];
  lm?: {
    /** 1..4 */
    stepIndex: number;
    /** 4 in ORS 9.0.x */
    stepTotal: number;
    /** e.g. car_ors_fastest_with_turn_costs */
    currentVariant: string;
    finishedVariants: string[];
    /** ISO timestamp of the most recent LM event */
    lastEventAt: string;
    /** Average ms between consecutive `LM <variant> finished` events */
    avgStepMs: number | null;
    /** ms remaining estimate; null if not enough samples */
    etaMs: number | null;
    /** ms since first LM event seen */
    elapsedMs: number;
  };
  ch?: {
    nodesStart: number;
    nodesRemaining: number;
    /** 0..1 */
    fractionDone: number;
  };
  memory?: {
    usedMB: number;
    totalMB: number;
  };
  healthReady: boolean;
  serviceReady: boolean;
  startedApplication: boolean;
  /** Last ~5 WARN log lines (best-effort) */
  warnings: string[];
  /** Backward-compat fields populated for the existing UI */
  completedProfiles?: string[];
  totalProfiles?: number;
  /** Numeric profile-level progress 0..100 (CH contraction). Optional. */
  profileProgress?: number;
  nodesRemaining?: number;
  nodesTotal?: number;
  detail?: string;
}

const TIMESTAMP_RE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const LM_PREPARE_RE = /(\d)\/(\d)\s+calling LM prepare\.doWork for (\S+)/g;
const LM_FINISHED_RE = /LM (\S+) finished/g;
const EDGE_NODES_RE = /edge,\s*nodes:\s*([\d\s]+\d).*?totalMB:(\d+),\s*usedMB:(\d+)/g;
const STARTED_APP_RE = /Started Application in [\d.]+ seconds/;
const CH_PREPARE_RE = /Creating CH preparations/;
const CH_CONTRACTING_RE = /start contracting nodes|start creating contraction hierarchies/i;
const LM_PREPARING_BANNER_RE = /Creating LM preparations/;
const GRAPH_BUILD_RE = /start creating graph|prepare graph for routing/;
const PROFILE_TAG_RE = /ORS-pl-([\w-]+)/g;
const PROFILE_DONE_RE = /\[\d+\] Profiles?: '([\w-]+)'/g;
const WARN_RE = /\b(WARN|WARNING)\b\s+.{1,200}/g;

const emptySummary = (): BuildSummary => ({
  phase: 'unknown',
  progress: 0,
  currentProfile: null,
  profiles: [],
  healthReady: false,
  serviceReady: false,
  startedApplication: false,
  warnings: [],
  completedProfiles: [],
  totalProfiles: 0,
});

function parseTimestampMs(line: string): number | null {
  const m = line.match(TIMESTAMP_RE);
  if (!m) return null;
  // ORS logs use UTC-naive timestamps; treat them as UTC for delta math.
  const t = Date.parse(m[1].replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? null : t;
}

function parseNum(s: string): number {
  return parseInt(s.replace(/\s+/g, ''), 10);
}

export function parseOrsBuildLogs(rawLogs: string): BuildSummary {
  if (!rawLogs || typeof rawLogs !== 'string') return emptySummary();
  let logs: string;
  try {
    logs = rawLogs.replace(ANSI_RE, '');
  } catch {
    return emptySummary();
  }

  try {
    const summary = emptySummary();

    // ---------- Profiles seen ----------
    const startedProfiles = [...new Set([...logs.matchAll(PROFILE_TAG_RE)].map((m) => m[1]))];
    const finishedProfiles = [...new Set([...logs.matchAll(PROFILE_DONE_RE)].map((m) => m[1]))];
    summary.completedProfiles = finishedProfiles;
    summary.totalProfiles = Math.max(startedProfiles.length, finishedProfiles.length);

    summary.profiles = startedProfiles.map((name) => ({
      name,
      state: finishedProfiles.includes(name) ? 'done' : 'pending',
    }));

    const lastStarted = startedProfiles[startedProfiles.length - 1] || null;
    const currentProfile = lastStarted && !finishedProfiles.includes(lastStarted) ? lastStarted : null;
    summary.currentProfile = currentProfile;

    // ---------- Started Application / LM banner ----------
    summary.startedApplication = STARTED_APP_RE.test(logs);

    const hasGraphBuild = GRAPH_BUILD_RE.test(logs);
    const hasCHPreparing = CH_PREPARE_RE.test(logs);
    const hasCHContracting = CH_CONTRACTING_RE.test(logs);
    const hasLMBanner = LM_PREPARING_BANNER_RE.test(logs);

    // ---------- Edge / nodes / memory ----------
    const edgeMatches = [...logs.matchAll(EDGE_NODES_RE)];
    if (edgeMatches.length > 0) {
      const first = edgeMatches[0];
      const last = edgeMatches[edgeMatches.length - 1];
      const nodesStart = parseNum(first[1]);
      const nodesRemaining = parseNum(last[1]);
      const fractionDone = nodesStart > 0 ? Math.max(0, Math.min(1, 1 - nodesRemaining / nodesStart)) : 0;
      summary.ch = { nodesStart, nodesRemaining, fractionDone };
      summary.memory = {
        totalMB: parseInt(last[2], 10),
        usedMB: parseInt(last[3], 10),
      };
      summary.nodesTotal = nodesStart;
      summary.nodesRemaining = nodesRemaining;
      summary.profileProgress = Math.round(fractionDone * 100);
    }

    // ---------- LM preparation: variants + ETA ----------
    const lmCalls = [...logs.matchAll(LM_PREPARE_RE)];
    const lmFinishedMatches: { variant: string; ts: number | null; lineStart: number }[] = [];

    // Walk lines so we can recover the timestamp prefix for each `LM ... finished` line.
    const lines = logs.split('\n');
    let runningOffset = 0;
    for (const line of lines) {
      const fin = line.match(/LM (\S+) finished/);
      if (fin) {
        lmFinishedMatches.push({
          variant: fin[1],
          ts: parseTimestampMs(line),
          lineStart: runningOffset,
        });
      }
      runningOffset += line.length + 1;
    }

    if (lmCalls.length > 0 || lmFinishedMatches.length > 0) {
      const lastCall = lmCalls[lmCalls.length - 1];
      const stepIndex = lastCall ? parseInt(lastCall[1], 10) : 1;
      const stepTotal = lastCall ? parseInt(lastCall[2], 10) : 4;
      const currentVariant = lastCall ? lastCall[3] : (lmFinishedMatches[lmFinishedMatches.length - 1]?.variant ?? '');
      const finishedVariants = lmFinishedMatches.map((m) => m.variant);
      const tsList = lmFinishedMatches.map((m) => m.ts).filter((t): t is number => t != null);

      let avgStepMs: number | null = null;
      if (tsList.length >= 2) {
        const gaps: number[] = [];
        for (let i = 1; i < tsList.length; i++) gaps.push(tsList[i] - tsList[i - 1]);
        const sum = gaps.reduce((a, b) => a + b, 0);
        avgStepMs = gaps.length > 0 ? sum / gaps.length : null;
      }

      const expectedLMs = Math.max(stepTotal * Math.max(1, summary.totalProfiles || 1), stepTotal);
      const remaining = Math.max(0, expectedLMs - finishedVariants.length);
      const etaMs = avgStepMs != null ? Math.round(avgStepMs * remaining) : null;
      const lastEventTs = tsList.length > 0 ? tsList[tsList.length - 1] : null;
      const firstEventTs = tsList.length > 0 ? tsList[0] : null;
      const elapsedMs = firstEventTs != null && lastEventTs != null ? lastEventTs - firstEventTs : 0;

      summary.lm = {
        stepIndex,
        stepTotal,
        currentVariant,
        finishedVariants,
        lastEventAt: lastEventTs != null ? new Date(lastEventTs).toISOString() : '',
        avgStepMs,
        etaMs,
        elapsedMs,
      };
    }

    // ---------- Warnings (last 5) ----------
    const warnMatches = [...logs.matchAll(WARN_RE)].map((m) => m[0].split('\n')[0].trim()).filter(Boolean);
    summary.warnings = warnMatches.slice(-5);

    // ---------- Phase decision ----------
    let phase: BuildPhase = 'waiting';
    if (summary.startedApplication && finishedProfiles.length > 0 && finishedProfiles.length === summary.totalProfiles) {
      phase = 'ready';
    } else if (hasLMBanner || lmCalls.length > 0) {
      phase = 'lm_preparing';
    } else if (hasCHContracting) {
      phase = 'ch_contracting';
    } else if (hasCHPreparing) {
      phase = 'ch_preparing';
    } else if (hasGraphBuild) {
      phase = 'importing';
    } else if (currentProfile || /Spring Boot|Starting Application/.test(logs)) {
      phase = 'initializing';
    } else if (logs.length > 0) {
      phase = 'waiting';
    }
    summary.phase = phase;

    // ---------- Progress ----------
    const profilesDoneCount = finishedProfiles.length;
    const totalProfilesSafe = Math.max(1, summary.totalProfiles || 1);
    let progress = 0;
    switch (phase) {
      case 'ready':
        progress = 100;
        break;
      case 'lm_preparing': {
        // Allocate the last 30% of a profile to LM (4 steps).
        const stepFrac = summary.lm ? summary.lm.finishedVariants.length / Math.max(1, summary.lm.stepTotal) : 0;
        const inProfile = 0.7 + 0.3 * Math.min(1, stepFrac);
        progress = Math.min(99, Math.round(((profilesDoneCount + inProfile) / totalProfilesSafe) * 100));
        break;
      }
      case 'ch_contracting':
      case 'ch_preparing': {
        const inProfile = 0.4 + 0.3 * (summary.ch?.fractionDone ?? 0);
        progress = Math.min(99, Math.round(((profilesDoneCount + inProfile) / totalProfilesSafe) * 100));
        break;
      }
      case 'importing':
        progress = Math.min(95, Math.round(((profilesDoneCount + 0.2) / totalProfilesSafe) * 100));
        break;
      case 'initializing':
        progress = Math.min(95, Math.round((profilesDoneCount / totalProfilesSafe) * 100) + 5);
        break;
      default:
        progress = totalProfilesSafe > 0 ? Math.round((profilesDoneCount / totalProfilesSafe) * 100) : 0;
    }
    summary.progress = progress;

    // Backward-compat detail string for older UI consumers.
    if (phase === 'lm_preparing') summary.detail = 'Landmark preparation';
    else if (phase === 'ch_contracting') summary.detail = 'Contraction hierarchies';
    else if (phase === 'importing') summary.detail = currentProfile ? `Importing OSM data for ${currentProfile}` : 'Importing OSM data';

    return summary;
  } catch {
    return emptySummary();
  }
}

export const __test__ = {
  emptySummary,
  parseTimestampMs,
};
