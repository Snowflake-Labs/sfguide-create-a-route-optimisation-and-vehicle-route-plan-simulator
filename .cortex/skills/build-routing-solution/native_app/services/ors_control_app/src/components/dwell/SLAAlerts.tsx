import { useState, useEffect, useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { sfQuery } from './helpers';

const SEV_COLORS: Record<string, string> = { CRITICAL: '#E5484D', WARNING: '#E5A100', INFO: '#29B5E8' };

export default function SLAAlerts() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [severity, setSeverity] = useState('ALL');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const sevFilter = severity === 'ALL' ? '' : ` WHERE SLA_STATUS = '${severity}'`;
    Promise.all([
      sfQuery(`SELECT SESSION_ID AS ALERT_ID, SESSION_ID AS TRIP_ID, TRUCK_ID AS DRIVER_ID, LOCATION_NAME AS FACILITY_NAME, SLA_STATUS AS SEVERITY, ROUND(DWELL_MINUTES,1) AS DWELL_DURATION_MIN, WARNING_MINUTES AS SLA_LIMIT_MIN, SESSION_START AS ALERT_TIME FROM DT_SLA_ALERTS${sevFilter} ORDER BY SESSION_START DESC LIMIT 100`),
      sfQuery(`SELECT SLA_STATUS AS SEVERITY, COUNT(*) AS CNT FROM DT_SLA_ALERTS GROUP BY SLA_STATUS`),
    ]).then(([a, s]) => {
      setAlerts(a);
      setSummary(s);
    }).finally(() => setLoading(false));
  }, [severity]);

  const total = useMemo(() => summary.reduce((s, r) => s + Number(r.CNT || 0), 0), [summary]);
  const critical = useMemo(() => Number(summary.find(r => r.SEVERITY === 'CRITICAL')?.CNT || 0), [summary]);
  const warning = useMemo(() => Number(summary.find(r => r.SEVERITY === 'WARNING')?.CNT || 0), [summary]);

  const pieData = useMemo(() => summary.map(r => ({ name: r.SEVERITY, value: Number(r.CNT) })), [summary]);

  return (
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>SLA Alerts</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Service level agreement breach monitoring</p>

      {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16 }}>Loading...</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Alerts', value: total.toLocaleString() },
          { label: 'Critical', value: critical.toLocaleString() },
          { label: 'Warning', value: warning.toLocaleString() },
        ].map(m => (
          <div key={m.label} style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{m.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20 }}>
        {pieData.length > 0 && (
          <div style={{ flex: '0 0 250px' }}>
            <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Severity Distribution</h3>
            <ResponsiveContainer width={250} height={200}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                  {pieData.map((entry, i) => <Cell key={i} fill={SEV_COLORS[entry.name] || '#999'} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}

        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Filter by Severity</label>
            <select className="select" value={severity} onChange={e => setSeverity(e.target.value)}>
              <option value="ALL">All</option>
              <option value="CRITICAL">Critical</option>
              <option value="WARNING">Warning</option>
            </select>
          </div>
        </div>
      </div>

      {alerts.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Alert Log</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Alert ID', 'Trip', 'Driver', 'Facility', 'Severity', 'Dwell (min)', 'SLA Limit'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {alerts.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11 }}>{r.ALERT_ID}</td>
                    <td style={{ padding: '8px 12px' }}>{r.TRIP_ID}</td>
                    <td style={{ padding: '8px 12px' }}>{r.DRIVER_ID}</td>
                    <td style={{ padding: '8px 12px' }}>{r.FACILITY_NAME}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: `${SEV_COLORS[r.SEVERITY] || '#999'}20`, color: SEV_COLORS[r.SEVERITY] || '#999' }}>{r.SEVERITY}</span>
                    </td>
                    <td style={{ padding: '8px 12px' }}>{Number(r.DWELL_DURATION_MIN).toFixed(1)}</td>
                    <td style={{ padding: '8px 12px' }}>{r.SLA_LIMIT_MIN}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && alerts.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16 }}>No alerts found.</div>}
    </div>
  );
}
