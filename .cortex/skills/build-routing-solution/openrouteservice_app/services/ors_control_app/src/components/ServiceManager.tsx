import { useState, useEffect, useCallback } from 'react';
import type { StatusResponse, ServiceInfo, OrsRegionReadiness } from '../types';

export default function ServiceManager() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [scaleMin, setScaleMin] = useState(1);
  const [scaleMax, setScaleMax] = useState(10);
  const [orsReadiness, setOrsReadiness] = useState<Record<string, OrsRegionReadiness> | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/status');
      const data = await r.json();
      setStatus(data);
    } catch {}
    setLoading(false);
  }, []);

  const checkHealth = useCallback(async () => {
    try {
      const r = await fetch('/api/health');
      const data = await r.json();
      setHealthOk(data.healthy);
    } catch {
      setHealthOk(false);
    }
  }, []);

  const fetchOrsReadiness = useCallback(async () => {
    setReadinessLoading(true);
    try {
      const r = await fetch('/api/ors-readiness');
      const data = await r.json();
      setOrsReadiness(data);
    } catch {}
    setReadinessLoading(false);
  }, []);

  useEffect(() => {
    fetchStatus();
    checkHealth();
    fetchOrsReadiness();
    const interval = setInterval(fetchStatus, 15000);
    const readinessInterval = setInterval(fetchOrsReadiness, 30000);
    return () => { clearInterval(interval); clearInterval(readinessInterval); };
  }, [fetchStatus, checkHealth, fetchOrsReadiness]);

  const handleAction = async (action: string, body?: any) => {
    setActionInProgress(action);
    try {
      await fetch(`/api/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      await fetchStatus();
      await checkHealth();
    } catch {}
    setActionInProgress(null);
  };

  if (loading) return <div className="panel loading">Loading service status...</div>;

  const poolState = status?.compute_pool || 'UNKNOWN';
  const services = status?.services || [];
  const runningCount = services.filter((s: ServiceInfo) => s.status === 'RUNNING' || s.status === 'READY').length;

  const allGraphsReady = orsReadiness
    ? Object.values(orsReadiness).every(r => r.service_ready)
    : null;

  const totalExpected = orsReadiness
    ? Object.values(orsReadiness).reduce((sum, r) => sum + (r.expected_profiles?.length || r.graphs?.length || 0), 0)
    : 0;
  const totalBuilt = orsReadiness
    ? Object.values(orsReadiness).reduce((sum, r) => sum + (r.graphs?.filter(g => g.ready).length || 0), 0)
    : 0;
  const anyBuilding = orsReadiness
    ? Object.values(orsReadiness).some(r => !r.service_ready && !r.error && (r.health_ready !== undefined || r.expected_profiles))
    : false;

  return (
    <div className="panel">
      <h2>Service Manager</h2>

      <div className="status-grid">
        <div className={`status-card ${poolState === 'ACTIVE' || poolState === 'IDLE' ? 'ok' : 'warn'}`}>
          <div className="status-label">Compute Pool</div>
          <div className="status-value">{poolState}</div>
        </div>
        <div className={`status-card ${healthOk ? 'ok' : 'warn'}`}>
          <div className="status-label">ORS Health</div>
          <div className="status-value">{healthOk === null ? 'Checking...' : healthOk ? 'Healthy' : 'Unhealthy'}</div>
        </div>
        <div className="status-card">
          <div className="status-label">Services</div>
          <div className="status-value">{runningCount} / {services.length} running</div>
        </div>
        <div className={`status-card ${allGraphsReady === null ? '' : allGraphsReady ? 'ok' : 'warn'}`}>
          <div className="status-label">Graphs</div>
          <div className="status-value">
            {readinessLoading && !orsReadiness ? 'Loading...' : allGraphsReady === null ? 'Unknown' : allGraphsReady ? `All Ready (${totalBuilt})` : `Building (${totalBuilt}/${totalExpected})`}
          </div>
        </div>
      </div>

      <h3>Services</h3>
      <table className="services-table">
        <thead>
          <tr><th>Service</th><th>Status</th><th>Graphs</th></tr>
        </thead>
        <tbody>
          {services.map((svc: ServiceInfo) => {
            const isOrs = svc.name.startsWith('ORS_SERVICE');
            const regionKey = svc.name === 'ORS_SERVICE' ? 'default' : svc.name.replace('ORS_SERVICE_', '');
            const readiness = isOrs && orsReadiness ? orsReadiness[regionKey] || orsReadiness[regionKey.charAt(0) + regionKey.slice(1).toLowerCase()] : null;

            return (
              <tr key={svc.name}>
                <td>{svc.name}</td>
                <td><span className={`badge ${svc.status === 'RUNNING' || svc.status === 'READY' ? 'ok' : 'warn'}`}>{svc.status}</span></td>
                <td>
                  {!isOrs ? (
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>N/A</span>
                  ) : readiness ? (
                    <>
                      <span className={`badge ${readiness.service_ready ? 'ok' : 'warn'}`}>
                        {readiness.service_ready
                          ? `Ready (${readiness.profiles.length}/${readiness.expected_profiles?.length || readiness.profiles.length})`
                          : readiness.error
                            ? 'Error'
                            : `Building (${readiness.graphs?.filter(g => g.ready).length || 0}/${readiness.expected_profiles?.length || readiness.graphs?.length || '?'})`
                        }
                      </span>
                      {!readiness.service_ready && !readiness.error && readiness.graphs && readiness.graphs.length > 0 && (
                        <ul style={{ margin: '4px 0 0', paddingLeft: 16, listStyle: 'none', fontSize: 11 }}>
                          {readiness.graphs.map(g => (
                            <li key={g.profile} style={{ color: g.ready ? 'var(--color-ok)' : 'var(--text-secondary)' }}>
                              {g.ready ? '\u2713' : '\u25CB'} {g.profile}{g.build_date ? ` (${g.build_date})` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : readinessLoading ? (
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Checking...</span>
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Unknown</span>
                  )}
                </td>
              </tr>
            );
          })}
          {services.length === 0 && (
            <tr><td colSpan={3}>No services found</td></tr>
          )}
        </tbody>
      </table>

      {orsReadiness && Object.entries(orsReadiness).some(([, r]) => !r.service_ready) && (
        <div style={{ margin: '12px 0', padding: '12px 16px', background: 'rgba(255, 193, 7, 0.15)', borderRadius: 8, border: '1px solid rgba(255, 193, 7, 0.5)', fontSize: 13, color: '#b38600' }}>
          {Object.values(orsReadiness).every((r: any) => r.graphs_persisted)
            ? <><strong>Graphs Loading:</strong> Pre-built graphs are being loaded into memory. Functions will be ready shortly — this typically takes 1–3 minutes.</>
            : <><strong>Graphs Building:</strong> ORS is building routing graphs from map data. Functions will return errors until all profiles are ready. This typically takes 5–15 minutes.</>
          }
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {Object.entries(orsReadiness).filter(([, r]) => !r.service_ready).map(([region, r]: [string, any]) => (
              <li key={region}>
                <strong>{region === 'default' ? 'Default (San Francisco)' : region}</strong>
                {' '}
                <span style={{ fontSize: 11, opacity: 0.8 }}>{r.graphs_persisted ? '(loading from stage)' : '(building from OSM)'}</span>
                {r.error ? `: ${r.error}` : ` \u2014 ${r.graphs?.filter((g: any) => g.ready).length || 0}/${r.expected_profiles?.length || r.graphs?.length || '?'} profiles ready`}
                {!r.error && r.graphs && r.graphs.length > 0 && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 16, listStyle: 'none' }}>
                    {r.graphs.map((g: any) => (
                      <li key={g.profile} style={{ color: g.ready ? '#66bb6a' : '#b38600' }}>
                        {g.ready ? '\u2713' : '\u23F3'} {g.profile}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>Actions</h3>
      <div className="action-row">
        <button
          className="btn primary"
          onClick={() => handleAction('resume')}
          disabled={!!actionInProgress}
        >
          {actionInProgress === 'resume' ? 'Resuming...' : 'Resume All'}
        </button>
        <button
          className="btn danger"
          onClick={() => handleAction('suspend')}
          disabled={!!actionInProgress}
        >
          {actionInProgress === 'suspend' ? 'Suspending...' : 'Suspend All'}
        </button>
        <button
          className="btn secondary"
          onClick={() => { fetchStatus(); checkHealth(); fetchOrsReadiness(); }}
          disabled={!!actionInProgress}
        >
          Refresh
        </button>
      </div>

      <h3>Scale</h3>
      <div className="scale-row">
        <label>
          Min Instances
          <input type="number" min={1} max={20} value={scaleMin} onChange={(e) => setScaleMin(Number(e.target.value))} />
        </label>
        <label>
          Max Instances
          <input type="number" min={1} max={20} value={scaleMax} onChange={(e) => setScaleMax(Number(e.target.value))} />
        </label>
        <button
          className="btn primary"
          onClick={() => handleAction('scale', { min: scaleMin, max: scaleMax })}
          disabled={!!actionInProgress}
        >
          {actionInProgress === 'scale' ? 'Scaling...' : 'Apply Scale'}
        </button>
      </div>
    </div>
  );
}