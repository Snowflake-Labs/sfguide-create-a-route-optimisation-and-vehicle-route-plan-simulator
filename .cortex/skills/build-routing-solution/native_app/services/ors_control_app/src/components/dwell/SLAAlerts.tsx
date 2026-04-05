import { useState, useEffect, useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import MetricCard from '../../shared/MetricCard';
import DataTable from '../../shared/DataTable';
import { sfQuery } from './helpers';

const SEV_COLORS: Record<string, string> = { CRITICAL: '#E5484D', WARNING: '#E5A100', INFO: '#29B5E8' };

export default function SLAAlerts() {
  const [severity, setSeverity] = useState('ALL');
  const [alerts, setAlerts] = useState<any[]>([]);
  const [summary, setSummary] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    sfQuery(`SELECT SLA_STATUS AS SEVERITY, COUNT(*) AS CNT FROM DT_SLA_ALERTS GROUP BY SLA_STATUS`).then(rows => setSummary(rows));
  }, []);

  useEffect(() => {
    setLoading(true);
    const sevFilter = severity === 'ALL' ? '' : ` WHERE SLA_STATUS = '${severity}'`;
    sfQuery(
      `SELECT SESSION_ID AS ALERT_ID, SESSION_ID AS TRIP_ID, VEHICLE_ID AS DRIVER_ID, LOCATION_NAME AS FACILITY_NAME, SLA_STATUS AS SEVERITY, ROUND(DWELL_MINUTES,1) AS DWELL_DURATION_MIN, WARNING_MINUTES AS SLA_LIMIT_MIN, SESSION_START AS ALERT_TIME FROM DT_SLA_ALERTS${sevFilter} ORDER BY SESSION_START DESC LIMIT 100`
    ).then(rows => {
      setAlerts(rows);
      setLoading(false);
    });
  }, [severity]);

  const total = useMemo(() => summary.reduce((s, r) => s + Number(r.CNT || 0), 0), [summary]);
  const critical = useMemo(() => Number(summary.find(r => r.SEVERITY === 'CRITICAL')?.CNT || 0), [summary]);
  const warning = useMemo(() => Number(summary.find(r => r.SEVERITY === 'WARNING')?.CNT || 0), [summary]);
  const pieData = useMemo(() => summary.map(r => ({ name: r.SEVERITY, value: Number(r.CNT) })), [summary]);

  return (
    <div>
      <h3>SLA Alerts</h3>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>Service level agreement breach monitoring</p>
      <div className="metric-grid">
        <MetricCard label="Total Alerts" value={loading ? '...' : total.toLocaleString()} />
        <MetricCard label="Critical" value={loading ? '...' : critical.toLocaleString()} />
        <MetricCard label="Warning" value={loading ? '...' : warning.toLocaleString()} />
      </div>
      <div className="chart-row">
        {pieData.length > 0 && (
          <div className="chart-card" style={{ maxWidth: 300 }}>
            <h3>Severity Distribution</h3>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                  {pieData.map((entry, i) => <Cell key={i} fill={SEV_COLORS[entry.name] || '#999'} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="chart-card">
          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Filter by Severity</label>
            <select className="select" value={severity} onChange={e => setSeverity(e.target.value)}>
              <option value="ALL">All</option>
              <option value="CRITICAL">Critical</option>
              <option value="WARNING">Warning</option>
            </select>
          </div>
        </div>
      </div>
      <h3>Alert Log</h3>
      <DataTable data={alerts} columns={['ALERT_ID', 'TRIP_ID', 'DRIVER_ID', 'FACILITY_NAME', 'SEVERITY', 'DWELL_DURATION_MIN', 'SLA_LIMIT_MIN']} />
      {!loading && alerts.length === 0 && <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-secondary)', fontSize: 13 }}>No alerts found.</div>}
    </div>
  );
}
