import { useState } from 'react';
import DwellOverview from './dwell/DwellOverview';
import FacilityUtilization from './dwell/FacilityUtilization';
import SLAAlerts from './dwell/SLAAlerts';
import DriverPerformance from './dwell/DriverPerformance';
import CongestionMap from './dwell/CongestionMap';
import TripInspector from './dwell/TripInspector';
import LiveOperations from './dwell/LiveOperations';

type SubTab = 'overview' | 'facilities' | 'sla' | 'drivers' | 'congestion' | 'trips' | 'live';

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'facilities', label: 'Facilities' },
  { key: 'sla', label: 'SLA Alerts' },
  { key: 'drivers', label: 'Drivers' },
  { key: 'congestion', label: 'Congestion Map' },
  { key: 'trips', label: 'Trip Inspector' },
  { key: 'live', label: 'Live Ops' },
];

export default function DwellAnalysis() {
  const [activeTab, setActiveTab] = useState<SubTab>('overview');

  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        {SUB_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              fontSize: 13,
              fontWeight: activeTab === t.key ? 600 : 400,
              background: activeTab === t.key ? 'var(--accent)' : 'transparent',
              color: activeTab === t.key ? '#fff' : 'var(--text-secondary)',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && <DwellOverview />}
      {activeTab === 'facilities' && <FacilityUtilization />}
      {activeTab === 'sla' && <SLAAlerts />}
      {activeTab === 'drivers' && <DriverPerformance />}
      {activeTab === 'congestion' && <CongestionMap />}
      {activeTab === 'trips' && <TripInspector />}
      {activeTab === 'live' && <LiveOperations />}
    </div>
  );
}
