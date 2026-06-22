'use client';

// Ops console (role-gated in production via FLEET_APP_OPS). Calls the OPS-bundle
// synapse verbs through /api/ops: suspend/resume SPCS services, check service
// status, set the active routing region, and run a substrate healthcheck. The
// same verbs are agent-invokable via the role-gated FLEET_OPS_AGENT. Heavy
// provisioning (region graph / matrix builds, Data Studio) stays in the control
// app per the hybrid decision and is linked out below.

import { useState } from 'react';

const SERVICES = [
  'FLEET_INTELLIGENCE.SYNAPSE_USER.FLEET_SA_APP',
  'OPENROUTESERVICE_APP.CORE.ROUTING_GATEWAY_SERVICE',
  'OPENROUTESERVICE_APP.CORE.ORS_SERVICE_EUROPE',
  'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_EUROPE',
  'OPENROUTESERVICE_APP.CORE.ORS_SERVICE_GERMANY',
  'OPENROUTESERVICE_APP.CORE.VROOM_SERVICE_GERMANY',
];

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

export function OpsConsoleView() {
  const [region, setRegion] = useState('Europe');
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const append = (line: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 40));

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

  const card = { border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '8px', padding: '12px', backgroundColor: 'var(--surface-primary, #fff)' };
  const btn = (disabled: boolean, variant: 'primary' | 'default' = 'default') => ({
    padding: '6px 12px', fontSize: '12px', fontWeight: 600, borderRadius: '6px',
    border: variant === 'primary' ? 'none' : '1px solid var(--border-default, #e5e7eb)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    backgroundColor: variant === 'primary' ? 'var(--surface-accent-strong, #2563eb)' : 'var(--surface-primary, #fff)',
    color: variant === 'primary' ? '#fff' : 'var(--text-primary, #111827)', opacity: disabled ? 0.6 : 1,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', height: '100%', overflow: 'auto' }}>
      <div>
        <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '0 0 4px' }}>Ops Console</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', margin: 0 }}>
          Control the routing platform: service lifecycle, active region, and substrate health. Role-gated (FLEET_APP_OPS).
        </p>
      </div>

      <div style={card}>
        <div style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary, #6b7280)', marginBottom: '8px' }}>Active region</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <input value={region} onChange={(e) => setRegion(e.target.value)} style={{ padding: '6px 10px', fontSize: '13px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)' }} />
          <button onClick={setActiveRegion} disabled={busy === 'region'} style={btn(busy === 'region', 'primary')}>{busy === 'region' ? 'Setting…' : 'Set active region'}</button>
          <button onClick={health} disabled={busy === 'health'} style={btn(busy === 'health')}>{busy === 'health' ? 'Checking…' : 'Health check'}</button>
        </div>
      </div>

      <div style={card}>
        <div style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary, #6b7280)', marginBottom: '8px' }}>Services</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {SERVICES.map((svc) => (
            <div key={svc} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, fontSize: '12px', fontFamily: 'monospace' }}>{svc}</span>
              <button onClick={() => status(svc)} disabled={busy === `${svc}:STATUS`} style={btn(busy === `${svc}:STATUS`)}>Status</button>
              <button onClick={() => control(svc, 'RESUME')} disabled={busy === `${svc}:RESUME`} style={btn(busy === `${svc}:RESUME`)}>Resume</button>
              <button onClick={() => control(svc, 'SUSPEND')} disabled={busy === `${svc}:SUSPEND`} style={btn(busy === `${svc}:SUSPEND`)}>Suspend</button>
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <div style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-secondary, #6b7280)', marginBottom: '8px' }}>Activity</div>
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
