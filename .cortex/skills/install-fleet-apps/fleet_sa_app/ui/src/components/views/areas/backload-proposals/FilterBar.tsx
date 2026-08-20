// Filter + strategy control bar for the Backload Proposals cockpit. Two rows:
//   Row 1 - filters (country / source / feasible / hide-same / empty-km / decision)
//   Row 2 - perspective toggle (Vehicles / Loads / Ensemble) + strategy select +
//           Run (single strategy) OR Run ensemble + basis toggle, plus a count.
// Pure presentational; the orchestrator owns state.

import type { FilterState, Perspective, EnsembleBasis } from './types';

export interface StrategyOption { key: string; label: string; }

interface Props {
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  countries: string[];
  filteredCount: number;
  totalCount: number;
  maxEmptyKmDefault: number;
  perspective: Perspective;
  onPerspective: (p: Perspective) => void;
  strategies: StrategyOption[];
  strategy: string;
  onStrategyChange: (key: string) => void;
  onRun: () => void;
  onRunEnsemble: () => void;
  busy: boolean;
  runDisabled: boolean;
  ensembleBasis: EnsembleBasis;
  onEnsembleBasisChange: (b: EnsembleBasis) => void;
  ensembleCount: number;
  uniqueLoads: number;
}

const segBase: React.CSSProperties = { padding: '4px 10px', fontSize: 12, border: '1px solid var(--sf-border)', cursor: 'pointer', transition: 'background .15s' };
const segActive: React.CSSProperties = { ...segBase, background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' };
const segInactive: React.CSSProperties = { ...segBase, background: 'var(--surface)', color: 'var(--sf-text)' };

export default function FilterBar({
  filters, setFilters, countries, filteredCount, totalCount, maxEmptyKmDefault,
  perspective, onPerspective, strategies, strategy, onStrategyChange, onRun, onRunEnsemble,
  busy, runDisabled, ensembleBasis, onEnsembleBasisChange, ensembleCount, uniqueLoads,
}: Props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Row 1 - filters */}
      <div className="control-bar">
        {countries.length > 0 && (
          <div className="control-bar-group">
            <span className="control-bar-label">Country</span>
            <select className="sf-select" value={filters.country} onChange={(e) => setFilters((p) => ({ ...p, country: e.target.value }))}>
              <option value="">any</option>
              {countries.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        )}

        <div className="control-bar-group">
          <span className="control-bar-label">Source</span>
          <select className="sf-select" value={filters.source} onChange={(e) => setFilters((p) => ({ ...p, source: e.target.value as FilterState['source'] }))}>
            <option value="">any</option>
            <option value="internal">internal</option>
            <option value="external">external</option>
          </select>
        </div>

        <label className="control-bar-check">
          <input type="checkbox" checked={filters.feasibleOnly} onChange={(e) => setFilters((p) => ({ ...p, feasibleOnly: e.target.checked }))} />
          Feasible only
        </label>

        <label className="control-bar-check">
          <input type="checkbox" checked={filters.hideSameOriginDest} onChange={(e) => setFilters((p) => ({ ...p, hideSameOriginDest: e.target.checked }))} />
          Hide same origin/destination
        </label>

        <div className="control-bar-group">
          <span className="control-bar-label">Empty km {'\u2264'}</span>
          <input
            type="number" className="sf-input" style={{ width: 72 }} step={10}
            placeholder={String(maxEmptyKmDefault)}
            value={filters.maxEmptyKm}
            onChange={(e) => setFilters((p) => ({ ...p, maxEmptyKm: e.target.value === '' ? '' : Number(e.target.value) }))}
          />
        </div>

        <div className="control-bar-group">
          <span className="control-bar-label">Decision</span>
          <select className="sf-select" value={filters.decision} onChange={(e) => setFilters((p) => ({ ...p, decision: e.target.value as FilterState['decision'] }))}>
            <option value="ANY">any</option>
            <option value="UNDECIDED">undecided</option>
            <option value="ACCEPT">accepted</option>
            <option value="REJECT">rejected</option>
            <option value="FLAG">flagged</option>
          </select>
        </div>
      </div>

      {/* Row 2 - perspective + strategy + run + count */}
      <div className="control-bar">
        <div style={{ display: 'inline-flex', borderRadius: 4, overflow: 'hidden', marginRight: 8 }}>
          <button style={{ ...(perspective === 'vehicles' ? segActive : segInactive), borderRadius: '4px 0 0 4px' }} onClick={() => onPerspective('vehicles')} title="Group by vehicle">Vehicles</button>
          <button style={{ ...(perspective === 'loads' ? segActive : segInactive), borderLeft: 'none' }} onClick={() => onPerspective('loads')} title="Group by load">Loads</button>
          <button style={{ ...(perspective === 'ensemble' ? segActive : segInactive), borderRadius: '0 4px 4px 0', borderLeft: 'none' }} onClick={() => onPerspective('ensemble')} title="Run all strategies and grade them side-by-side">Ensemble</button>
        </div>

        {perspective === 'ensemble' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" disabled={busy || runDisabled} onClick={onRunEnsemble}>{busy ? 'Running\u2026' : 'Run ensemble'}</button>
            <div style={{ display: 'inline-flex', borderRadius: 4, overflow: 'hidden' }}>
              <button type="button" style={{ ...(ensembleBasis === 'great_circle' ? segActive : segInactive), borderRadius: '4px 0 0 4px' }} disabled={busy} onClick={() => onEnsembleBasisChange('great_circle')} title="Fast straight-line (great-circle) - quick scan only, no routing engine">Straight-line</button>
              <button type="button" style={{ ...(ensembleBasis === 'road' ? segActive : segInactive), borderRadius: '0 4px 4px 0', borderLeft: 'none' }} disabled={busy} onClick={() => onEnsembleBasisChange('road')} title="Road-accurate distances via the routing engine (ORS/VROOM) - slower">Road</button>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', maxWidth: 360 }}>
              {ensembleBasis === 'road' ? 'Runs Quick scan + Per-load VRP + Fleet 1:1 + Profit-max, then grades every vehicle-load pair.' : 'Runs the instant Quick scan only, then grades every vehicle-load pair.'}
            </span>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="control-bar-label">Strategy</span>
            <select className="sf-select" style={{ maxWidth: 260 }} value={strategy} disabled={busy} onChange={(e) => onStrategyChange(e.target.value)}>
              {strategies.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <button type="button" className="btn primary" disabled={busy || runDisabled} onClick={onRun}>{busy ? 'Running\u2026' : 'Run'}</button>
          </div>
        )}

        <span className="control-bar-count">
          {perspective === 'ensemble'
            ? `${ensembleCount} graded pairs`
            : perspective === 'loads'
              ? `${uniqueLoads} loads \u00B7 ${filteredCount} proposals`
              : `${filteredCount} / ${totalCount} proposals`}
        </span>
      </div>
    </div>
  );
}
