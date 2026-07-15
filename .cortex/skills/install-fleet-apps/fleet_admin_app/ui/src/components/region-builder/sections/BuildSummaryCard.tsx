'use client';
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
    <div
      className="status-card"
      style={{
        marginBottom: 16,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div>
          <div className="metric-label">Building region</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>{job.display_name || job.region}</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12, color: 'var(--text-secondary)' }}>
          {elapsed && <div>Elapsed {elapsed}</div>}
          {eta && <div style={{ color: 'var(--accent)' }}>{eta}</div>}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div className="build-progress">
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{ width: `${Math.min(progressPct, 100)}%` }}
            />
          </div>
          <div className="progress-stats">
            <span>{progressPct}%</span>
            {profileStrip && <span>{profileStrip}</span>}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, fontSize: 12 }}>
        {bp?.currentProfile && (
          <div>
            <div style={{ color: 'var(--text-secondary)' }}>Current profile</div>
            <div style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{bp.currentProfile}</div>
          </div>
        )}
        {bp?.detail && (
          <div>
            <div style={{ color: 'var(--text-secondary)' }}>Phase</div>
            <div style={{ color: 'var(--text)' }}>{bp.detail}</div>
          </div>
        )}
        {bp?.lmCurrent !== undefined && bp?.lmTotal !== undefined && (
          <div>
            <div style={{ color: 'var(--text-secondary)' }}>LM sets</div>
            <div style={{ color: 'var(--text)' }}>{bp.lmCurrent} / {bp.lmTotal}</div>
          </div>
        )}
        {bp?.nodesRemaining !== undefined && bp?.nodesTotal !== undefined && bp.nodesTotal > 0 && (
          <div>
            <div style={{ color: 'var(--text-secondary)' }}>CH nodes left</div>
            <div style={{ color: 'var(--text)' }}>
              {(bp.nodesRemaining / 1000).toFixed(0)}K / {(bp.nodesTotal / 1000).toFixed(0)}K
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <button
          type="button"
          className="btn small secondary"
          onClick={() => setLogsExpanded(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          {logsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {logsExpanded ? 'Hide log tail' : 'Show log tail (last 30 lines)'}
          {logsExpanded && (
            <span
              onClick={(e) => { e.stopPropagation(); fetchLogs(); }}
              style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 2 }}
            >
              <RefreshCw size={11} /> {logsLoading ? '...' : 'refresh'}
            </span>
          )}
        </button>
        {logsExpanded && (
          <pre
            className="result-json"
            style={{
              marginTop: 8,
              maxHeight: 220,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {logs || (logsLoading ? 'loading...' : '(no logs yet)')}
          </pre>
        )}
      </div>
    </div>
  );
}
