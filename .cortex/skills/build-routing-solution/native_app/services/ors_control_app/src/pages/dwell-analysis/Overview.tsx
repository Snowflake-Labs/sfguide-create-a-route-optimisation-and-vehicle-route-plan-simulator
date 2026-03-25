import { useMemo } from 'react';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

export default function Overview({ sourceDb, sourceSchema }: Props) {
  const { regionName } = useRegion();

  const { data: kpis, loading: kpiLoading } = useSfQuery(
    `SELECT
       COUNT(DISTINCT TRIP_ID) AS TOTAL_TRIPS,
       ROUND(AVG(DWELL_DURATION_MIN), 1) AS AVG_DWELL_MIN,
       ROUND(MEDIAN(DWELL_DURATION_MIN), 1) AS MEDIAN_DWELL_MIN,
       COUNT(DISTINCT DRIVER_ID) AS ACTIVE_DRIVERS,
       ROUND(100.0 * SUM(CASE WHEN SLA_STATUS = 'OK' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS SLA_COMPLIANCE_PCT
     FROM DT_DWELL_ENRICHED WHERE REGION = '${regionName}'`,
    sourceDb, sourceSchema, [regionName],
  );

  const { data: trends } = useSfQuery(
    `SELECT DAY, TOTAL_DWELLS, AVG_DWELL_MIN, TOTAL_TRIPS
     FROM DT_DAILY_TRENDS WHERE REGION = '${regionName}' ORDER BY DAY`,
    sourceDb, sourceSchema, [regionName],
  );

  const { data: topFacilities } = useSfQuery(
    `SELECT FACILITY_NAME, TOTAL_VISITS, ROUND(AVG_DWELL_MIN, 1) AS AVG_DWELL_MIN
     FROM DT_FACILITY_UTILIZATION WHERE REGION = '${regionName}' ORDER BY TOTAL_VISITS DESC LIMIT 10`,
    sourceDb, sourceSchema, [regionName],
  );

  const k = kpis[0] || {};

  const trendData = useMemo(() =>
    trends.map((r: any) => ({
      day: String(r.DAY).slice(5),
      dwells: Number(r.TOTAL_DWELLS),
      avgMin: Number(r.AVG_DWELL_MIN),
      trips: Number(r.TOTAL_TRIPS),
    })), [trends]);

  const facilityData = useMemo(() =>
    topFacilities.map((r: any) => ({
      name: String(r.FACILITY_NAME).slice(0, 20),
      visits: Number(r.TOTAL_VISITS),
      avgMin: Number(r.AVG_DWELL_MIN),
    })), [topFacilities]);

  return (
    <div className="page-dashboard">
      <h2>Dwell Analytics Overview</h2>
      <div className="metric-grid">
        <MetricCard label="Total Trips" value={kpiLoading ? '...' : Number(k.TOTAL_TRIPS || 0).toLocaleString()} subtitle="across all drivers" />
        <MetricCard label="Avg Dwell Time" value={kpiLoading ? '...' : `${k.AVG_DWELL_MIN || 0} min`} subtitle={`Median: ${k.MEDIAN_DWELL_MIN || 0} min`} />
        <MetricCard label="SLA Compliance" value={kpiLoading ? '...' : `${k.SLA_COMPLIANCE_PCT || 0}%`} subtitle="dwells within SLA" />
        <MetricCard label="Active Drivers" value={kpiLoading ? '...' : Number(k.ACTIVE_DRIVERS || 0).toLocaleString()} />
      </div>
      <div className="chart-row">
        <div className="chart-card">
          <h3>Daily Dwell Trends</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="day" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis tick={{ fill: '#6E7681', fontSize: 11 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Line type="monotone" dataKey="dwells" stroke="#29B5E8" strokeWidth={2} dot={false} name="Dwells" />
              <Line type="monotone" dataKey="trips" stroke="#FF6B35" strokeWidth={2} dot={false} name="Trips" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h3>Top Facilities by Visits</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={facilityData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis type="number" tick={{ fill: '#6E7681', fontSize: 11 }} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fill: '#6E7681', fontSize: 10 }} />
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
              <Bar dataKey="visits" radius={[0, 4, 4, 0]} name="Visits">
                {facilityData.map((_: any, i: number) => (
                  <Cell key={i} fill={i < 3 ? '#29B5E8' : '#3d4454'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
