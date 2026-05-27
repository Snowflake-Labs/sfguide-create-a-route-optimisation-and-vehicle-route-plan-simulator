// BuildSummaryCard (#40)
//
// Single self-contained card the user can pin to the top of the Region
// Builder while a long-running graph build is in flight. Combines:
//   * overall progress bar
//   * current profile + LM progress in N/M form (parsed by
//     /api/regions/:region/build-progress)
//   * rolling ETA from CH node decay + elapsed time
//   * collapsible 30-line log tail from /api/regions/:region/logs
//
// All UI here is read-only; cancel / dismiss still live in ActiveJobsTable.

import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { ProvisionJob } from '../helpers';
import type { BuildProgress } from '../types';
import { getTimeSince } from './shared';

interface Props {
  job: ProvisionJob;
  buildProgress?: BuildProgress;
}

function formatEta(progressPct: number, startedAt?: string | null): string | null {
  if (!startedAt || progressPct <= 0 || progressPct >= 100) return null;
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return null;
  const elapsedMs = Date.now() - startMs;
  if (elapsedMs < 30_000) return null; // too early to extrapolate
  const totalEstimateMs = (elapsedMs / progressPct) * 100;
  const remainingMs = Math.max(totalEstimateMs - elapsedMs, 0);
  const min = Math.floor(remainingMs / 60000);
  const sec = Math.floor((remainingMs % 60000) / 1000);
  if (min >= 60) return `~${Math.floor(min / 60)}h ${min % 60}m left`;
  if (min > 0) return `~${min}m ${sec.toString().padStart(2, '0')}s left`;
  return `~${sec}s left`;
}

export default function BuildSummaryCard({ job, buildProgress }: Props) {
  const [logs, setLogs] = useState<string>('');
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const pollRef = useRef<number | null>(null);

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await fetch(`/api/regions/${encodeURIComponent(job.region)}/logs?lines=30`);
      const body = await res.json();
      setLogs(body.logs || '');
    } catch {} finally {
      setLogsLoading(false);
    }
  }, [job.region]);

  useEffect(() => {
    if (!logsExpanded) return;
    fetchLogs();
    pollRef.current = window.setInterval(fetchLogs, 15_000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [logsExpanded, fetchLogs]);

  const bp = buildProgress;
  const progressPct = bp?.progress ?? 0;
  const eta = formatEta(progressPct, job.started_at);
  const elapsed = job.started_at ? getTimeSince(job.started_at) : null;

  const profileStrip = bp?.totalProfiles
    ? `${(bp.completedProfiles?.length ?? 0)}/${bp.totalProfiles} profiles complete`
    : null;

  return (
    <div style={{
      background: '#0f172a',
      border: '1px solid #1f2937',
      borderRadius: 8,
      padding: 16,
      marginBottom: 16,
      color: '#e5e7eb',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 1 }}>Building region</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{job.display_name || job.region}</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12, color: '#9ca3af' }}>
          {elapsed && <div>Elapsed {elapsed}</div>}
          {eta && <div style={{ color: '#a5b4fc' }}>{eta}</div>}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ height: 8, background: '#1f2937', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(progressPct, 100)}%`,
            height: '100%',
            background: 'linear-gradient(90deg, #6366f1 0%, #a78bfa 100%)',
            transition: 'width 1s ease-out',
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11, color: '#9ca3af' }}>
          <span>{progressPct}%</span>
          {profileStrip && <span>{profileStrip}</span>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, fontSize: 12 }}>
        {bp?.currentProfile && (
          <div>
            <div style={{ color: '#9ca3af' }}>Current profile</div>
            <div style={{ fontFamily: 'monospace' }}>{bp.currentProfile}</div>
          </div>
        )}
        {bp?.detail && (
          <div>
            <div style={{ color: '#9ca3af' }}>Phase</div>
            <div>{bp.detail}</div>
          </div>
        )}
        {bp?.lmCurrent !== undefined && bp?.lmTotal !== undefined && (
          <div>
            <div style={{ color: '#9ca3af' }}>LM sets</div>
            <div>{bp.lmCurrent} / {bp.lmTotal}</div>
          </div>
        )}
        {bp?.nodesRemaining !== undefined && bp?.nodesTotal !== undefined && bp.nodesTotal > 0 && (
          <div>
            <div style={{ color: '#9ca3af' }}>CH nodes left</div>
            <div>{(bp.nodesRemaining / 1000).toFixed(0)}K / {(bp.nodesTotal / 1000).toFixed(0)}K</div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, borderTop: '1px solid #1f2937', paddingTop: 10 }}>
        <button
          onClick={() => setLogsExpanded(v => !v)}
          style={{
            background: 'transparent',
            color: '#a5b4fc',
            border: 'none',
            cursor: 'pointer',
            fontSize: 12,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {logsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {logsExpanded ? 'Hide log tail' : 'Show log tail (last 30 lines)'}
          {logsExpanded && (
            <span onClick={(e) => { e.stopPropagation(); fetchLogs(); }} style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <RefreshCw size={11} /> {logsLoading ? '...' : 'refresh'}
            </span>
          )}
        </button>
        {logsExpanded && (
          <pre style={{
            background: '#020617',
            color: '#94a3b8',
            padding: 10,
            borderRadius: 4,
            marginTop: 8,
            fontSize: 11,
            maxHeight: 220,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}>{logs || (logsLoading ? 'loading...' : '(no logs yet)')}</pre>
        )}
      </div>
    </div>
  );
}
