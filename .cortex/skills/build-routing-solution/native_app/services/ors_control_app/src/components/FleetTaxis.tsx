import { useState, useEffect } from 'react';
import FleetOverview from './fleet-taxis/FleetOverview';
import DriverRoutes from './fleet-taxis/DriverRoutes';
import HeatMap from './fleet-taxis/HeatMap';

type SubTab = 'overview' | 'routes' | 'heatmap';

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'overview', label: 'Fleet Overview' },
  { key: 'routes', label: 'Driver Routes' },
  { key: 'heatmap', label: 'Heat Map' },
];

interface Props { subTab?: string; }

export default function FleetTaxis({ subTab }: Props) {
  const [activeTab, setActiveTab] = useState<SubTab>((subTab as SubTab) || 'overview');

  useEffect(() => {
    if (subTab && SUB_TABS.some(t => t.key === subTab)) {
      setActiveTab(subTab as SubTab);
    }
  }, [subTab]);

  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        {SUB_TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: activeTab === t.key ? 600 : 400, background: activeTab === t.key ? 'var(--accent)' : 'transparent', color: activeTab === t.key ? '#fff' : 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.15s' }}>{t.label}</button>
        ))}
      </div>
      {activeTab === 'overview' && <FleetOverview />}
      {activeTab === 'routes' && <DriverRoutes />}
      {activeTab === 'heatmap' && <HeatMap />}
    </div>
  );
}
