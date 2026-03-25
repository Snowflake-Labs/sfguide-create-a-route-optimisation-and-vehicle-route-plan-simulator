import { useState } from 'react';
import DeviationDashboard from './route-deviation/DeviationDashboard';
import RouteComparison from './route-deviation/RouteComparison';
import RouteInspector from './route-deviation/RouteInspector';

type SubTab = 'dashboard' | 'comparison' | 'inspector';

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'comparison', label: 'Route Comparison' },
  { key: 'inspector', label: 'Route Inspector' },
];

export default function RouteDeviation() {
  const [activeTab, setActiveTab] = useState<SubTab>('dashboard');

  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        {SUB_TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: activeTab === t.key ? 600 : 400, background: activeTab === t.key ? 'var(--accent)' : 'transparent', color: activeTab === t.key ? '#fff' : 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.15s' }}>{t.label}</button>
        ))}
      </div>
      {activeTab === 'dashboard' && <DeviationDashboard />}
      {activeTab === 'comparison' && <RouteComparison />}
      {activeTab === 'inspector' && <RouteInspector />}
    </div>
  );
}
