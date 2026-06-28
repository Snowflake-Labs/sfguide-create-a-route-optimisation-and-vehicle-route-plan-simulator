import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';

interface MetricRow {
  WINDOW_NAME: string;
  ENDPOINT: string;
  REQ_COUNT: number;
  ERROR_COUNT: number;
  ERROR_RATE_PCT: number | null;
  P50_MS: number | null;
  P95_MS: number | null;
  MAX_MS: number | null;
  AVG_MS: number | null;
  AVG_REQ_BYTES: number | null;
  AVG_RESP_BYTES: number | null;
  LAST_EVENT_TS: string | null;
}

interface EventRow {
  REQUEST_TS: string;
  REQUEST_ID: string;
  ENDPOINT: string;
  PROFILE: string | null;
  REGION: string | null;
  ORS_HOST: string | null;
  STATUS_CODE: number | null;
  ERROR_CODE: string | null;
  LATENCY_MS: number | null;
  REQUEST_BYTES: number | null;
  RESPONSE_BYTES: number | null;
  CALLER: string | null;
}

const WINDOWS = ['1h', '24h'] as const;
type WindowKey = typeof WINDOWS[number];

export default function Observability() {
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [windowKey, setWindowKey] = useState<WindowKey>('1h');
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/observability/ors-metrics');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      setMetrics(body.rows || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('limit', '200');
      if (onlyErrors) params.set('errors', '1');
      const res = await fetch(`/api/observability/ors-events?${params}`);
      if (!res.ok) return;
      const body = await res.json();
      setEvents(body.rows || []);
    } catch {}
  }, [onlyErrors]);

  const ingestNow = useCallback(async () => {
    setLoading(true);
    try {
      await fetch('/api/observability/ingest-now', { method: 'POST' });
      await Promise.all([fetchMetrics(), fetchEvents()]);
    } finally {
      setLoading(false);
    }
  }, [fetchMetrics, fetchEvents]);

  useEffect(() => { fetchMetrics(); fetchEvents(); }, [fetchMetrics, fetchEvents]);

  const filtered = metrics.filter(m => m.WINDOW_NAME === windowKey);

  return (
    <div className="panel" style={{ maxWidth: 1400 }}>
      <h2>ORS Observability</h2>
      <p className="subtitle">
        Per-endpoint latency and error metrics, sampled from the routing gateway via the <code>ORS_METRICS_INGEST_TASK</code> task (1-minute cadence).
        Click <strong>Ingest now</strong> to force a refresh between scheduled runs.
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {WINDOWS.map(w => (
            <button
              key={w}
              className={`tab ${windowKey === w ? 'active' : ''}`}
              onClick={() => setWindowKey(w)}
            >
              Last {w}
            </button>
          ))}
        </div>
        <button
          className="btn secondary"
          onClick={fetchMetrics}
          disabled={loading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
        <button
          className="btn primary"
          onClick={ingestNow}
          disabled={loading}
        >
          Ingest now
        </button>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{loading ? 'Loading...' : ''}</span>
      </div>

      {error && (
        <div
          style={{
            background: 'rgba(229,72,77,0.1)',
            color: 'var(--red)',
            border: '1px solid var(--red)',
            padding: 12,
            borderRadius: 6,
            marginBottom: 16,
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={16} />
          <div style={{ fontSize: 13 }}>{error}</div>
        </div>
      )}

      <h3>Summary by endpoint</h3>
      <div style={{ overflowX: 'auto', marginBottom: 28 }}>
        <table className="services-table">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th style={{ textAlign: 'right' }}>Requests</th>
              <th style={{ textAlign: 'right' }}>Errors</th>
              <th style={{ textAlign: 'right' }}>Error %</th>
              <th style={{ textAlign: 'right' }}>p50 ms</th>
              <th style={{ textAlign: 'right' }}>p95 ms</th>
              <th style={{ textAlign: 'right' }}>max ms</th>
              <th style={{ textAlign: 'right' }}>avg req KB</th>
              <th style={{ textAlign: 'right' }}>avg resp KB</th>
              <th>Last event</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
                  No metrics yet. Make a few routing / matrix calls, then click <strong>Ingest now</strong>.
                </td>
              </tr>
            )}
            {filtered.map((m, i) => (
              <tr key={`${m.ENDPOINT}-${i}`}>
                <td style={{ fontWeight: 600 }}>{m.ENDPOINT}</td>
                <td style={{ textAlign: 'right' }}>{m.REQ_COUNT}</td>
                <td style={{ textAlign: 'right', color: m.ERROR_COUNT > 0 ? 'var(--red)' : 'var(--text-secondary)' }}>{m.ERROR_COUNT}</td>
                <td style={{ textAlign: 'right', color: (m.ERROR_RATE_PCT || 0) > 5 ? 'var(--red)' : 'var(--text-secondary)' }}>{m.ERROR_RATE_PCT?.toFixed(1) || '0.0'}%</td>
                <td style={{ textAlign: 'right' }}>{m.P50_MS ?? '-'}</td>
                <td style={{ textAlign: 'right' }}>{m.P95_MS ?? '-'}</td>
                <td style={{ textAlign: 'right' }}>{m.MAX_MS ?? '-'}</td>
                <td style={{ textAlign: 'right' }}>{m.AVG_REQ_BYTES ? (m.AVG_REQ_BYTES / 1024).toFixed(1) : '-'}</td>
                <td style={{ textAlign: 'right' }}>{m.AVG_RESP_BYTES ? (m.AVG_RESP_BYTES / 1024).toFixed(1) : '-'}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{m.LAST_EVENT_TS || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>Recent events (last 24h)</h3>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={onlyErrors}
            onChange={e => setOnlyErrors(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          Errors only
        </label>
      </div>
      <div
        style={{
          overflowX: 'auto',
          maxHeight: 480,
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg)',
        }}
      >
        <table className="services-table" style={{ fontSize: 12 }}>
          <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
            <tr>
              <th>Time</th>
              <th>Endpoint</th>
              <th>Profile</th>
              <th>Status</th>
              <th>Error</th>
              <th style={{ textAlign: 'right' }}>Latency ms</th>
              <th style={{ textAlign: 'right' }}>req B</th>
              <th style={{ textAlign: 'right' }}>resp B</th>
              <th>Host</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td colSpan={9} style={{ padding: 20, textAlign: 'center', color: 'var(--text-secondary)' }}>
                  No events.
                </td>
              </tr>
            )}
            {events.map(ev => (
              <tr key={ev.REQUEST_ID}>
                <td style={{ color: 'var(--text-secondary)' }}>{ev.REQUEST_TS}</td>
                <td>{ev.ENDPOINT}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{ev.PROFILE || '-'}</td>
                <td style={{ color: (ev.STATUS_CODE || 0) >= 400 ? 'var(--red)' : 'var(--text-secondary)' }}>{ev.STATUS_CODE ?? '-'}</td>
                <td style={{ color: 'var(--red)' }}>{ev.ERROR_CODE || ''}</td>
                <td style={{ textAlign: 'right' }}>{ev.LATENCY_MS ?? '-'}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{ev.REQUEST_BYTES ?? '-'}</td>
                <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{ev.RESPONSE_BYTES ?? '-'}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{ev.ORS_HOST || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
