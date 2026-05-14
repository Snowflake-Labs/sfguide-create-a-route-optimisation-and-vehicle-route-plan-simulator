import { useEffect, useState, useRef } from 'react';

// Mirrors the BuildSummary type defined in server/logParser.ts. We re-declare
// it on the client to avoid a path-alias setup; field names must match
// exactly.
export interface BuildSummary {
  phase: 'waiting' | 'initializing' | 'importing' | 'ch_preparing' | 'ch_contracting' | 'lm_preparing' | 'ready' | 'unknown';
  progress: number;
  currentProfile: string | null;
  profiles: { name: string; state: 'pending' | 'importing' | 'ch' | 'lm' | 'done' }[];
  lm?: {
    stepIndex: number;
    stepTotal: number;
    currentVariant: string;
    finishedVariants: string[];
    lastEventAt: string;
    avgStepMs: number | null;
    etaMs: number | null;
    elapsedMs: number;
  };
  ch?: { nodesStart: number; nodesRemaining: number; fractionDone: number };
  memory?: { usedMB: number; totalMB: number };
  healthReady: boolean;
  serviceReady: boolean;
  startedApplication: boolean;
  warnings: string[];
  completedProfiles?: string[];
  totalProfiles?: number;
  detail?: string;
  phaseLegacy?: string;
}

interface Props {
  region: string;
  summary?: BuildSummary;
  displayName?: string;
}

const PHASE_LABEL: Record<BuildSummary['phase'], string> = {
  waiting: 'Waiting for service',
  initializing: 'ORS engine starting up',
  importing: 'Importing OSM data',
  ch_preparing: 'Preparing contraction hierarchies',
  ch_contracting: 'Contracting nodes',
  lm_preparing: 'Landmark preparation',
  ready: 'Ready',
  unknown: 'Status unknown',
};

function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '\u2014';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}:${s.toString().padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm.toString().padStart(2, '0')}m`;
}

export default function BuildSummaryCard({ region, summary, displayName }: Props) {
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const fetchedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!logsExpanded) return;
    if (fetchedFor.current === region) return;
    let cancelled = false;
    setLogsLoading(true);
    setLogsError(null);
    fetch(`/api/regions/${encodeURIComponent(region)}/logs?tail=100`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.error) setLogsError(d.error);
        else setLogLines(Array.isArray(d?.lines) ? d.lines : []);
        fetchedFor.current = region;
      })
      .catch((e) => { if (!cancelled) setLogsError(String(e?.message || e)); })
      .finally(() => { if (!cancelled) setLogsLoading(false); });
    return () => { cancelled = true; };
  }, [logsExpanded, region]);

  if (!summary) {
    return (
      <div className="build-summary-card empty">
        <div className="build-summary-row">
          <strong>{displayName || region}</strong>
          <span style={{ opacity: 0.7, fontSize: 12 }}>Waiting for first status update...</span>
        </div>
      </div>
    );
  }

  const phase = summary.phase || 'unknown';
  const phaseLabel = PHASE_LABEL[phase] || phase;
  const progress = Math.max(0, Math.min(100, summary.progress || 0));
  const memPct = summary.memory && summary.memory.totalMB > 0
    ? Math.round((summary.memory.usedMB / summary.memory.totalMB) * 100)
    : null;
  const memBadgeClass = memPct == null ? '' : memPct >= 90 ? 'warn' : memPct >= 75 ? 'soft' : 'ok';

  return (
    <div className="build-summary-card">
      <div className="build-summary-row build-summary-header">
        <strong>{displayName || region}</strong>
        {summary.lm && (
          <span className="build-summary-badge accent" title={`Landmark step ${summary.lm.stepIndex} of ${summary.lm.stepTotal}`}>
            LM {summary.lm.stepIndex}/{summary.lm.stepTotal}
          </span>
        )}
        {memPct != null && (
          <span className={`build-summary-badge ${memBadgeClass}`} title={`${summary.memory!.usedMB} / ${summary.memory!.totalMB} MB`}>
            {memPct}% mem
          </span>
        )}
        {phase === 'ready' && <span className="build-summary-badge ok">Ready</span>}
      </div>

      <div className="build-summary-row" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        <span>Phase: <strong style={{ color: 'inherit' }}>{phaseLabel}</strong></span>
        {summary.currentProfile && phase !== 'ready' && (
          <span>Profile: <strong style={{ color: 'inherit' }}>{summary.currentProfile}</strong></span>
        )}
      </div>

      <div className="build-progress" style={{ margin: '6px 0' }}>
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="progress-stats">
          <span>{progress}%</span>
          {summary.lm && phase === 'lm_preparing' && (
            <span title={summary.lm.currentVariant}>
              LM {summary.lm.stepIndex}/{summary.lm.stepTotal} \u00b7 {summary.lm.currentVariant}
            </span>
          )}
          {summary.ch && (phase === 'ch_preparing' || phase === 'ch_contracting') && (
            <span>{Math.round((1 - summary.ch.fractionDone) * (summary.ch.nodesStart || 0) / 1000)}K nodes left</span>
          )}
        </div>
      </div>

      {summary.lm && (summary.lm.elapsedMs > 0 || summary.lm.etaMs != null) && (
        <div className="build-summary-row" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          <span>elapsed {formatMs(summary.lm.elapsedMs)}</span>
          {summary.lm.etaMs != null && (
            <span>~{formatMs(summary.lm.etaMs)} remaining</span>
          )}
          {summary.lm.avgStepMs != null && (
            <span>avg step {formatMs(summary.lm.avgStepMs)}</span>
          )}
        </div>
      )}

      {summary.profiles && summary.profiles.length > 0 && (
        <div className="build-summary-row" style={{ fontSize: 11, gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Profiles:</span>
          {summary.profiles.map((p) => (
            <span
              key={p.name}
              className={`build-summary-badge ${p.state === 'done' ? 'ok' : 'soft'}`}
              title={p.state}
            >
              {p.name}
            </span>
          ))}
        </div>
      )}

      {summary.warnings && summary.warnings.length > 0 && (
        <div className="build-summary-row" style={{ fontSize: 11, gap: 4, flexWrap: 'wrap' }}>
          {summary.warnings.map((w, i) => (
            <span key={i} className="build-summary-badge warn" title={w}>
              {w.length > 80 ? w.slice(0, 80) + '\u2026' : w}
            </span>
          ))}
        </div>
      )}

      <button
        type="button"
        className="btn small ghost"
        style={{ marginTop: 6, alignSelf: 'flex-start' }}
        onClick={() => {
          setLogsExpanded((v) => {
            const next = !v;
            if (next) fetchedFor.current = null;
            return next;
          });
        }}
      >
        {logsExpanded ? 'Hide recent logs' : 'Show recent logs'}
      </button>

      {logsExpanded && (
        <div className="build-summary-logs">
          {logsLoading && <div style={{ fontSize: 12, opacity: 0.7 }}>Loading...</div>}
          {logsError && <div style={{ fontSize: 12, color: 'var(--error, #e53935)' }}>Error: {logsError}</div>}
          {!logsLoading && !logsError && (
            <pre>{logLines.join('\n')}</pre>
          )}
        </div>
      )}
    </div>
  );
}
