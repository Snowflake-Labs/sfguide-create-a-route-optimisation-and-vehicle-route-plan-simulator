import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { sfQuery } from './helpers';

export default function DriverPerformance() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT TRUCK_ID AS DRIVER_ID, UNIQUE_LOCATIONS AS TOTAL_TRIPS, TOTAL_DWELL_SESSIONS AS TOTAL_DWELLS, ROUND(AVG_SESSION_MIN,1) AS AVG_DWELL_MINUTES, SLA_BREACH_COUNT AS SLA_BREACHES, ROUND(SLA_BREACH_COUNT*100.0/NULLIF(TOTAL_DWELL_SESSIONS,0),1) AS BREACH_RATE, ROUND(TOTAL_DWELL_MIN,0) AS TOTAL_DWELL_MINUTES FROM DT_DRIVER_DWELL_SUMMARY ORDER BY TOTAL_DWELL_SESSIONS DESC LIMIT 30`)
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  const drivers = data.length;
  const fleetAvg = useMemo(() => {
    if (data.length === 0) return 0;
    return (data.reduce((s, r) => s + Number(r.AVG_DWELL_MINUTES || 0), 0) / data.length).toFixed(1);
  }, [data]);
  const totalBreaches = useMemo(() => data.reduce((s, r) => s + Number(r.SLA_BREACHES || 0), 0), [data]);
  const best = useMemo(() => {
    if (data.length === 0) return '—';
    const sorted = [...data].sort((a, b) => Number(a.BREACH_RATE || 0) - Number(b.BREACH_RATE || 0));
    return sorted[0]?.DRIVER_ID || '—';
  }, [data]);

  const barColor = (breachRate: number) => {
    if (breachRate > 20) return '#E5484D';
    if (breachRate > 10) return '#E5A100';
    return '#0DB048';
  };

  return (
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Driver Performance</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Individual driver dwell time analysis</p>

      {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16 }}>Loading...</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Active Drivers', value: drivers },
          { label: 'Fleet Avg Dwell', value: `${fleetAvg} min` },
          { label: 'Total Breaches', value: totalBreaches.toLocaleString() },
          { label: 'Best Driver', value: best },
        ].map(m => (
          <div key={m.label} style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{m.value}</div>
          </div>
        ))}
      </div>

      {data.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Avg Dwell by Driver</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="DRIVER_ID" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={60} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="AVG_DWELL_MINUTES" name="Avg Dwell (min)" radius={[4, 4, 0, 0]}>
                {data.map((r, i) => <Cell key={i} fill={barColor(Number(r.BREACH_RATE || 0))} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {data.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>SLA Breach Rate by Driver</h3>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="DRIVER_ID" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={60} />
              <YAxis tick={{ fontSize: 11 }} unit="%" />
              <Tooltip />
              <Bar dataKey="BREACH_RATE" name="Breach Rate %" radius={[4, 4, 0, 0]}>
                {data.map((r, i) => <Cell key={i} fill={barColor(Number(r.BREACH_RATE || 0))} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {data.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Driver Details</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Driver', 'Trips', 'Dwells', 'Avg Dwell', 'Breaches', 'Breach Rate', 'Total Dwell'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 500 }}>{r.DRIVER_ID}</td>
                    <td style={{ padding: '8px 12px' }}>{r.TOTAL_TRIPS}</td>
                    <td style={{ padding: '8px 12px' }}>{r.TOTAL_DWELLS}</td>
                    <td style={{ padding: '8px 12px' }}>{Number(r.AVG_DWELL_MINUTES).toFixed(1)} min</td>
                    <td style={{ padding: '8px 12px' }}>{r.SLA_BREACHES}</td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{ color: barColor(Number(r.BREACH_RATE || 0)), fontWeight: 600 }}>{Number(r.BREACH_RATE).toFixed(1)}%</span>
                    </td>
                    <td style={{ padding: '8px 12px' }}>{Number(r.TOTAL_DWELL_MINUTES).toFixed(0)} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && data.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16 }}>No driver data found.</div>}
    </div>
  );
}
