import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { sfQuery } from './helpers';

const barColor = (breachRate: number) => {
  if (breachRate > 20) return '#E5484D';
  if (breachRate > 10) return '#E5A100';
  return '#0DB048';
};

export default function DriverPerformance() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    sfQuery(
      `SELECT TRUCK_ID AS DRIVER_ID, UNIQUE_LOCATIONS AS TOTAL_TRIPS, TOTAL_DWELL_SESSIONS AS TOTAL_DWELLS, ROUND(AVG_SESSION_MIN,1) AS AVG_DWELL_MINUTES, SLA_BREACH_COUNT AS SLA_BREACHES, ROUND(SLA_BREACH_COUNT*100.0/NULLIF(TOTAL_DWELL_SESSIONS,0),1) AS BREACH_RATE, ROUND(TOTAL_DWELL_MIN,0) AS TOTAL_DWELL_MINUTES FROM DT_DRIVER_DWELL_SUMMARY ORDER BY TOTAL_DWELL_SESSIONS DESC LIMIT 30`
    ).then(rows => {
      setData(rows);
      setLoading(false);
    });
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

  return (
    <div>
      <h3>Driver Performance</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>Individual driver dwell time analysis</p>
      <div className="metric-grid">
        <MetricCard label="Active Drivers" value={loading ? '...' : drivers} />
        <MetricCard label="Fleet Avg Dwell" value={loading ? '...' : `${fleetAvg} min`} />
        <MetricCard label="Total Breaches" value={loading ? '...' : totalBreaches.toLocaleString()} />
        <MetricCard label="Best Driver" value={loading ? '...' : best} />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Avg Dwell by Driver</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="DRIVER_ID" tick={{ fill: '#6E7681', fontSize: 10 }} angle={-30} textAnchor="end" height={60} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="AVG_DWELL_MINUTES" name="Avg Dwell (min)" radius={[4, 4, 0, 0]}>
                {data.map((r, i) => <Cell key={i} fill={barColor(Number(r.BREACH_RATE || 0))} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h3>SLA Breach Rate by Driver</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="DRIVER_ID" tick={{ fill: '#6E7681', fontSize: 10 }} angle={-30} textAnchor="end" height={60} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} unit="%" />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="BREACH_RATE" name="Breach Rate %" radius={[4, 4, 0, 0]}>
                {data.map((r, i) => <Cell key={i} fill={barColor(Number(r.BREACH_RATE || 0))} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <h3>Driver Details</h3>
      <DataTable data={data} columns={['DRIVER_ID', 'TOTAL_TRIPS', 'TOTAL_DWELLS', 'AVG_DWELL_MINUTES', 'SLA_BREACHES', 'BREACH_RATE', 'TOTAL_DWELL_MINUTES']} />
      {!loading && data.length === 0 && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 13 }}>No driver data found.</div>}
    </div>
  );
}
