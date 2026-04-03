import { useState, useEffect, useCallback } from 'react';
import { Activity, RefreshCw, Trash2, CheckCircle, XCircle, Clock, Server, Cpu, Database } from 'lucide-react';

interface EnvInfo {
  version: string;
  uptime: string;
  isSpcs: boolean;
  database: string;
  warehouse: string;
  nodeVersion: string;
  memoryMb: { rss: number; heapUsed: number; heapTotal: number };
}

interface ProbeResult {
  ok: boolean;
  ms: number;
  detail?: string;
}

interface LogEntry {
  ts: string;
  level: string;
  tag: string;
  message: string;
  detail?: any;
  jobId?: string;
  durationMs?: number;
}

type Tab = 'env' | 'probe' | 'logs';

const LEVEL_COLORS: Record<string, string> = {
  ERROR: '#ef4444',
  WARN: '#f59e0b',
  INFO: '#3b82f6',
  DEBUG: '#6b7280',
};

export default function Diagnostics() {
  const [tab, setTab] = useState<Tab>('env');
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, ProbeResult> | null>(null);
  const [probing, setProbing] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logFilter, setLogFilter] = useState<{ level: string; tag: string }>({ level: '', tag: '' });
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchEnv = useCallback(async () => {
    try {
      const res = await fetch('/api/diagnostics/env');
      setEnv(await res.json());
    } catch {}
  }, []);

  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      const res = await fetch('/api/diagnostics/probe');
      setProbeResults(await res.json());
    } catch {}
    setProbing(false);
  }, []);

  const fetchLogs = useCallback(async () => {
    const params = new URLSearchParams();
    if (logFilter.level) params.set('level', logFilter.level);
    if (logFilter.tag) params.set('tag', logFilter.tag);
    params.set('limit', '200');
    try {
      const res = await fetch(`/api/diagnostics/logs?${params}`);
      const data = await res.json();
      setLogs(data.entries || []);
    } catch {}
  }, [logFilter]);

  const clearLogs = useCallback(async () => {
    await fetch('/api/diagnostics/logs/clear', { method: 'POST' });
    setLogs([]);
  }, []);

  useEffect(() => {
    if (tab === 'env') fetchEnv();
    if (tab === 'probe' && !probeResults) runProbe();
    if (tab === 'logs') fetchLogs();
  }, [tab]);

  useEffect(() => {
    if (!autoRefresh || tab !== 'logs') return;
    const iv = setInterval(fetchLogs, 5000);
    return () => clearInterval(iv);
  }, [autoRefresh, tab, fetchLogs]);

  const tags = [...new Set(logs.map(l => l.tag))];

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Activity size={20} />
        <h2 style={{ margin: 0, fontSize: 18 }}>Diagnostics</h2>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {(['env', 'probe', 'logs'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: '6px 16px', borderRadius: 6, border: '1px solid var(--border)',
              background: tab === t ? 'var(--accent)' : 'var(--surface)',
              color: tab === t ? '#fff' : 'var(--text)',
              cursor: 'pointer', fontSize: 13, fontWeight: 500,
            }}
          >
            {t === 'env' ? 'Environment' : t === 'probe' ? 'Connectivity' : 'Logs'}
          </button>
        ))}
      </div>

      {tab === 'env' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button onClick={fetchEnv} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12 }}>
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
          {env ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              <EnvCard icon={<Server size={14} />} label="Version" value={env.version} />
              <EnvCard icon={<Clock size={14} />} label="Uptime" value={env.uptime} />
              <EnvCard icon={<Cpu size={14} />} label="SPCS Mode" value={env.isSpcs ? 'Yes' : 'No'} />
              <EnvCard icon={<Database size={14} />} label="Database" value={env.database} />
              <EnvCard icon={<Database size={14} />} label="Warehouse" value={env.warehouse} />
              <EnvCard icon={<Cpu size={14} />} label="Node.js" value={env.nodeVersion} />
              <EnvCard icon={<Cpu size={14} />} label="Memory (Heap)" value={`${env.memoryMb.heapUsed} / ${env.memoryMb.heapTotal} MB`} />
              <EnvCard icon={<Cpu size={14} />} label="Memory (RSS)" value={`${env.memoryMb.rss} MB`} />
            </div>
          ) : (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>Loading...</div>
          )}
        </div>
      )}

      {tab === 'probe' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button onClick={runProbe} disabled={probing} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12 }}>
              <RefreshCw size={12} className={probing ? 'spin' : ''} /> {probing ? 'Probing...' : 'Run Probe'}
            </button>
          </div>
          {probeResults ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {Object.entries(probeResults).map(([name, r]) => (
                <div key={name} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px',
                  borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
                }}>
                  {r.ok ? <CheckCircle size={16} color="#22c55e" /> : <XCircle size={16} color="#ef4444" />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{formatProbeName(name)}</div>
                    {r.detail && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{r.detail}</div>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{r.ms}ms</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{probing ? 'Running connectivity checks...' : 'Click Run Probe to test connectivity.'}</div>
          )}
        </div>
      )}

      {tab === 'logs' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={logFilter.level}
              onChange={e => setLogFilter(f => ({ ...f, level: e.target.value }))}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }}
            >
              <option value="">All Levels</option>
              {['ERROR', 'WARN', 'INFO', 'DEBUG'].map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select
              value={logFilter.tag}
              onChange={e => setLogFilter(f => ({ ...f, tag: e.target.value }))}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12 }}
            >
              <option value="">All Tags</option>
              {tags.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} />
              Auto-refresh
            </label>
            <div style={{ flex: 1 }} />
            <button onClick={fetchLogs} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12 }}>
              <RefreshCw size={12} /> Refresh
            </button>
            <button onClick={clearLogs} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', fontSize: 12, color: '#ef4444' }}>
              <Trash2 size={12} /> Clear
            </button>
          </div>
          <div style={{
            maxHeight: 500, overflowY: 'auto', borderRadius: 8,
            border: '1px solid var(--border)', background: '#0d1117', fontFamily: 'monospace', fontSize: 11,
          }}>
            {logs.length === 0 ? (
              <div style={{ padding: 16, color: '#6b7280', textAlign: 'center' }}>No log entries</div>
            ) : (
              [...logs].reverse().map((entry, i) => (
                <div key={i} style={{
                  padding: '4px 10px', borderBottom: '1px solid #1e293b',
                  display: 'flex', gap: 8, lineHeight: 1.5,
                }}>
                  <span style={{ color: '#6b7280', whiteSpace: 'nowrap' }}>{entry.ts.replace('T', ' ').slice(0, 19)}</span>
                  <span style={{ color: LEVEL_COLORS[entry.level] || '#6b7280', fontWeight: 600, minWidth: 40 }}>{entry.level}</span>
                  <span style={{ color: '#a78bfa', minWidth: 70 }}>{entry.tag}</span>
                  <span style={{ color: '#e2e8f0', flex: 1 }}>
                    {entry.message}
                    {entry.detail && (
                      <span style={{ color: '#6b7280', marginLeft: 8 }}>
                        {typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail).slice(0, 200)}
                      </span>
                    )}
                  </span>
                  {entry.jobId && <span style={{ color: '#4ade80', fontSize: 10 }}>{entry.jobId.slice(0, 8)}</span>}
                </div>
              ))
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
            {logs.length} entries{autoRefresh ? ' (auto-refreshing every 5s)' : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function EnvCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div style={{
      padding: '12px 16px', borderRadius: 8,
      border: '1px solid var(--border)', background: 'var(--surface)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function formatProbeName(key: string): string {
  const map: Record<string, string> = {
    snowflakeSql: 'Snowflake SQL',
    orsService: 'ORS Service',
    overtureMaps: 'Overture Maps',
  };
  return map[key] || key;
}
