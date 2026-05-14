import { useState, useEffect, useCallback } from 'react';
import type { StatusResponse, ServiceInfo, OrsRegionReadiness, ComputePoolInfo, OrsGraphInfo } from '../types';
import PhasePips from '../shared/PhasePips';

export default function ServiceManager() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [serviceAction, setServiceAction] = useState<{ name: string; op: 'resume' | 'suspend' } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
    setActionError(null);
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

  const handleServiceAction = async (name: string, op: 'resume' | 'suspend') => {
    setServiceAction({ name, op });
    setActionError(null);
    try {
      const r = await fetch(`/api/services/${encodeURIComponent(name)}/${op}`, { method: 'POST' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setActionError(body.error || `Failed to ${op} ${name}`);
      }
      await fetchStatus();
      await checkHealth();
    } catch (err: any) {
      setActionError(err?.message || `Failed to ${op} ${name}`);
    }
    setServiceAction(null);
  };

  if (loading) return <div className="panel loading">Loading service status...</div>;

  const poolState = status?.compute_pool || 'UNKNOWN';
  const poolInfo: ComputePoolInfo | undefined = status?.compute_pool_info;
  const computePools = status?.compute_pools || {};
  const services = status?.services || [];
  const runningCount = services.filter((s: ServiceInfo) => s.status === 'RUNNING' || s.status === 'READY').length;

  const isRegionSuspended = (region: string): boolean => {
    const name = region === 'default' ? 'ORS_SERVICE' : `ORS_SERVICE_${region.toUpperCase()}`;
    return services.some(s => s.name.toUpperCase() === name && s.status === 'SUSPENDED');
  };

  const allGraphsReady = orsReadiness
    ? Object.entries(orsReadiness).filter(([region]) => !isRegionSuspended(region)).every(([, r]) => r.service_ready)
    : null;

  const totalExpected = orsReadiness
    ? Object.entries(orsReadiness).filter(([region]) => !isRegionSuspended(region)).reduce((sum, [, r]) => sum + (r.expected_profiles?.length || r.graphs?.length || 0), 0)
    : 0;
  const totalBuilt = orsReadiness
    ? Object.entries(orsReadiness).filter(([region]) => !isRegionSuspended(region)).reduce((sum, [, r]) => sum + (r.graphs?.filter(g => g.ready).length || 0), 0)
    : 0;
  const anyErrors = orsReadiness
    ? Object.entries(orsReadiness).some(([region, r]) => !!r.error && !isRegionSuspended(region))
    : false;

  const poolSubtitle = poolInfo?.instance_family
    ? `${poolInfo.instance_family} \u00B7 ${poolInfo.active_nodes ?? '?'}/${poolInfo.max_nodes ?? '?'} nodes`
    : null;

  return (
    <div className="panel">
      <h2>Service Manager</h2>

      <div className="status-grid">
        <div className={`status-card ${poolState === 'ACTIVE' || poolState === 'IDLE' ? 'ok' : 'warn'}`}>
          <div className="status-label">Compute Pool</div>
          <div className="status-value">{poolState}</div>
          {poolSubtitle && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
              {poolSubtitle}
            </div>
          )}
        </div>
        <div className={`status-card ${healthOk ? 'ok' : 'warn'}`}>
          <div className="status-label">ORS Health</div>
          <div className="status-value">{healthOk === null ? 'Checking...' : healthOk ? 'Healthy' : 'Unhealthy'}</div>
        </div>
        <div className="status-card">
          <div className="status-label">Services</div>
          <div className="status-value">{runningCount} / {services.length} running</div>
        </div>
        <div className={`status-card ${allGraphsReady === null ? '' : allGraphsReady ? 'ok' : anyErrors ? 'error' : 'warn'}`}>
          <div className="status-label">Graphs</div>
          <div className="status-value">
            {readinessLoading && !orsReadiness ? 'Loading...' : allGraphsReady === null ? 'Unknown' : allGraphsReady ? `All Ready (${totalBuilt})` : anyErrors ? `Error (${totalBuilt}/${totalExpected})` : `Building (${totalBuilt}/${totalExpected})`}
          </div>
        </div>
      </div>

      <h3>Services</h3>
      {actionError && (
        <div style={{ margin: '8px 0', padding: '8px 12px', background: 'rgba(229, 57, 53, 0.12)', borderRadius: 6, border: '1px solid rgba(229, 57, 53, 0.4)', fontSize: 12, color: '#e53935' }}>
          {actionError}
        </div>
      )}
      {(() => {
        const grouped = new Map<string, ServiceInfo[]>();
        for (const svc of services) {
          const key = svc.compute_pool || 'UNASSIGNED';
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key)!.push(svc);
        }
        const poolNames = Array.from(grouped.keys()).sort((a, b) => {
          const aSize = grouped.get(b)?.length || 0;
          const bSize = grouped.get(a)?.length || 0;
          if (aSize !== bSize) return aSize - bSize;
          return a.localeCompare(b);
        });

        return poolNames.map((name) => {
          const poolSvcs = grouped.get(name) || [];
          const poolMeta: ComputePoolInfo | undefined = computePools[name];
          const stateLower = (poolMeta?.state || 'UNKNOWN').toLowerCase();
          const stateClass = stateLower === 'active' || stateLower === 'idle'
            ? 'ok'
            : stateLower === 'starting' || stateLower === 'resizing' || stateLower === 'stopping'
              ? 'warn'
              : stateLower === 'suspended' || stateLower === 'unknown'
                ? 'muted'
                : 'error';
          const driftCount = poolSvcs.filter((s) => Number(s.auto_suspend_secs) === 0 && (s.status === 'RUNNING' || s.status === 'READY')).length;
          const headerSubtitle = [
            poolMeta?.instance_family,
            poolMeta?.active_nodes != null && poolMeta?.max_nodes != null ? `${poolMeta.active_nodes}/${poolMeta.max_nodes} nodes` : null,
            `${poolSvcs.length} service${poolSvcs.length === 1 ? '' : 's'}`,
          ].filter(Boolean).join(' \u2022 ');

          return (
            <section key={name} className={`pool-section pool-state-${stateClass}`}>
              <header className="pool-section-header">
                <div className="pool-section-title">
                  <span className="pool-section-icon" aria-hidden>{stateClass === 'ok' ? '\u25CF' : '\u25CB'}</span>
                  <div>
                    <div className="pool-section-name">{name}</div>
                    {headerSubtitle && <div className="pool-section-subtitle">{headerSubtitle}</div>}
                  </div>
                </div>
                <div className="pool-section-state">
                  <span className={`badge ${stateClass === 'ok' ? 'ok' : stateClass === 'warn' ? 'warn' : ''}`}>{poolMeta?.state || 'UNKNOWN'}</span>
                  {driftCount > 0 && (
                    <span className="badge warn" title="One or more services have AUTO_SUSPEND_SECS=0 while running. Call CORE.RECONCILE_AUTO_SUSPEND() if no provisioning is in flight.">
                      {driftCount} drift
                    </span>
                  )}
                </div>
              </header>
              <table className="services-table pool-services-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Status</th>
                    <th>Instances</th>
                    <th>Graphs</th>
                    <th style={{ width: 1 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {poolSvcs.map((svc: ServiceInfo) => {
                    const isOrs = svc.name.startsWith('ORS_SERVICE');
                    const regionKey = svc.name === 'ORS_SERVICE' ? 'default' : svc.name.replace('ORS_SERVICE_', '');
                    const readiness = isOrs && orsReadiness ? orsReadiness[regionKey] || orsReadiness[regionKey.charAt(0) + regionKey.slice(1).toLowerCase()] : null;
                    const isRunning = svc.status === 'RUNNING' || svc.status === 'READY';
                    const isSuspended = svc.status === 'SUSPENDED';
                    const isControlApp = svc.name.toUpperCase() === 'ORS_CONTROL_APP';
                    const inFlight = serviceAction?.name === svc.name;
                    const instancesCell = svc.max_instances != null
                      ? `${svc.current_instances ?? '?'} / ${svc.max_instances}${svc.min_instances != null && svc.min_instances !== svc.max_instances ? ` (min ${svc.min_instances})` : ''}`
                      : '\u2014';

                    return (
                      <tr key={svc.name}>
                        <td>{svc.name}</td>
                        <td><span className={`badge ${isRunning ? 'ok' : 'warn'}`}>{svc.status}</span></td>
                        <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{instancesCell}</td>
                        <td>
                          {!isOrs ? (
                            <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>N/A</span>
                          ) : isSuspended ? (
                            <span className="badge" style={{ opacity: 0.6 }}>Paused</span>
                          ) : readiness ? (
                            <>
                              <span className={`badge ${readiness.service_ready ? 'ok' : readiness.error ? 'error' : 'warn'}`}>
                                {readiness.service_ready
                                  ? `Ready (${readiness.profiles.length}/${readiness.expected_profiles?.length || readiness.profiles.length})`
                                  : readiness.error
                                    ? 'Failed'
                                    : `Building (${readiness.graphs?.filter((g: OrsGraphInfo) => g.ready).length || 0}/${readiness.expected_profiles?.length || readiness.graphs?.length || '?'})`
                                }
                              </span>
                              {readiness.error && (
                                <div style={{ fontSize: 11, color: '#e53935', marginTop: 2, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis' }} title={readiness.error}>
                                  {readiness.error.length > 80 ? readiness.error.slice(0, 80) + '...' : readiness.error}
                                </div>
                              )}
                              {!readiness.service_ready && !readiness.error && readiness.graphs && readiness.graphs.length > 0 && (
                                <ul style={{ margin: '4px 0 0', paddingLeft: 0, listStyle: 'none', fontSize: 11 }}>
                                  {readiness.graphs.map((g: OrsGraphInfo) => (
                                    <li key={g.profile} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 0' }}>
                                      <span style={{ minWidth: 110, color: g.ready ? 'var(--color-ok, #2e7d32)' : 'var(--text-secondary)' }}>{g.profile}</span>
                                      <PhasePips phases={g.phases} ready={g.ready} showLabel={false} />
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
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button
                            className="btn primary"
                            style={{ padding: '4px 10px', fontSize: 12, marginRight: 4 }}
                            disabled={isRunning || !!serviceAction || !!actionInProgress}
                            onClick={() => handleServiceAction(svc.name, 'resume')}
                            title={isRunning ? 'Already running' : `Resume ${svc.name}`}
                          >
                            {inFlight && serviceAction?.op === 'resume' ? '\u2026' : 'Resume'}
                          </button>
                          <button
                            className="btn danger"
                            style={{ padding: '4px 10px', fontSize: 12 }}
                            disabled={isSuspended || isControlApp || !!serviceAction || !!actionInProgress}
                            onClick={() => handleServiceAction(svc.name, 'suspend')}
                            title={isControlApp ? 'ORS_CONTROL_APP cannot suspend itself' : isSuspended ? 'Already suspended' : `Suspend ${svc.name}`}
                          >
                            {inFlight && serviceAction?.op === 'suspend' ? '\u2026' : 'Suspend'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {poolSvcs.length === 0 && (
                    <tr><td colSpan={5}>No services on this pool</td></tr>
                  )}
                </tbody>
              </table>
            </section>
          );
        });
      })()}
      {services.length === 0 && <div className="panel">No services found</div>}

      {orsReadiness && Object.entries(orsReadiness).some(([region, r]) => !!r.error && !isRegionSuspended(region)) && (
        <div style={{ margin: '12px 0', padding: '12px 16px', background: 'rgba(229, 57, 53, 0.12)', borderRadius: 8, border: '1px solid rgba(229, 57, 53, 0.4)', fontSize: 13, color: '#e53935' }}>
          <strong>Graph Loading Failed:</strong> One or more regions failed to load routing graphs. The service is running but routing functions will return errors for affected regions.
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {Object.entries(orsReadiness).filter(([region, r]) => !!r.error && !isRegionSuspended(region)).map(([region, r]) => (
              <li key={region}>
                <strong>{region === 'default' ? 'Default (San Francisco)' : region}</strong>: {r.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {orsReadiness && Object.entries(orsReadiness).some(([region, r]) => !r.service_ready && !r.error && !isRegionSuspended(region)) && (
        <div style={{ margin: '12px 0', padding: '12px 16px', background: 'rgba(255, 193, 7, 0.15)', borderRadius: 8, border: '1px solid rgba(255, 193, 7, 0.5)', fontSize: 13, color: '#b38600' }}>
          {Object.values(orsReadiness).every((r: any) => r.graph_loading || r.graphs_persisted)
            ? <><strong>Graphs Loading:</strong> Pre-built graphs are being loaded into memory after a recent resume. Functions will be ready shortly &mdash; this typically takes 1&ndash;10 minutes depending on region size.</>
            : <><strong>Graphs Building:</strong> ORS is building routing graphs from map data. Functions will return errors until all profiles are ready. This typically takes 5&ndash;15 minutes.</>
          }
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {Object.entries(orsReadiness).filter(([region, r]) => !r.service_ready && !r.error && !isRegionSuspended(region)).map(([region, r]: [string, any]) => (
              <li key={region}>
                <strong>{region === 'default' ? 'Default (San Francisco)' : region}</strong>
                {' '}
                <span style={{ fontSize: 11, opacity: 0.8 }}>{r.graphs_persisted ? '(loading from stage)' : '(building from OSM)'}</span>
                {` \u2014 ${r.graphs?.filter((g: any) => g.ready).length || 0}/${r.expected_profiles?.length || r.graphs?.length || '?'} profiles ready`}
                {r.graphs && r.graphs.length > 0 && (
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

      <h3>Bulk Actions</h3>
      <div className="action-row">
        <button
          className="btn secondary"
          onClick={() => handleAction('resume')}
          disabled={!!actionInProgress || !!serviceAction}
        >
          {actionInProgress === 'resume' ? 'Resuming...' : 'Resume All'}
        </button>
        <button
          className="btn secondary"
          onClick={() => handleAction('suspend')}
          disabled={!!actionInProgress || !!serviceAction}
        >
          {actionInProgress === 'suspend' ? 'Suspending...' : 'Suspend All'}
        </button>
        <button
          className="btn secondary"
          onClick={() => { fetchStatus(); checkHealth(); fetchOrsReadiness(); }}
          disabled={!!actionInProgress || !!serviceAction}
        >
          Refresh
        </button>
      </div>

      <h3>Scale</h3>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
        Sets replica count for the main routing service and gateway.
      </div>
      <div className="scale-row">
        <label>
          Min replicas
          <input type="number" min={1} max={20} value={scaleMin} onChange={(e) => setScaleMin(Number(e.target.value))} />
        </label>
        <label>
          Max replicas
          <input type="number" min={1} max={20} value={scaleMax} onChange={(e) => setScaleMax(Number(e.target.value))} />
        </label>
        <button
          className="btn primary"
          onClick={() => handleAction('scale', { min: scaleMin, max: scaleMax })}
          disabled={!!actionInProgress || !!serviceAction}
        >
          {actionInProgress === 'scale' ? 'Applying...' : 'Apply'}
        </button>
      </div>
    </div>
  );
}
