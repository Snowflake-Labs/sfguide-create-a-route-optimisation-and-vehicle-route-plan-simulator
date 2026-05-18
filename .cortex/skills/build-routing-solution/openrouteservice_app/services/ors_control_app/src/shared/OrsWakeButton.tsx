import { useState, useEffect, useCallback, useRef } from 'react';
import { useRegion } from '../hooks/useRegion';

interface SvcStatus { name: string; status: string; cur: number; tgt: number; }

async function sfQuery(sql: string, database = 'OPENROUTESERVICE_APP', schema = 'CORE'): Promise<any[]> {
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, database, schema }) });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

export default function OrsWakeButton() {
  const { regionName } = useRegion();
  const [svcStatus, setSvcStatus] = useState<SvcStatus[]>([]);
  const [wakingUp, setWakingUp] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const requiredServices = [
    'ROUTING_GATEWAY_SERVICE',
    `ORS_SERVICE_${(regionName || '').toUpperCase()}`,
    `VROOM_SERVICE_${(regionName || '').toUpperCase()}`,
  ];

  const fetchSvcStatus = useCallback(async (): Promise<SvcStatus[]> => {
    await sfQuery(`SHOW SERVICES IN DATABASE OPENROUTESERVICE_APP`);
    const filterList = requiredServices.map(s => `'${s}'`).join(',');
    const rows = await sfQuery(
      `SELECT "name" AS NAME, "status" AS STATUS, "current_instances"::INT AS CUR, "target_instances"::INT AS TGT
       FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
       WHERE "name" IN (${filterList})`
    );
    const result = rows.map((r: any) => ({ name: r.NAME, status: r.STATUS, cur: Number(r.CUR) || 0, tgt: Number(r.TGT) || 0 }));
    setSvcStatus(result);
    return result;
  }, [regionName]);

  useEffect(() => {
    let active = true;
    const tick = async () => { try { const s = await fetchSvcStatus(); if (active) setSvcStatus(s); } catch {} };
    tick();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(tick, 30000);
    return () => { active = false; if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchSvcStatus]);

  useEffect(() => {
    const handler = () => { fetchSvcStatus(); };
    window.addEventListener('ors-region-switched', handler);
    return () => window.removeEventListener('ors-region-switched', handler);
  }, [fetchSvcStatus]);

  const allReady = svcStatus.length > 0 && svcStatus.every(s => s.status === 'RUNNING' && s.cur >= s.tgt);
  const anySuspended = svcStatus.some(s => s.status === 'SUSPENDED');
  const readyCount = svcStatus.filter(s => s.status === 'RUNNING' && s.cur >= s.tgt).length;

  const wakeUp = useCallback(async () => {
    setWakingUp(true);
    try {
      const initial = await fetchSvcStatus();
      const suspended = initial.filter(s => s.status === 'SUSPENDED').map(s => s.name);
      if (suspended.length) {
        await Promise.all(suspended.map(n =>
          sfQuery(`ALTER SERVICE OPENROUTESERVICE_APP.CORE.${n} RESUME`)
        ));
      }
      for (let i = 0; i < 18; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const next = await fetchSvcStatus();
        if (next.every(r => r.status === 'RUNNING' && r.cur >= r.tgt)) break;
      }
    } finally {
      setWakingUp(false);
    }
  }, [fetchSvcStatus]);

  if (!svcStatus.length) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 8px', borderRadius: 12, border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#9ca3af' }} />
        ORS checking...
      </span>
    );
  }

  if (allReady) {
    return (
      <span
        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 8px', borderRadius: 12, border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
        title={svcStatus.map(s => `${s.name}: ${s.status} ${s.cur}/${s.tgt}`).join('\n')}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10b981' }} />
        ORS ready
      </span>
    );
  }

  if (anySuspended) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 12, background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.35)', color: '#dc2626', fontWeight: 500 }}
          title={svcStatus.map(s => `${s.name}: ${s.status}`).join('\n')}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#ef4444' }} />
          ORS for {regionName} suspended
        </span>
        <button
          onClick={wakeUp}
          disabled={wakingUp}
          style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid #E5484D', background: 'rgba(229,72,77,0.12)', cursor: wakingUp ? 'not-allowed' : 'pointer', color: '#E5484D', fontWeight: 600 }}
          title="Resume suspended ORS routing services for this region"
        >
          {wakingUp ? 'Resuming...' : 'Resume'}
        </button>
      </span>
    );
  }

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 8px', borderRadius: 12, background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)', color: '#b45309', fontWeight: 500 }}
      title={svcStatus.map(s => `${s.name}: ${s.status} ${s.cur}/${s.tgt}`).join('\n')}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', animation: 'pulse 1.5s infinite' }} />
      {wakingUp ? 'Resuming...' : `Starting ${regionName}... (${readyCount}/${svcStatus.length})`}
    </span>
  );
}
