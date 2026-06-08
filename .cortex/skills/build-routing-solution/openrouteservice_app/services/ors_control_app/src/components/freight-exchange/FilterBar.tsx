// Filter bar — vendor source chips, equipment chips, ADR / status / trust /
// usd-per-km controls. Pure presentational; takes filter state
// + setters from the orchestrator and emits changes via a single setter.

import type { FilterState } from './types';
import { ALL_SOURCES_EU, ALL_SOURCES_NA, EQUIPMENTS } from './constants';

interface Props {
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  filteredCount: number;
  totalCount: number;
}

export default function FilterBar({ filters, setFilters, filteredCount, totalCount }: Props) {
  const sourceLabels = (() => {
    const set = new Set(Object.keys(filters.sourcesEnabled));
    if (set.size === 0) return [...ALL_SOURCES_EU, ...ALL_SOURCES_NA];
    const isEu = ALL_SOURCES_EU.some(s => set.has(s));
    return isEu ? ALL_SOURCES_EU : ALL_SOURCES_NA;
  })();

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: 8, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>Source:</span>
        {sourceLabels.map(s => {
          const enabled = filters.sourcesEnabled[s] !== false;
          return (
            <button
              key={s}
              onClick={() => setFilters(p => ({ ...p, sourcesEnabled: { ...p.sourcesEnabled, [s]: !enabled } }))}
              style={{
                fontSize: 11, padding: '3px 8px', borderRadius: 4,
                border: '1px solid ' + (enabled ? '#0369a1' : '#d1d5db'),
                background: enabled ? '#e0f2fe' : '#fff',
                color: enabled ? '#0369a1' : '#6b7280',
                cursor: 'pointer',
              }}
            >{s}</button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>Equipment:</span>
        {EQUIPMENTS.map(e => (
          <button
            key={e}
            onClick={() => setFilters(p => ({ ...p, equipEnabled: { ...p.equipEnabled, [e]: !p.equipEnabled[e] } }))}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 4,
              border: '1px solid ' + (filters.equipEnabled[e] ? '#16a34a' : '#d1d5db'),
              background: filters.equipEnabled[e] ? '#dcfce7' : '#fff',
              color: filters.equipEnabled[e] ? '#15803d' : '#6b7280',
              cursor: 'pointer',
            }}
          >{e}</button>
        ))}
      </div>
      <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
        ADR:
        <select value={filters.adrOnly} onChange={e => setFilters(p => ({ ...p, adrOnly: e.target.value as any }))} style={{ fontSize: 11, padding: '2px 6px' }}>
          <option value="any">any</option>
          <option value="adr">ADR only</option>
          <option value="no_adr">no ADR</option>
        </select>
      </label>
      <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
        Status:
        <select value={filters.statusFilter} onChange={e => setFilters(p => ({ ...p, statusFilter: e.target.value as any }))} style={{ fontSize: 11, padding: '2px 6px' }}>
          <option value="OPEN">OPEN only</option>
          <option value="ALL">ALL</option>
        </select>
      </label>
      <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
        Trust:
        <select value={filters.trustFilter} onChange={e => setFilters(p => ({ ...p, trustFilter: e.target.value as any }))} style={{ fontSize: 11, padding: '2px 6px' }}>
          <option value="ANY">ANY</option>
          <option value="GREEN_OR_YELLOW">No RED</option>
          <option value="GREEN">GREEN only</option>
        </select>
      </label>
      <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
        USD/km min:
        <input type="number" value={filters.usdPerKmMin} onChange={e => setFilters(p => ({ ...p, usdPerKmMin: e.target.value === '' ? '' : Number(e.target.value) }))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} step="0.1" />
      </label>
      <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
        max:
        <input type="number" value={filters.usdPerKmMax} onChange={e => setFilters(p => ({ ...p, usdPerKmMax: e.target.value === '' ? '' : Number(e.target.value) }))} style={{ width: 60, fontSize: 11, padding: '2px 4px' }} step="0.1" />
      </label>
      <span style={{ marginLeft: 'auto', fontSize: 11, color: '#374151', fontWeight: 600 }}>
        {filteredCount} / {totalCount} offers
      </span>
    </div>
  );
}
