import { useState, useEffect, useCallback } from 'react';
import type { StatusResponse, ServiceInfo } from '../types';

export default function ServiceManager() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [healthOk, setHealthOk] = useState<boolean | null>(null);
  const [scaleMin, setScaleMin] = useState(1);
  const [scaleMax, setScaleMax] = useState(10);

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

  useEffect(() => {
    fetchStatus();
    checkHealth();
    const interval = setInterval(fetchStatus, 15000);
    return () => clearInterval(interval);
  }, [fetchStatus, checkHealth]);

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
      </div>

      <h3>Services</h3>
      <table className="services-table">
        <thead>
          <tr><th>Service</th><th>Status</th></tr>
        </thead>
        <tbody>
          {services.map((svc: ServiceInfo) => (
            <tr key={svc.name}>
              <td>{svc.name}</td>
              <td><span className={`badge ${svc.status === 'RUNNING' || svc.status === 'READY' ? 'ok' : 'warn'}`}>{svc.status}</span></td>
            </tr>
          ))}
          {services.length === 0 && (
            <tr><td colSpan={2}>No services found</td></tr>
          )}
        </tbody>
      </table>

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
          onClick={() => { fetchStatus(); checkHealth(); }}
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
