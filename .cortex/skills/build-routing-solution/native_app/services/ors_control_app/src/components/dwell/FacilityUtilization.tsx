import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { sfQuery } from './helpers';

export default function FacilityUtilization() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    sfQuery(`SELECT FACILITY_NAME, FACILITY_TYPE, TOTAL_VISITS, AVG_DWELL_MINUTES, UNIQUE_DRIVERS, PEAK_HOUR, SLA_BREACH_RATE FROM DT_FACILITY_UTILIZATION ORDER BY TOTAL_VISITS DESC LIMIT 50`)
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  const top15 = useMemo(() => data.slice(0, 15), [data]);
  const totalVisits = useMemo(() => data.reduce((s, r) => s + Number(r.TOTAL_VISITS || 0), 0), [data]);
  const avgDwell = useMemo(() => {
    if (data.length === 0) return 0;
    return (data.reduce((s, r) => s + Number(r.AVG_DWELL_MINUTES || 0), 0) / data.length).toFixed(1);
  }, [data]);
  const busiest = data[0]?.FACILITY_NAME || '—';
  const types = useMemo(() => new Set(data.map(r => r.FACILITY_TYPE)).size, [data]);

  return (
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Facility Utilization</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Dwell time patterns across facilities</p>

      {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16 }}>Loading...</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Visits', value: totalVisits.toLocaleString() },
          { label: 'Avg Dwell', value: `${avgDwell} min` },
          { label: 'Busiest', value: busiest },
          { label: 'Facility Types', value: types },
        ].map(m => (
          <div key={m.label} style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{m.value}</div>
          </div>
        ))}
      </div>

      {top15.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Top 15 Facilities</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={top15}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="FACILITY_NAME" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={60} />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar yAxisId="left" dataKey="TOTAL_VISITS" fill="var(--accent)" name="Visits" radius={[4, 4, 0, 0]} />
              <Bar yAxisId="right" dataKey="AVG_DWELL_MINUTES" fill="var(--yellow)" name="Avg Dwell (min)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {data.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Throughput vs Dwell Time</h3>
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="TOTAL_VISITS" name="Visits" tick={{ fontSize: 11 }} />
              <YAxis dataKey="AVG_DWELL_MINUTES" name="Avg Dwell (min)" tick={{ fontSize: 11 }} />
              <ZAxis dataKey="UNIQUE_DRIVERS" range={[40, 400]} name="Drivers" />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} />
              <Scatter data={data} fill="var(--accent)" opacity={0.7} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}

      {data.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>All Facilities</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Facility', 'Type', 'Visits', 'Avg Dwell', 'Drivers', 'Peak Hour', 'Breach Rate'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                    <td style={{ padding: '8px 12px' }}>{r.FACILITY_NAME}</td>
                    <td style={{ padding: '8px 12px' }}>{r.FACILITY_TYPE}</td>
                    <td style={{ padding: '8px 12px' }}>{Number(r.TOTAL_VISITS).toLocaleString()}</td>
                    <td style={{ padding: '8px 12px' }}>{Number(r.AVG_DWELL_MINUTES).toFixed(1)} min</td>
                    <td style={{ padding: '8px 12px' }}>{r.UNIQUE_DRIVERS}</td>
                    <td style={{ padding: '8px 12px' }}>{r.PEAK_HOUR}:00</td>
                    <td style={{ padding: '8px 12px' }}>{Number(r.SLA_BREACH_RATE).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
