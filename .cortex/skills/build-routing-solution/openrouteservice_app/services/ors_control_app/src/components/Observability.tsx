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
    <div style={{ padding: '24px', color: '#e5e7eb', maxWidth: 1400 }}>
      <h1 style={{ fontSize: 22, marginBottom: 6 }}>ORS Observability</h1>
      <p style={{ color: '#9ca3af', fontSize: 13, marginBottom: 16 }}>
        Per-endpoint latency and error metrics, sampled from the routing gateway via the <code>ORS_METRICS_INGEST_TASK</code> task (1-minute cadence).
        Click <strong>Ingest now</strong> to force a refresh between scheduled runs.
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {WINDOWS.map(w => (
            <button key={w} onClick={() => setWindowKey(w)}
              style={{
                background: windowKey === w ? '#1f2937' : 'transparent',
                color: windowKey === w ? '#fff' : '#9ca3af',
                border: '1px solid #374151',
                padding: '6px 14px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >Last {w}</button>
          ))}
        </div>
        <button onClick={fetchMetrics} disabled={loading}
          style={{ background: '#374151', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button onClick={ingestNow} disabled={loading}
          style={{ background: '#1e40af', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
          Ingest now
        </button>
        <span style={{ color: '#9ca3af', fontSize: 12 }}>{loading ? 'Loading...' : ''}</span>
      </div>

      {error && (
        <div style={{ background: '#7f1d1d', color: '#fecaca', padding: 12, borderRadius: 6, marginBottom: 16, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <AlertTriangle size={16} />
          <div style={{ fontSize: 13 }}>{error}</div>
        </div>
      )}

      <h2 style={{ fontSize: 15, marginBottom: 8 }}>Summary by endpoint</h2>
      <div style={{ overflowX: 'auto', marginBottom: 28 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #374151', color: '#9ca3af', textAlign: 'left' }}>
              <th style={{ padding: '8px 12px' }}>Endpoint</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>Requests</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>Errors</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>Error %</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>p50 ms</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>p95 ms</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>max ms</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>avg req KB</th>
              <th style={{ padding: '8px 12px', textAlign: 'right' }}>avg resp KB</th>
              <th style={{ padding: '8px 12px' }}>Last event</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>
                No metrics yet. Make a few routing / matrix calls, then click <strong>Ingest now</strong>.
              </td></tr>
            )}
            {filtered.map((m, i) => (
              <tr key={`${m.ENDPOINT}-${i}`} style={{ borderBottom: '1px solid #1f2937' }}>
                <td style={{ padding: '8px 12px', fontWeight: 600 }}>{m.ENDPOINT}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{m.REQ_COUNT}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: m.ERROR_COUNT > 0 ? '#fca5a5' : '#9ca3af' }}>{m.ERROR_COUNT}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right', color: (m.ERROR_RATE_PCT || 0) > 5 ? '#fca5a5' : '#9ca3af' }}>{m.ERROR_RATE_PCT?.toFixed(1) || '0.0'}%</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{m.P50_MS ?? '—'}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{m.P95_MS ?? '—'}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{m.MAX_MS ?? '—'}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{m.AVG_REQ_BYTES ? (m.AVG_REQ_BYTES / 1024).toFixed(1) : '—'}</td>
                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{m.AVG_RESP_BYTES ? (m.AVG_RESP_BYTES / 1024).toFixed(1) : '—'}</td>
                <td style={{ padding: '8px 12px', color: '#9ca3af' }}>{m.LAST_EVENT_TS || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: 15, margin: 0 }}>Recent events (last 24h)</h2>
        <label style={{ fontSize: 12, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={onlyErrors} onChange={e => setOnlyErrors(e.target.checked)} />
          Errors only
        </label>
      </div>
      <div style={{ overflowX: 'auto', maxHeight: 480, overflowY: 'auto', border: '1px solid #1f2937', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ position: 'sticky', top: 0, background: '#111827' }}>
            <tr style={{ borderBottom: '1px solid #374151', color: '#9ca3af', textAlign: 'left' }}>
              <th style={{ padding: '6px 10px' }}>Time</th>
              <th style={{ padding: '6px 10px' }}>Endpoint</th>
              <th style={{ padding: '6px 10px' }}>Profile</th>
              <th style={{ padding: '6px 10px' }}>Status</th>
              <th style={{ padding: '6px 10px' }}>Error</th>
              <th style={{ padding: '6px 10px', textAlign: 'right' }}>Latency ms</th>
              <th style={{ padding: '6px 10px', textAlign: 'right' }}>req B</th>
              <th style={{ padding: '6px 10px', textAlign: 'right' }}>resp B</th>
              <th style={{ padding: '6px 10px' }}>Host</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 20, textAlign: 'center', color: '#6b7280' }}>No events.</td></tr>
            )}
            {events.map(ev => (
              <tr key={ev.REQUEST_ID} style={{ borderBottom: '1px solid #1f2937' }}>
                <td style={{ padding: '4px 10px', color: '#9ca3af' }}>{ev.REQUEST_TS}</td>
                <td style={{ padding: '4px 10px' }}>{ev.ENDPOINT}</td>
                <td style={{ padding: '4px 10px', color: '#9ca3af' }}>{ev.PROFILE || '—'}</td>
                <td style={{ padding: '4px 10px', color: (ev.STATUS_CODE || 0) >= 400 ? '#fca5a5' : '#9ca3af' }}>{ev.STATUS_CODE ?? '—'}</td>
                <td style={{ padding: '4px 10px', color: '#fca5a5' }}>{ev.ERROR_CODE || ''}</td>
                <td style={{ padding: '4px 10px', textAlign: 'right' }}>{ev.LATENCY_MS ?? '—'}</td>
                <td style={{ padding: '4px 10px', textAlign: 'right', color: '#9ca3af' }}>{ev.REQUEST_BYTES ?? '—'}</td>
                <td style={{ padding: '4px 10px', textAlign: 'right', color: '#9ca3af' }}>{ev.RESPONSE_BYTES ?? '—'}</td>
                <td style={{ padding: '4px 10px', color: '#9ca3af' }}>{ev.ORS_HOST || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
