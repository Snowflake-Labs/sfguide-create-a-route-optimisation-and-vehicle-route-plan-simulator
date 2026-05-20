// Provisioned regions table. Per-profile rows with PhasePips badges and the
// OverflowMenu (Drop region / Repair).

import { Fragment } from 'react';
import OverflowMenu from '../../../shared/OverflowMenu';
import { GraphInfo, RegionStatus } from '../helpers';

interface Props {
  regions: RegionStatus[];
  loading: boolean;
  onDrop: (region: string) => void;
}

export default function ProvisionedRegionsTable({ regions, loading, onDrop }: Props) {
  return (
    <>
      <h3>Provisioned Regions</h3>
      {loading ? (
        <div className="loading-text">Loading...</div>
      ) : regions.length === 0 ? (
        <div className="empty-state">
          <strong>No regions provisioned yet.</strong>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
            Search the catalog below and pick a region to deploy. ORS service, routing graphs, and stage data
            will be created automatically.
          </div>
        </div>
      ) : (
        <table className="services-table">
          <thead>
            <tr>
              <th>Region</th>
              <th>Service</th>
              <th>Profile</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((c) => {
              const gr = c.graphReadiness;
              const readyCount = gr?.graphs?.filter((g) => g.ready).length ?? 0;
              const totalCount = gr?.graphs?.length ?? 0;
              const isReady = gr?.service_ready && readyCount === totalCount && totalCount > 0;
              const isServiceUp = c.serviceStatus === 'RUNNING' || c.serviceStatus === 'READY';
              const profileRows: GraphInfo[] = (gr?.graphs && gr.graphs.length > 0)
                ? gr.graphs
                : [{ profile: '(no profiles)', ready: false }];
              const aggregateBadge = (() => {
                if (!isServiceUp) {
                  return <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Service paused</span>;
                }
                if (gr?.error) return <span className="badge error">Failed</span>;
                if (!gr) return <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Checking...</span>;
                if (totalCount === 0) return <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>—</span>;
                if (isReady) return <span className="badge ok">{readyCount}/{totalCount} ready</span>;
                return <span className="badge warn">Building {readyCount}/{totalCount}</span>;
              })();
              const overflowActions = c.isDefault
                ? [
                    { label: 'Repair (coming soon)', disabled: true, title: 'Per-region repair not yet implemented' },
                  ]
                : [
                    { label: 'Repair (coming soon)', disabled: true, title: 'Per-region repair not yet implemented' },
                    { label: 'Drop region', danger: true, confirmText: 'Confirm drop?', onClick: () => onDrop(c.region) },
                  ];
              return (
                <Fragment key={c.region}>
                  {profileRows.map((g, idx) => {
                    const isFirst = idx === 0;
                    const phases = g.phases;
                    const profileBadge = (() => {
                      if (g.profile === '(no profiles)') {
                        return <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>—</span>;
                      }
                      if (!isServiceUp) {
                        return <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>—</span>;
                      }
                      if (g.ready) return <span className="badge ok">Ready</span>;
                      if (gr?.error) return <span className="badge error">Failed</span>;
                      if (phases) {
                        const done = (phases.osm === 'done' ? 1 : 0) + (phases.lm === 'done' ? 1 : 0) + (phases.ch === 'done' ? 1 : 0);
                        return <span className="badge warn">Building {done}/3</span>;
                      }
                      return <span className="badge warn">Pending</span>;
                    })();
                    return (
                      <tr key={`${c.region}-${g.profile}`} className={idx > 0 ? 'profile-sub-row' : ''}>
                        {isFirst && (
                          <td rowSpan={profileRows.length}>
                            <strong>{c.display_name || c.region}</strong>
                            {c.isDefault && (
                              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Built-in</div>
                            )}
                          </td>
                        )}
                        {isFirst && (
                          <td rowSpan={profileRows.length}>
                            <span className={`badge ${isServiceUp ? 'ok' : 'warn'}`}>{c.serviceStatus}</span>
                            <div style={{ marginTop: 4 }}>{aggregateBadge}</div>
                            {!isServiceUp && (
                              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, maxWidth: 220 }}>
                                Service {c.serviceStatus.toLowerCase()}. Resume from Service Manager or recreate via Repair.
                              </div>
                            )}
                            {gr?.error && isServiceUp && (
                              <div style={{ fontSize: 11, color: '#e53935', marginTop: 4, maxWidth: 220 }} title={gr.error}>
                                {gr.error.length > 80 ? gr.error.slice(0, 80) + '...' : gr.error}
                              </div>
                            )}
                          </td>
                        )}
                        <td style={{ fontSize: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span>{g.profile}</span>
                            {profileBadge}
                            {g.build_date && (
                              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{g.build_date}</span>
                            )}
                          </div>
                        </td>
                        {isFirst && (
                          <td rowSpan={profileRows.length}>
                            {c.isDefault ? (
                              <span className="badge ok">Built-in</span>
                            ) : (
                              <OverflowMenu actions={overflowActions} />
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
