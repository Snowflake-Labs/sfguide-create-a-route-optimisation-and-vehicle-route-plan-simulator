// Recent build attempts table (sourced from ORS_BUILD_HISTORY across regions).
// "Rerun" pre-fills the provision form with the build's parameters.

import type { CatalogRegion } from '../../../types';
import type { BuildHistoryRow } from '../types';

interface Props {
  history: BuildHistoryRow[];
  catalog: CatalogRegion[];
  onRerun: (row: BuildHistoryRow) => void;
}

export default function BuildHistoryTable({ history, catalog, onRerun }: Props) {
  if (history.length === 0) return null;
  return (
    <div style={{ marginTop: '1rem' }}>
      <h3 style={{ fontSize: '14px', margin: '0 0 0.5rem' }}>Recent builds</h3>
      <p style={{ fontSize: '11px', opacity: 0.7, margin: '0 0 0.5rem' }}>
        Last {history.length} build attempts across all regions. Sourced from ORS_BUILD_HISTORY.
      </p>
      <table className="services-table" style={{ fontSize: '12px' }}>
        <thead>
          <tr>
            <th>Region</th>
            <th>Started</th>
            <th>Family / size</th>
            <th>Profiles</th>
            <th>Elapsed</th>
            <th>Status</th>
            <th>Peak RSS</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {history.map((b) => {
            const minutes = b.ELAPSED_MINUTES != null ? Math.round(b.ELAPSED_MINUTES * 10) / 10 : null;
            const elapsed = minutes == null
              ? '\u2014'
              : minutes >= 60
                ? `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`
                : `${minutes}m`;
            const statusBadge = b.EXIT_STATUS === 'SUCCESS'
              ? 'ok'
              : b.EXIT_STATUS === 'IN_PROGRESS'
                ? 'warn'
                : 'error';
            const canRerun = !!b.REGION && catalog.some((r) => r.regionKey.toUpperCase() === b.REGION!.toUpperCase());
            return (
              <tr key={b.BUILD_ID || `${b.REGION}-${b.STARTED_AT}`}>
                <td>{b.REGION || '\u2014'}</td>
                <td>{b.STARTED_AT ? new Date(b.STARTED_AT).toLocaleString() : '\u2014'}</td>
                <td>{b.INSTANCE_FAMILY || '\u2014'}{b.COMPUTE_SIZE ? ` / ${b.COMPUTE_SIZE}` : ''}</td>
                <td title={b.PROFILES || ''} style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.PROFILES || '\u2014'}</td>
                <td>{elapsed}</td>
                <td><span className={`badge ${statusBadge}`}>{b.EXIT_STATUS || 'UNKNOWN'}</span></td>
                <td>{b.PEAK_RSS_GIB != null ? `${Math.round(b.PEAK_RSS_GIB)} GB` : '\u2014'}</td>
                <td>
                  <button
                    className="btn small"
                    onClick={() => onRerun(b)}
                    disabled={!canRerun}
                    title={canRerun ? 'Pre-fill the Provision form with this build\u2019s region, profiles and size' : 'Region not found in current catalog'}
                  >
                    Rerun
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
