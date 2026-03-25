import { useState } from 'react';
import FleetMap from './fleet-delivery/FleetMap';
import DataBuilder from './fleet-delivery/DataBuilder';
import FDMatrixBuilder from './fleet-delivery/FDMatrixBuilder';
import CatchmentPanel from './fleet-delivery/CatchmentPanel';

type SubTab = 'map' | 'data' | 'matrix' | 'catchment';

const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'map', label: 'Fleet Map' },
  { key: 'data', label: 'Data Builder' },
  { key: 'matrix', label: 'Matrix Builder' },
  { key: 'catchment', label: 'Catchment' },
];

export default function FleetDelivery() {
  const [activeTab, setActiveTab] = useState<SubTab>('map');

  return (
    <div className="panel">
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
        {SUB_TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={{ padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: activeTab === t.key ? 600 : 400, background: activeTab === t.key ? 'var(--accent)' : 'transparent', color: activeTab === t.key ? '#fff' : 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.15s' }}>{t.label}</button>
        ))}
      </div>
      {activeTab === 'map' && <FleetMap />}
      {activeTab === 'data' && <DataBuilder />}
      {activeTab === 'matrix' && <FDMatrixBuilder />}
      {activeTab === 'catchment' && <CatchmentPanel />}
    </div>
  );
}
