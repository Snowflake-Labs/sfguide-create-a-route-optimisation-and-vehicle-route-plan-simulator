import { useState, useEffect, useMemo } from 'react';
import { LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { sfQuery } from './helpers';

const PIE_COLORS = ['#0DB048', '#29B5E8', '#E5A100', '#E5484D'];

export default function DeviationDashboard() {
  const [kpis, setKpis] = useState<any>({});
  const [trends, setTrends] = useState<any[]>([]);
  const [buckets, setBuckets] = useState<any[]>([]);
  const [topDeviators, setTopDeviators] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      sfQuery(`SELECT COUNT(*) AS TOTAL_ROUTES, ROUND(AVG(DISTANCE_DEVIATION_KM), 2) AS AVG_DEVIATION_KM, ROUND(SUM(CASE WHEN DISTANCE_DEVIATION_PCT <= 5 THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(*),0), 1) AS ON_ROUTE_PCT, SUM(CASE WHEN DISTANCE_DEVIATION_PCT > 20 THEN 1 ELSE 0 END) AS HIGH_DEVIATIONS FROM TRIP_DEVIATION_ANALYSIS`),
      sfQuery(`SELECT TRIP_DATE, TOTAL_TRIPS AS ROUTES, ROUND(DEVIATION_RATE_PCT, 1) AS AVG_DEV_PCT FROM DAILY_DEVIATION_TRENDS ORDER BY TRIP_DATE LIMIT 30`),
      sfQuery(`SELECT CASE WHEN DISTANCE_DEVIATION_PCT <= 5 THEN '0-5%' WHEN DISTANCE_DEVIATION_PCT <= 10 THEN '5-10%' WHEN DISTANCE_DEVIATION_PCT <= 20 THEN '10-20%' ELSE '20%+' END AS BUCKET, COUNT(*) AS CNT FROM TRIP_DEVIATION_ANALYSIS GROUP BY 1 ORDER BY 1`),
      sfQuery(`SELECT DRIVER_ID, TOTAL_TRIPS AS ROUTES, ROUND(AVG_DISTANCE_DEVIATION_PCT, 1) AS AVG_DEV_PCT, ROUND(AVG_TIME_DEVIATION_PCT, 1) AS AVG_TIME_DEV FROM DRIVER_DEVIATION_SUMMARY ORDER BY AVG_DISTANCE_DEVIATION_PCT DESC LIMIT 15`),
    ]).then(([k, t, b, d]) => {
      setKpis(k[0] || {});
      setTrends(t);
      setBuckets(b);
      setTopDeviators(d);
    }).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Deviation Dashboard</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Route deviation analytics overview</p>

      {loading && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16 }}>Loading...</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Routes', value: Number(kpis.TOTAL_ROUTES || 0).toLocaleString() },
          { label: 'Avg Deviation', value: `${kpis.AVG_DEVIATION_KM ?? '—'} km` },
          { label: 'On-Route %', value: `${kpis.ON_ROUTE_PCT ?? '—'}%` },
          { label: 'High Deviations', value: kpis.HIGH_DEVIATIONS ?? '—' },
        ].map(m => (
          <div key={m.label} style={{ padding: 16, borderRadius: 8, background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.label}</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{m.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20 }}>
        {trends.length > 0 && (
          <div style={{ flex: 1, minWidth: 300 }}>
            <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Daily Trend</h3>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trends}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="TRIP_DATE" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Line type="monotone" dataKey="ROUTES" stroke="var(--accent)" strokeWidth={2} dot={false} name="Routes" />
                <Line type="monotone" dataKey="AVG_DEV_PCT" stroke="#E5A100" strokeWidth={2} dot={false} name="Dev %" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {buckets.length > 0 && (
          <div style={{ flex: '0 0 250px' }}>
            <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Distribution</h3>
            <ResponsiveContainer width={250} height={220}>
              <PieChart>
                <Pie data={buckets} dataKey="CNT" nameKey="BUCKET" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                  {buckets.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {topDeviators.length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Top Deviators</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>{['Driver', 'Routes', 'Avg Dev %', 'Time Dev %'].map(h => <th key={h} style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontWeight: 500 }}>{h}</th>)}</tr></thead>
              <tbody>{topDeviators.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                  <td style={{ padding: '8px 12px', fontWeight: 500 }}>{r.DRIVER_ID}</td>
                  <td style={{ padding: '8px 12px' }}>{r.ROUTES}</td>
                  <td style={{ padding: '8px 12px', color: Number(r.AVG_DEV_PCT) > 20 ? '#E5484D' : undefined }}>{r.AVG_DEV_PCT}%</td>
                  <td style={{ padding: '8px 12px' }}>{r.AVG_TIME_DEV}%</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
