import { useMemo } from 'react';
import { LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { useSfQuery } from '../../hooks/useSnowflake';
import { RD_DB, RD_SCHEMA } from './helpers';

const PIE_COLORS = ['#0DB048', '#29B5E8', '#E5A100', '#E5484D'];

export default function DeviationDashboard() {
  const { data: kpiRows, loading } = useSfQuery(
    `SELECT COUNT(*) AS TOTAL_ROUTES, ROUND(AVG(DISTANCE_DEVIATION_PCT), 1) AS AVG_DEVIATION_PCT, ROUND(SUM(CASE WHEN DISTANCE_DEVIATION_PCT <= 5 THEN 1 ELSE 0 END)*100.0/NULLIF(COUNT(*),0), 1) AS ON_ROUTE_PCT, SUM(CASE WHEN DISTANCE_DEVIATION_PCT > 20 THEN 1 ELSE 0 END) AS HIGH_DEVIATIONS FROM TRIP_DEVIATION_ANALYSIS`,
    RD_DB, RD_SCHEMA,
  );

  const { data: trends } = useSfQuery(
    `SELECT TRIP_DATE, TOTAL_TRIPS AS ROUTES, ROUND(DEVIATION_RATE_PCT, 1) AS AVG_DEV_PCT FROM DAILY_DEVIATION_TRENDS ORDER BY TRIP_DATE LIMIT 30`,
    RD_DB, RD_SCHEMA,
  );

  const { data: buckets } = useSfQuery(
    `SELECT CASE WHEN DISTANCE_DEVIATION_PCT <= 5 THEN '0-5%' WHEN DISTANCE_DEVIATION_PCT <= 10 THEN '5-10%' WHEN DISTANCE_DEVIATION_PCT <= 20 THEN '10-20%' ELSE '20%+' END AS BUCKET, COUNT(*) AS CNT FROM TRIP_DEVIATION_ANALYSIS GROUP BY 1 ORDER BY 1`,
    RD_DB, RD_SCHEMA,
  );

  const { data: topDeviators } = useSfQuery(
    `SELECT DRIVER_ID, TOTAL_TRIPS AS ROUTES, ROUND(AVG_DISTANCE_DEVIATION_PCT, 1) AS AVG_DEV_PCT, ROUND(AVG_DURATION_DEVIATION_PCT, 1) AS AVG_TIME_DEV FROM DRIVER_DEVIATION_SUMMARY ORDER BY AVG_DISTANCE_DEVIATION_PCT DESC LIMIT 15`,
    RD_DB, RD_SCHEMA,
  );

  const kpis = kpiRows[0] || {};
  const pieData = useMemo(() => buckets.map(r => ({ name: r.BUCKET, value: Number(r.CNT) })), [buckets]);

  return (
    <div className="page-dashboard">
      <h2>Deviation Dashboard</h2>
      <p>Route deviation analytics overview</p>
      <div className="metric-grid">
        <MetricCard label="Total Routes" value={loading ? '...' : Number(kpis.TOTAL_ROUTES || 0).toLocaleString()} />
        <MetricCard label="Avg Deviation" value={loading ? '...' : `${kpis.AVG_DEVIATION_PCT ?? '—'}%`} />
        <MetricCard label="On-Route %" value={loading ? '...' : `${kpis.ON_ROUTE_PCT ?? '—'}%`} />
        <MetricCard label="High Deviations" value={loading ? '...' : (kpis.HIGH_DEVIATIONS ?? '—')} />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Daily Trend</h3>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={trends}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="TRIP_DATE" tick={{ fill: '#6E7681', fontSize: 10 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="ROUTES" stroke="#29B5E8" strokeWidth={2} dot={false} name="Routes" />
              <Line type="monotone" dataKey="AVG_DEV_PCT" stroke="#E5A100" strokeWidth={2} dot={false} name="Dev %" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {pieData.length > 0 && (
          <div className="chart-card" style={{ maxWidth: 300 }}>
            <h3>Distribution</h3>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                  {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      <h3>Top Deviators</h3>
      <DataTable data={topDeviators} columns={['DRIVER_ID', 'ROUTES', 'AVG_DEV_PCT', 'AVG_TIME_DEV']} />
    </div>
  );
}
