// Provision New Region form: source tab + searchable catalog list + region
// detail card + profile picker + compute size selector + PBF source toggle
// + Deploy button. State (selection, profiles, size, force redownload,
// search) lives in the parent so build-history "Rerun" can mutate it.

import { useEffect, useMemo } from 'react';
import type { CatalogRegion } from '../../../types';
import {
  ALL_PROFILES, COMPUTE_SIZES, ComputeSize, DEFAULT_PROFILES, SourceTab,
  estTime, recommendComputeSize, sizeClass, sizeLabel,
} from '../helpers';

interface Props {
  catalog: CatalogRegion[];
  catalogLoading: boolean;
  refreshing: boolean;
  onRefreshCatalog: () => void;

  sourceTab: SourceTab;
  onSourceTabChange: (tab: SourceTab) => void;
  search: string;
  onSearchChange: (v: string) => void;

  selectedRegion: CatalogRegion | null;
  onSelectRegion: (r: CatalogRegion | null) => void;

  selectedProfiles: string[];
  onToggleProfile: (id: string) => void;

  computeSize: ComputeSize;
  onComputeSizeChange: (s: ComputeSize) => void;

  forcePbfRedownload: boolean;
  onForcePbfRedownloadChange: (v: boolean) => void;

  largestFamily: string;
  isRegionProvisioning: (regionKey: string) => boolean;
  onDeploy: () => void;
}

export default function ProvisionForm(props: Props) {
  const {
    catalog, catalogLoading, refreshing, onRefreshCatalog,
    sourceTab, onSourceTabChange, search, onSearchChange,
    selectedRegion, onSelectRegion,
    selectedProfiles, onToggleProfile,
    computeSize, onComputeSizeChange,
    forcePbfRedownload, onForcePbfRedownloadChange,
    largestFamily, isRegionProvisioning, onDeploy,
  } = props;

  const profileGroups = useMemo(() =>
    ALL_PROFILES.reduce<Record<string, typeof ALL_PROFILES>>((acc, p) => {
      (acc[p.group] = acc[p.group] || []).push(p);
      return acc;
    }, {}), []);

  const filteredCatalog = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = catalog.filter((r) => {
      if (r.source !== sourceTab) return false;
      if (words.length === 0) return true;
      const haystack = [r.regionName, r.continent || '', r.country || ''].join(' ').toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
    const seen = new Set<string>();
    return filtered.filter((r) => {
      const key = `${r.regionKey}:${r.country || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [catalog, sourceTab, search]);

  useEffect(() => {
    if (selectedRegion && !filteredCatalog.some((r) => r.catalogId === selectedRegion.catalogId)) {
      onSelectRegion(null);
    }
  }, [filteredCatalog, selectedRegion, onSelectRegion]);

  const canProvisionSelected = selectedRegion && !isRegionProvisioning(selectedRegion.regionKey);

  return (
    <>
      <h3>Provision New Region</h3>
      <div className="provision-form">
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--border)' }}>
            <button
              className={`btn small${sourceTab === 'bbbike' ? ' primary' : ''}`}
              onClick={() => { onSourceTabChange('bbbike'); onSelectRegion(null); }}
              style={{ borderRadius: 0 }}
            >
              BBBike Cities
            </button>
            <button
              className={`btn small${sourceTab === 'geofabrik' ? ' primary' : ''}`}
              onClick={() => { onSourceTabChange('geofabrik'); onSelectRegion(null); }}
              style={{ borderRadius: 0 }}
            >
              Geofabrik Regions
            </button>
          </div>
          <input
            type="text"
            placeholder="Search regions..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="select"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="btn small" onClick={onRefreshCatalog} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh Catalog'}
          </button>
        </div>

        {(catalogLoading || refreshing) && catalog.length === 0 ? (
          <div className="empty-state" style={{ textAlign: 'center', padding: '2rem 1rem' }}>
            <div className="loading-text" style={{ marginBottom: '0.5rem' }}>Loading region catalog...</div>
            <p style={{ color: '#888', fontSize: '13px', margin: 0 }}>
              First load may take 2-3 minutes while we fetch available regions from Geofabrik and BBBike.
            </p>
          </div>
        ) : catalogLoading ? (
          <div className="loading-text">Loading catalog...</div>
        ) : catalog.length === 0 ? (
          <div className="empty-state">
            Catalog is empty. Click &quot;Refresh Catalog&quot; to load available regions from Geofabrik and BBBike.
          </div>
        ) : (
          <div style={{ maxHeight: '320px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '6px' }}>
            <table className="services-table" style={{ margin: 0 }}>
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Location</th>
                  <th>Level</th>
                  <th>Size</th>
                  <th>Est. Time</th>
                </tr>
              </thead>
              <tbody>
                {filteredCatalog.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: 'center', padding: '1rem', color: '#888' }}>No regions match your search</td></tr>
                ) : filteredCatalog.map((r) => {
                  const isSelected = selectedRegion?.catalogId === r.catalogId;
                  return (
                    <tr
                      key={r.catalogId}
                      onClick={() => { onSelectRegion(r); }}
                      style={{ cursor: 'pointer', background: isSelected ? 'rgba(59,130,246,0.25)' : undefined, outline: isSelected ? '2px solid rgba(59,130,246,0.6)' : undefined }}
                    >
                      <td><strong>{r.regionName}</strong></td>
                      <td>{r.source === 'bbbike' ? 'City' : [r.continent, r.country].filter(Boolean).join(' / ') || '—'}</td>
                      <td><span className="badge">{r.level}</span></td>
                      <td><span className={sizeClass(r.pbfSizeMb)}>{sizeLabel(r.pbfSizeMb)}</span></td>
                      <td>{estTime(r.pbfSizeMb)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {selectedRegion && (
          <>
            <div className="city-info" style={{ marginTop: '0.75rem' }}>
              <div className="info-row">
                <span className="info-label">Region Key:</span>
                <span>{selectedRegion.regionKey}</span>
              </div>
              <div className="info-row">
                <span className="info-label">PBF Source:</span>
                <span className="info-url">{selectedRegion.pbfUrl}</span>
              </div>
              {selectedRegion.bbox && (
                <div className="info-row">
                  <span className="info-label">Bounding Box:</span>
                  <span>
                    {selectedRegion.bbox.minLat.toFixed(2)} &mdash; {selectedRegion.bbox.maxLat.toFixed(2)}N,{' '}
                    {selectedRegion.bbox.minLon.toFixed(2)} &mdash; {selectedRegion.bbox.maxLon.toFixed(2)}E
                  </span>
                </div>
              )}
            </div>

            {(selectedRegion.pbfSizeMb ?? 0) > 500 && (
              <div className="warning-banner" style={{ marginTop: '0.5rem' }}>
                Large region warning: PBF is {sizeLabel(selectedRegion.pbfSizeMb)}. Graph building will take {estTime(selectedRegion.pbfSizeMb)} and require significant memory.
              </div>
            )}

            <div className="profile-selector">
              <label className="info-label">Routing Profiles:</label>
              <p className="subtitle" style={{ margin: '4px 0 8px' }}>
                More profiles = longer graph build time and higher memory usage
              </p>
              {Object.entries(profileGroups).map(([group, profiles]) => (
                <div key={group} className="profile-group">
                  <span className="profile-group-label">{group}</span>
                  <div className="profile-checkboxes">
                    {profiles.map((p) => (
                      <label key={p.id} className="profile-checkbox">
                        <input
                          type="checkbox"
                          checked={selectedProfiles.includes(p.id)}
                          onChange={() => onToggleProfile(p.id)}
                        />
                        <span>{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>
                {selectedProfiles.length} profile{selectedProfiles.length !== 1 ? 's' : ''} selected
              </div>
            </div>

            <div className="profile-selector" style={{ marginTop: '0.5rem' }}>
              <label className="info-label">Compute Size:</label>
              <p className="subtitle" style={{ margin: '4px 0 8px' }}>
                Auto-selected based on region level. Larger regions need more memory for graph building.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {COMPUTE_SIZES.map((s) => {
                  const isRecommended = s.id === recommendComputeSize(selectedRegion?.level);
                  return (
                    <button
                      key={s.id}
                      className={`btn small${computeSize === s.id ? ' primary' : ''}`}
                      onClick={() => onComputeSizeChange(s.id)}
                      style={{ flex: 1, textAlign: 'center' }}
                      title={s.desc}
                    >
                      <div>
                        <strong>{s.label}</strong>
                        {isRecommended && <span style={{ fontSize: '10px', marginLeft: 6, padding: '1px 6px', borderRadius: 4, background: 'rgba(38, 132, 255, 0.18)', color: '#2684ff' }}>Recommended</span>}
                      </div>
                      <div style={{ fontSize: '11px', opacity: 0.8 }}>{s.vcpu} vCPU / {s.mem}</div>
                      <div style={{ fontSize: '11px', opacity: 0.7 }}>{s.instance} / {s.heap} heap</div>
                    </button>
                  );
                })}
              </div>
              {computeSize === 'XXL' && (
                <p style={{ fontSize: '11px', opacity: 0.7, margin: '0.5rem 0 0' }}>
                  Resolved compute pool: <strong>{largestFamily}</strong>. Graph build runs on the largest high-memory family available in this cloud / region. The runtime service is auto-downsized to a smaller tier after the first successful build (no manual action required).
                </p>
              )}
              {computeSize === 'L' && (
                <p style={{ fontSize: '11px', opacity: 0.7, margin: '0.5rem 0 0' }}>
                  Resolved compute pool: <strong>HIGHMEM_X64_L</strong>. Graph build runs on a 124 vCPU / 984 GB high-memory node. The runtime service is auto-downsized to a smaller tier after the first successful build (no manual action required).
                </p>
              )}
            </div>

            {isRegionProvisioning(selectedRegion.regionKey) && (
              <div className="warning-banner">This region is already being provisioned.</div>
            )}

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>PBF source</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="pbf-source"
                    checked={!forcePbfRedownload}
                    onChange={() => onForcePbfRedownloadChange(false)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <strong>Use cached file if available</strong>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      Reuse the .osm.pbf already on the SPCS stage. Multi-GB redeploys complete in seconds.
                    </div>
                  </span>
                </label>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="pbf-source"
                    checked={forcePbfRedownload}
                    onChange={() => onForcePbfRedownloadChange(true)}
                    style={{ marginTop: 2 }}
                  />
                  <span>
                    <strong>Force re-download from URL</strong>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      Pull a fresh copy from Geofabrik / BBBike. Use after a weekly refresh or if cached file is corrupt.
                    </div>
                  </span>
                </label>
              </div>
            </div>
          </>
        )}

        <button
          className="btn primary"
          onClick={onDeploy}
          disabled={!canProvisionSelected || selectedProfiles.length === 0}
        >
          {`Deploy ORS for ${selectedRegion?.regionName || '...'}`}
        </button>
      </div>
    </>
  );
}

export { DEFAULT_PROFILES };
