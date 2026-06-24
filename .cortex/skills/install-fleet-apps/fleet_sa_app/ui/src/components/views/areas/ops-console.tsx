'use client';

// Ops console (role-gated in production via FLEET_APP_OPS). Calls the OPS-bundle
// synapse verbs through /api/ops: live service+compute-pool inventory
// (service_inventory, wrapping CORE.GET_STATUS), suspend/resume SPCS services,
// check service status, set the active routing region, and run a substrate
// healthcheck. The same verbs are agent-invokable via the role-gated
// FLEET_OPS_AGENT. The Services section mirrors the ORS control app's Service
// Manager: services are grouped under their compute pool with live state.
// Heavy provisioning (region graph / matrix builds, Data Studio) stays in the
// control app per the hybrid decision and is linked out below.

import { useState, useEffect, useCallback, useMemo } from 'react';

// The app's own service lives in FLEET_INTELLIGENCE.SYNAPSE_USER, not in
// OPENROUTESERVICE_APP.CORE. The service_inventory verb now appends the Fleet
// app services (carrying fq_name) so they nest under their real compute pool.
// This standalone constant is the fallback row, rendered only when the SA app
// is absent from the grouped inventory (e.g. older OPS bundle / visibility miss).
const APP_SERVICE = 'FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP';
// Services discovered via service_inventory are bare names in this schema unless
// they carry an explicit fq_name (the Fleet app services do).
const ORS_SCHEMA = 'OPENROUTESERVICE_APP.CORE';

interface ServiceInfo {
  name: string;
  fq_name?: string;
  status?: string;
  compute_pool?: string;
  min_instances?: number;
  max_instances?: number;
  current_instances?: number;
  target_instances?: number;
  auto_suspend_secs?: number;
}

interface ComputePoolInfo {
  state?: string;
  instance_family?: string;
  min_nodes?: number;
  max_nodes?: number;
  active_nodes?: number;
  idle_nodes?: number;
  num_services?: number;
}

interface Inventory {
  compute_pool?: string;
  compute_pool_info?: ComputePoolInfo | null;
  compute_pools?: Record<string, ComputePoolInfo>;
  services?: ServiceInfo[];
}

async function ops(verb: string, args: unknown[]): Promise<unknown> {
  const res = await fetch('/api/ops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verb, args }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.result;
}

const RUNNING = (s?: string) => s === 'RUNNING' || s === 'READY';

export function OpsConsoleView() {
  const [region, setRegion] = useState('SanFrancisco');
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [invLoading, setInvLoading] = useState(true);

  const append = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 40));

  const fetchInventory = useCallback(async () => {
    try {
      const inv = (await ops('service_inventory', [])) as Inventory;
      setInventory(inv);
    } catch (err) {
      append(`inventory error: ${err instanceof Error ? err.message : 'failed'}`);
    } finally {
      setInvLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInventory();
    const interval = setInterval(fetchInventory, 15000);
    return () => clearInterval(interval);
  }, [fetchInventory]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      append(`ERROR: ${err instanceof Error ? err.message : 'failed'}`);
    } finally {
      setBusy(null);
    }
  };

  const setActiveRegion = () =>
    run('region', async () => {
      const r = (await ops('set_active_region', [region])) as { message?: string };
      append(`set_active_region(${region}): ${r?.message ?? 'ok'}`);
    });

  const control = (svc: string, action: 'SUSPEND' | 'RESUME') =>
    run(`${svc}:${action}`, async () => {
      const r = (await ops('service_control', [svc, action])) as { message?: string };
      append(`${action} ${svc}: ${r?.message ?? 'ok'}`);
      await fetchInventory();
    });

  const status = (svc: string) =>
    run(`${svc}:STATUS`, async () => {
      const r = (await ops('service_status', [svc])) as { status_json?: string };
      let summary = r?.status_json ?? '';
      try {
        const arr = JSON.parse(r?.status_json ?? '[]');
        if (Array.isArray(arr) && arr[0]?.status) summary = arr.map((i: { status?: string }) => i.status).join(', ');
      } catch { /* show raw */ }
      append(`STATUS ${svc}: ${String(summary).slice(0, 120)}`);
    });

  const health = () =>
    run('health', async () => {
      const r = (await ops('healthcheck', [])) as { ok?: boolean; core_functions?: number; tool_procs?: number };
      append(`healthcheck: ok=${r?.ok} core_fns=${r?.core_functions} tool_procs=${r?.tool_procs}`);
    });

  const services = inventory?.services ?? [];
  const computePools = inventory?.compute_pools ?? {};
  const runningCount = services.filter((s) => RUNNING(s.status)).length;
  // The SA app now arrives in the grouped inventory (nested under its pool). Only
  // fall back to the detached standalone row when it is absent (older OPS bundle).
  const appInInventory = services.some(
    (s) => (s.fq_name ?? '').toUpperCase() === APP_SERVICE || s.name.toUpperCase() === 'FLEET_SA_APP',
  );

  // Group services by compute pool (mirrors the control app Service Manager).
  const poolGroups = useMemo(() => {
    const grouped = new Map<string, ServiceInfo[]>();
    for (const svc of services) {
      const key = svc.compute_pool || 'UNASSIGNED';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(svc);
    }
    const names = Array.from(grouped.keys()).sort((a, b) => {
      const sizeDiff = (grouped.get(b)?.length ?? 0) - (grouped.get(a)?.length ?? 0);
      return sizeDiff !== 0 ? sizeDiff : a.localeCompare(b);
    });
    return names.map((name) => ({ name, svcs: grouped.get(name) ?? [], meta: computePools[name] }));
  }, [services, computePools]);

  const card: React.CSSProperties = { border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '8px', padding: '12px', backgroundColor: 'var(--surface-primary, #fff)' };
  const btn = (disabled: boolean, variant: 'primary' | 'default' = 'default'): React.CSSProperties => ({
    padding: '6px 12px', fontSize: '12px', fontWeight: 600, borderRadius: '6px',
    border: variant === 'primary' ? 'none' : '1px solid var(--border-default, #e5e7eb)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    backgroundColor: variant === 'primary' ? 'var(--surface-accent-strong, #2563eb)' : 'var(--surface-primary, #fff)',
    color: variant === 'primary' ? '#fff' : 'var(--text-primary, #111827)', opacity: disabled ? 0.6 : 1,
  });
  const badge = (kind: 'ok' | 'warn' | 'muted'): React.CSSProperties => ({
    display: 'inline-block', padding: '2px 8px', fontSize: '11px', fontWeight: 700, borderRadius: '999px',
    backgroundColor: kind === 'ok' ? 'rgba(34,197,94,0.15)' : kind === 'warn' ? 'rgba(234,179,8,0.18)' : 'rgba(107,114,128,0.15)',
    color: kind === 'ok' ? '#15803d' : kind === 'warn' ? '#a16207' : '#6b7280',
  });
  const label: React.CSSProperties = { fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary, #6b7280)', marginBottom: '8px' };

  const poolBadgeKind = (state?: string): 'ok' | 'warn' | 'muted' => {
    const s = (state || '').toLowerCase();
    if (s === 'active' || s === 'idle') return 'ok';
    if (s === 'starting' || s === 'resizing' || s === 'stopping') return 'warn';
    return 'muted';
  };

  const renderServiceRow = (fqName: string, displayName: string, svc?: ServiceInfo) => {
    const isRunning = RUNNING(svc?.status);
    const isSuspended = svc?.status === 'SUSPENDED';
    const isControlApp = displayName.toUpperCase() === 'ORS_CONTROL_APP';
    // Suspending the SA app would terminate the very UI issuing the request.
    const isSelf = displayName.toUpperCase() === 'FLEET_SA_APP' || fqName.toUpperCase() === APP_SERVICE;
    const noSuspend = isControlApp || isSelf;
    const noSuspendTitle = isControlApp
      ? 'ORS_CONTROL_APP cannot suspend itself'
      : isSelf
        ? 'FLEET_SA_APP cannot suspend itself (it serves this UI)'
        : undefined;
    const instances = svc?.max_instances != null
      ? `${svc.current_instances ?? '?'} / ${svc.max_instances}${svc.min_instances != null && svc.min_instances !== svc.max_instances ? ` (min ${svc.min_instances})` : ''}`
      : '\u2014';
    const drift = Number(svc?.auto_suspend_secs) === 0 && isRunning;
    return (
      <div key={fqName} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '4px 0' }}>
        <span style={{ flex: 1, minWidth: 200, fontSize: '12px', fontFamily: 'monospace' }}>{displayName}</span>
        {svc?.status != null && <span style={badge(isRunning ? 'ok' : isSuspended ? 'muted' : 'warn')}>{svc.status}</span>}
        <span style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)', minWidth: 70, whiteSpace: 'nowrap' }}>{instances}</span>
        {drift && <span style={badge('warn')} title="AUTO_SUSPEND_SECS=0 while running. Call CORE.RECONCILE_AUTO_SUSPEND() if no provisioning is in flight.">drift</span>}
        <button onClick={() => status(fqName)} disabled={busy === `${fqName}:STATUS`} style={btn(busy === `${fqName}:STATUS`)}>Status</button>
        <button onClick={() => control(fqName, 'RESUME')} disabled={busy === `${fqName}:RESUME` || isRunning} style={btn(busy === `${fqName}:RESUME` || isRunning)}>Resume</button>
        <button onClick={() => control(fqName, 'SUSPEND')} disabled={busy === `${fqName}:SUSPEND` || isSuspended || noSuspend} style={btn(busy === `${fqName}:SUSPEND` || isSuspended || noSuspend)} title={noSuspendTitle}>Suspend</button>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', height: '100%', overflow: 'auto' }}>
      <div>
        <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 4px' }}>Ops Console</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', margin: 0 }}>
          Control the routing platform: live service &amp; compute-pool status, service lifecycle, active region, and substrate health. Role-gated (FLEET_APP_OPS).
        </p>
      </div>

      <div style={card}>
        <div style={label}>Active region</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input value={region} onChange={(e) => setRegion(e.target.value)} style={{ padding: '6px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)' }} />
          <button onClick={setActiveRegion} disabled={busy === 'region'} style={btn(busy === 'region', 'primary')}>{busy === 'region' ? 'Setting\u2026' : 'Set active region'}</button>
          <button onClick={health} disabled={busy === 'health'} style={btn(busy === 'health')}>{busy === 'health' ? 'Checking\u2026' : 'Health check'}</button>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
          <div style={{ ...label, marginBottom: 0 }}>Services &amp; compute pools</div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)' }}>
              {invLoading && !inventory ? 'Loading\u2026' : `${runningCount} / ${services.length} running \u00B7 ${poolGroups.length} pool${poolGroups.length === 1 ? '' : 's'}`}
            </span>
            <button onClick={fetchInventory} disabled={false} style={btn(false)}>Refresh</button>
          </div>
        </div>

        {/* Fallback: render the SA app standalone only when the inventory did not
            include it (older OPS bundle / visibility miss). Normally it nests
            under its compute pool below. */}
        {!appInInventory && (
          <div style={{ borderBottom: '1px solid var(--border-default, #e5e7eb)', paddingBottom: '8px', marginBottom: '8px' }}>
            {renderServiceRow(APP_SERVICE, APP_SERVICE)}
          </div>
        )}

        {invLoading && !inventory ? (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>{'Loading service inventory\u2026'}</div>
        ) : poolGroups.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>No services found.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {poolGroups.map(({ name, svcs, meta }) => {
              const subtitle = [
                meta?.instance_family,
                meta?.active_nodes != null && meta?.max_nodes != null ? `${meta.active_nodes}/${meta.max_nodes} nodes` : null,
                `${svcs.length} service${svcs.length === 1 ? '' : 's'}`,
              ].filter(Boolean).join(' \u2022 ');
              return (
                <div key={name} style={{ border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '6px', padding: '8px 10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px', flexWrap: 'wrap', gap: '6px' }}>
                    <div>
                      <span style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace' }}>{name}</span>
                      {subtitle && <span style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)', marginLeft: '8px' }}>{subtitle}</span>}
                    </div>
                    <span style={badge(poolBadgeKind(meta?.state))}>{meta?.state || 'UNKNOWN'}</span>
                  </div>
                  {svcs.map((svc) => renderServiceRow(svc.fq_name ?? `${ORS_SCHEMA}.${svc.name}`, svc.name, svc))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={card}>
        <div style={label}>Activity</div>
        <pre style={{ fontSize: '11px', fontFamily: 'monospace', margin: 0, whiteSpace: 'pre-wrap', maxHeight: '220px', overflow: 'auto', color: 'var(--text-secondary, #374151)' }}>
          {log.length ? log.join('\n') : 'No actions yet.'}
        </pre>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>
        Heavy provisioning (region graph builds, matrix builds, synthetic Data Studio, Function Tester) remains in the ORS control app per the hybrid design. Config-stage editing of app-config.json / app-views.json is managed via the deploy stage (FLEET_APP_STAGE/config) + service restart.
      </div>
    </div>
  );
}
