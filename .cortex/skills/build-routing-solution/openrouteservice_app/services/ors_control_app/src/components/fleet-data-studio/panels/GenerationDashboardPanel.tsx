// Panel 3: live generation status block + log tail + skills coverage list
// + data distribution donut chart.

import React from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { AlertCircle, CheckCircle } from 'lucide-react';
import { CoverageEntry, JobInfo, PIE_COLORS, SKILL_MAP, VEHICLE_COLORS } from '../helpers';

interface Props {
  activeJobs: JobInfo[];
  logLines: string[];
  logRef: React.Ref<HTMLDivElement>;
  coverage: CoverageEntry[];
  skillsReady: Record<string, boolean>;
  profileData: { name: string; value: number; vehicleType: string }[];
}

export default function GenerationDashboardPanel({
  activeJobs, logLines, logRef, coverage, skillsReady, profileData,
}: Props) {
  return (
    <div className="chart-card" style={{ padding: 16 }}>
      <h3 style={{ fontSize: 14, marginBottom: 12 }}>Generation Status</h3>

      {activeJobs.filter((j) => j.status === 'RUNNING').map((j) => (
        <div
          key={j.jobId}
          style={{
            marginBottom: 12, padding: 10, borderRadius: 6,
            border: `1px solid ${VEHICLE_COLORS[j.vehicleType] || '#29B5E8'}`,
            background: `${VEHICLE_COLORS[j.vehicleType] || '#29B5E8'}08`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{j.presetName}</span>
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: '#E6F0FF', color: '#1A73E8' }}>Running</span>
          </div>
          <div style={{ fontSize: 11, color: '#6E7681', marginTop: 4 }}>{j.region} | {j.orsProfile}</div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, fontSize: 12 }}>
            <span style={{ fontWeight: 600, color: VEHICLE_COLORS[j.vehicleType] || '#29B5E8' }}>{j.pointsGenerated?.toLocaleString() || 0} pts</span>
            <span style={{ color: '#6E7681' }}>{j.tripsGenerated?.toLocaleString() || 0} trips</span>
          </div>
        </div>
      ))}

      <div ref={logRef} style={{ background: '#1B1F23', color: '#8DC891', borderRadius: 6, padding: 10, fontFamily: 'monospace', fontSize: 11, height: 160, overflowY: 'auto', marginBottom: 12 }}>
        {logLines.length === 0
          ? <span style={{ color: '#6E7681' }}>No active generation</span>
          : logLines.map((line, i) => <div key={i}>{line}</div>)}
      </div>

      <h4 style={{ fontSize: 12, marginBottom: 8 }}>Skills Coverage</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {Object.entries(SKILL_MAP).map(([skillId, skillName]) => {
          const ready = skillsReady[skillId];
          const totalTelemetry = (coverage || []).reduce((s, c) => s + (c.TELEMETRY_ROWS || 0), 0);
          const totalTripsC = (coverage || []).reduce((s, c) => s + (c.TRIP_ROWS || 0), 0);
          const totalVehiclesC = (coverage || []).reduce((s, c) => s + (c.VEHICLES || 0), 0);
          return (
            <div
              key={skillId}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6,
                background: ready ? '#F6FFF8' : '#FAFBFC',
                border: `1px solid ${ready ? '#C8E6C9' : '#E1E4E8'}`,
              }}
            >
              {ready ? <CheckCircle size={14} color="#4CAF50" /> : <AlertCircle size={14} color="#9CA3AF" />}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#24292F' }}>{skillName}</div>
                {ready ? (
                  <div style={{ fontSize: 10, color: '#6E7681' }}>
                    {totalTelemetry.toLocaleString()} pts | {totalTripsC.toLocaleString()} trips | {totalVehiclesC} vehicles
                  </div>
                ) : (
                  <div style={{ fontSize: 10, color: '#9CA3AF' }}>No data generated</div>
                )}
              </div>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: ready ? '#4CAF50' : '#E1E4E8' }} />
            </div>
          );
        })}
      </div>

      {profileData.length > 0 && (
        <>
          <h4 style={{ fontSize: 12, marginBottom: 6 }}>Data Distribution</h4>
          <ResponsiveContainer width="100%" height={120}>
            <PieChart>
              <Pie data={profileData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={48} label={({ name }) => name} labelLine={{ stroke: '#ccc' }}>
                {profileData.map((d, i) => <Cell key={i} fill={VEHICLE_COLORS[d.vehicleType] || PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
}
