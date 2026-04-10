import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line, PieChart, Pie, Cell } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { fmtDec } from '../../shared/format';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function DeviationDashboard({ sourceDb, sourceSchema }: Props) {
  const { regionName, center, zoom } = useRegion();

  const { data: kpis } = useSfQuery(
    `SELECT COUNT(*) AS TOTAL_ROUTES, 
            ROUND(AVG(DISTANCE_DEVIATION_KM), 2) AS AVG_DEVIATION_KM,
            ROUND(AVG(DISTANCE_DEVIATION_PCT), 1) AS AVG_DEVIATION_PCT,
            SUM(CASE WHEN DISTANCE_DEVIATION_PCT > 20 THEN 1 ELSE 0 END) AS HIGH_DEVIATION_COUNT,
            ROUND(100.0 * SUM(CASE WHEN DISTANCE_DEVIATION_PCT <= 5 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS ON_ROUTE_PCT
     FROM TRIP_DEVIATION_ANALYSIS WHERE REGION = '${regionName}'`, sourceDb, sourceSchema, [regionName]);

  const { data: daily } = useSfQuery(
    `SELECT TRIP_DATE, TOTAL_TRIPS AS ROUTES, ROUND(DEVIATION_RATE_PCT, 1) AS AVG_DEV_PCT
     FROM DAILY_DEVIATION_TRENDS WHERE REGION = '${regionName}' ORDER BY TRIP_DATE LIMIT 30`, sourceDb, sourceSchema, [regionName]);

  const { data: buckets } = useSfQuery(
    `SELECT CASE WHEN DISTANCE_DEVIATION_PCT <= 5 THEN '0-5%' WHEN DISTANCE_DEVIATION_PCT <= 10 THEN '5-10%' 
            WHEN DISTANCE_DEVIATION_PCT <= 20 THEN '10-20%' ELSE '>20%' END AS BUCKET, COUNT(*) AS CNT
     FROM TRIP_DEVIATION_ANALYSIS WHERE REGION = '${regionName}' GROUP BY 1 ORDER BY 1`, sourceDb, sourceSchema, [regionName]);

  const { data: topDeviators } = useSfQuery(
    `SELECT DRIVER_ID, TOTAL_TRIPS AS ROUTES,
            ROUND(AVG_DISTANCE_DEVIATION_PCT, 1) AS AVG_DEV_PCT,
            ROUND(MAX_DISTANCE_DEVIATION_PCT, 2) AS MAX_DEV_PCT,
            ROUND(TOTAL_EXCESS_KM, 1) AS EXCESS_KM
     FROM DRIVER_DEVIATION_SUMMARY WHERE REGION = '${regionName}' ORDER BY AVG_DISTANCE_DEVIATION_PCT DESC LIMIT 15`, sourceDb, sourceSchema, [regionName]);

  const k = kpis[0] || {};

  const dailyData = useMemo(() =>
    daily.map((r: any) => ({ day: String(r.TRIP_DATE).slice(5), routes: Number(r.ROUTES), devPct: Number(r.AVG_DEV_PCT) })), [daily]);

  const pieData = useMemo(() =>
    buckets.map((b: any) => ({ name: b.BUCKET, value: Number(b.CNT) })), [buckets]);

  const PIE_COLORS = ['#0DB048', '#E5A100', '#FF6B35', '#E5484D'];

  return (
    <div className="page-dashboard">
      <h2>Route Deviation Dashboard</h2>
      <div className="metric-grid">
        <MetricCard label="Total Routes" value={Number(k.TOTAL_ROUTES || 0).toLocaleString()} />
        <MetricCard label="Avg Deviation" value={`${fmtDec(k.AVG_DEVIATION_PCT)}%`} subtitle={`${fmtDec(k.AVG_DEVIATION_KM)} km`} />
        <MetricCard label="On-Route" value={`${fmtDec(k.ON_ROUTE_PCT)}%`} subtitle="within 5% deviation" />
        <MetricCard label="High Deviations" value={Number(k.HIGH_DEVIATION_COUNT || 0).toLocaleString()} subtitle=">20% deviation" />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Daily Trend</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={dailyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} unit="%" />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="devPct" stroke="#FF6B35" strokeWidth={2} dot={false} name="Deviation Rate %" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card" style={{ maxWidth: 260 }}>
          <h3>Deviation Distribution</h3>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {pieData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>Top Deviating Drivers</h3>
        <DataTable data={topDeviators} columns={['DRIVER_ID', 'ROUTES', 'AVG_DEV_PCT', 'MAX_DEV_PCT', 'EXCESS_KM']} />
      </div>
    </div>
  );
}
