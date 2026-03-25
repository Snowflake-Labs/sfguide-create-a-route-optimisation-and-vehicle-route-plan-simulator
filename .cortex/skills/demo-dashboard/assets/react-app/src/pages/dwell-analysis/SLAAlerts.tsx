import { useMemo, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { useSfQuery } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

const SEVERITY_COLORS: Record<string, string> = { CRITICAL: '#E5484D', WARNING: '#E5A100', INFO: '#29B5E8' };

export default function SLAAlerts({ sourceDb, sourceSchema }: Props) {
  const { regionName } = useRegion();

  const [severity, setSeverity] = useState('ALL');

  const { data, loading } = useSfQuery(
    `SELECT ALERT_ID, DRIVER_ID, FACILITY_NAME, SEVERITY, DWELL_DURATION_MIN, SLA_THRESHOLD_MIN,
            ROUND(DWELL_DURATION_MIN - SLA_THRESHOLD_MIN, 1) AS OVERAGE_MIN, ALERT_TIME
     FROM DT_SLA_ALERTS
     WHERE REGION = '${regionName}'${severity !== 'ALL' ? ` AND SEVERITY = '${severity}'` : ''}
     ORDER BY ALERT_TIME DESC LIMIT 200`,
    sourceDb, sourceSchema, [severity, regionName],
  );

  const { data: summary } = useSfQuery(
    `SELECT SEVERITY, COUNT(*) AS CNT FROM DT_SLA_ALERTS WHERE REGION = '${regionName}' GROUP BY SEVERITY`,
    sourceDb, sourceSchema, [regionName],
  );

  const pieData = useMemo(() =>
    summary.map((r: any) => ({
      name: r.SEVERITY,
      value: Number(r.CNT),
    })), [summary]);

  const totalAlerts = pieData.reduce((s, r) => s + r.value, 0);
  const critCount = pieData.find(r => r.name === 'CRITICAL')?.value || 0;
  const warnCount = pieData.find(r => r.name === 'WARNING')?.value || 0;

  return (
    <div className="page-dashboard">
      <h2>SLA Alerts</h2>
      <div className="metric-grid">
        <MetricCard label="Total Alerts" value={loading ? '...' : totalAlerts.toLocaleString()} />
        <MetricCard label="Critical" value={critCount.toLocaleString()} subtitle={`${totalAlerts ? ((critCount / totalAlerts) * 100).toFixed(1) : 0}%`} />
        <MetricCard label="Warning" value={warnCount.toLocaleString()} />
      </div>
      <div className="chart-row">
        <div className="chart-card" style={{ maxWidth: 260 }}>
          <h3>Severity Distribution</h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                {pieData.map((entry, i) => (
                  <Cell key={i} fill={SEVERITY_COLORS[entry.name] || '#3d4454'} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card" style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Alert Log</h3>
            <select className="form-select" style={{ width: 140 }} value={severity} onChange={e => setSeverity(e.target.value)}>
              <option value="ALL">All Severities</option>
              <option value="CRITICAL">Critical</option>
              <option value="WARNING">Warning</option>
            </select>
          </div>
          <DataTable data={data} columns={['SEVERITY', 'DRIVER_ID', 'FACILITY_NAME', 'DWELL_DURATION_MIN', 'SLA_THRESHOLD_MIN', 'OVERAGE_MIN', 'ALERT_TIME']} />
        </div>
      </div>
    </div>
  );
}
