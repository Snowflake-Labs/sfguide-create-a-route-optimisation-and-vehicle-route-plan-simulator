import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function DriverPerformance({ sourceDb, sourceSchema }: Props) {
  const { regionName } = useRegion();

  const { data, loading } = useSfQuery(
    `SELECT DRIVER_ID, TOTAL_TRIPS, TOTAL_DWELLS,
            ROUND(AVG_DWELL_MIN, 1) AS AVG_DWELL_MIN,
            ROUND(P95_DWELL_MIN, 1) AS P95_DWELL_MIN,
            SLA_BREACH_COUNT,
            ROUND(100.0 * SLA_BREACH_COUNT / NULLIF(TOTAL_DWELLS, 0), 1) AS BREACH_PCT
     FROM DT_DRIVER_DWELL_SUMMARY WHERE REGION = '${regionName}' ORDER BY TOTAL_TRIPS DESC LIMIT 50`,
    sourceDb, sourceSchema, [regionName],
  );

  const kpis = useMemo(() => {
    if (!data.length) return { drivers: 0, avgDwell: 0, breaches: 0, bestDriver: '--' };
    const drivers = data.length;
    const avgDwell = (data.reduce((s: number, r: any) => s + Number(r.AVG_DWELL_MIN), 0) / data.length).toFixed(1);
    const breaches = data.reduce((s: number, r: any) => s + Number(r.SLA_BREACH_COUNT), 0);
    const best = [...data].sort((a: any, b: any) => Number(a.BREACH_PCT) - Number(b.BREACH_PCT))[0];
    return { drivers, avgDwell, breaches, bestDriver: best?.DRIVER_ID || '--' };
  }, [data]);

  const chartData = useMemo(() =>
    data.slice(0, 20).map((r: any) => ({
      driver: String(r.DRIVER_ID).slice(-6),
      avgMin: Number(r.AVG_DWELL_MIN),
      breachPct: Number(r.BREACH_PCT),
    })), [data]);

  return (
    <div className="page-dashboard">
      <h2>Driver Performance</h2>
      <div className="metric-grid">
        <MetricCard label="Active Drivers" value={loading ? '...' : kpis.drivers} />
        <MetricCard label="Fleet Avg Dwell" value={loading ? '...' : `${kpis.avgDwell} min`} />
        <MetricCard label="Total Breaches" value={loading ? '...' : kpis.breaches.toLocaleString()} />
        <MetricCard label="Best Driver" value={loading ? '...' : String(kpis.bestDriver).slice(-8)} subtitle="Lowest breach rate" />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Avg Dwell by Driver</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="driver" tick={{ fill: '#6E7681', fontSize: 10 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="avgMin" radius={[4, 4, 0, 0]} name="Avg Dwell (min)">
                {chartData.map((d, i) => (
                  <Cell key={i} fill={d.breachPct > 20 ? '#E5484D' : d.breachPct > 10 ? '#E5A100' : '#0DB048'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h3>SLA Breach Rate by Driver</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="driver" tick={{ fill: '#6E7681', fontSize: 10 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} unit="%" />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="breachPct" radius={[4, 4, 0, 0]} name="Breach %">
                {chartData.map((d, i) => (
                  <Cell key={i} fill={d.breachPct > 20 ? '#E5484D' : d.breachPct > 10 ? '#E5A100' : '#0DB048'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="chart-card" style={{ marginTop: 16 }}>
        <h3>Driver Details</h3>
        <DataTable data={data} columns={['DRIVER_ID', 'TOTAL_TRIPS', 'TOTAL_DWELLS', 'AVG_DWELL_MIN', 'P95_DWELL_MIN', 'SLA_BREACH_COUNT', 'BREACH_PCT']} />
      </div>
    </div>
  );
}
