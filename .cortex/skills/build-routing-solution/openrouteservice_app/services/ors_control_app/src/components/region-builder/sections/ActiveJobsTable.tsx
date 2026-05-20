// Active provisioning jobs table. Renders one block per job with profile
// rows, the Steps strip, the build progress bar and an "Ask for status"
// diagnostic drawer. Extracted verbatim from RegionBuilder.tsx.

import { Fragment } from 'react';
import PhasePips from '../../../shared/PhasePips';
import { ProvisionJob, RegionStatus } from '../helpers';
import { StepsStrip, StepsLegend } from '../Steps';
import type { BuildProgress, DiagState } from '../types';
import { DiagDrawer, getTimeSince } from './shared';

interface Props {
  jobs: ProvisionJob[];
  regions: RegionStatus[];
  buildProgress: Record<string, BuildProgress>;
  diagState: DiagState;
  onAskForStatus: (region: string) => void;
  onCancel: (region: string) => void;
  onCloseDiag: (region: string) => void;
}

export default function ActiveJobsTable({
  jobs,
  regions,
  buildProgress,
  diagState,
  onAskForStatus,
  onCancel,
  onCloseDiag,
}: Props) {
  if (jobs.length === 0) return null;
  return (
    <>
      <h3>Active Provisioning Jobs</h3>
      <StepsLegend />
      <table className="services-table">
        <thead>
          <tr>
            <th>Region</th>
            <th>Job status</th>
            <th>Profile</th>
            <th>Steps</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const bp = buildProgress[job.region];
            const stage = job.stage?.toLowerCase() || '';
            const buildPhase = bp?.phase;
            const showBuildBar = stage === 'building_graph' && buildPhase === 'building';
            const startupHint =
              (stage === 'building_graph' || stage === 'waiting_for_service') && buildPhase === 'initializing'
                ? 'ORS engine starting up...'
                : (stage === 'building_graph' || stage === 'waiting_for_service') && buildPhase === 'importing'
                ? `Importing OSM data for ${bp?.currentProfile || ''}...`
                : null;
            const profileList = job.profiles
              ? job.profiles.split(',').map((p) => p.trim()).filter(Boolean)
              : [];
            const profileRows = profileList.length > 0 ? profileList : ['(no profiles)'];
            const region = regions.find((r) => r.region.toUpperCase() === job.region.toUpperCase());
            const gr = region?.graphReadiness;
            const showPhaseTriplet = stage === 'building_graph';
            const elapsedHint = job.started_at ? getTimeSince(job.started_at) : undefined;
            return (
              <Fragment key={job.job_id}>
                {profileRows.map((profile, idx) => {
                  const isFirst = idx === 0;
                  const phases = gr?.graphs?.find((g) => g.profile === profile)?.phases;
                  return (
                    <tr
                      key={`${job.job_id}-${profile}`}
                      className={`active-job-row ${idx > 0 ? 'profile-sub-row' : ''}`}
                    >
                      {isFirst && (
                        <td rowSpan={profileRows.length}>
                          <strong>{job.display_name || job.region}</strong>
                        </td>
                      )}
                      {isFirst && (
                        <td rowSpan={profileRows.length}>
                          <span className="badge running">{job.status}</span>
                        </td>
                      )}
                      <td style={{ fontSize: 12 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span>{profile}</span>
                          {showPhaseTriplet && profile !== '(no profiles)' && (
                            <PhasePips phases={phases} ready={false} showLabel={false} />
                          )}
                        </div>
                      </td>
                      {isFirst && (
                        <td rowSpan={profileRows.length}>
                          <StepsStrip currentStage={job.stage} elapsedHint={elapsedHint} />
                        </td>
                      )}
                      {isFirst && (
                        <td rowSpan={profileRows.length}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <button className="btn small" onClick={() => onAskForStatus(job.region)}>
                              {diagState[job.region]?.loading ? 'Asking...' : 'Ask for status'}
                            </button>
                            <button className="btn danger small" onClick={() => onCancel(job.region)}>
                              Cancel
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
                <tr key={`${job.job_id}-details`} className="details-row">
                  <td colSpan={5}>
                    <div className="details-grid">
                      {job.started_at && (
                        <span>
                          <span className="details-label">Started</span>
                          {getTimeSince(job.started_at)}
                        </span>
                      )}
                      {job.message && (
                        <span>
                          <span className="details-label">Current step</span>
                          {job.message}
                        </span>
                      )}
                      {showBuildBar && (
                        <div className="build-progress" style={{ minWidth: 220, flex: '1 1 240px' }}>
                          <div className="progress-bar-track">
                            <div className="progress-bar-fill" style={{ width: `${bp.progress}%` }} />
                          </div>
                          <div className="progress-stats">
                            <span>{bp.progress}%</span>
                            {bp.currentProfile && bp.totalProfiles && (
                              <span>
                                Profile {(bp.completedProfiles?.length ?? 0) + 1}/{bp.totalProfiles}: {bp.currentProfile}
                              </span>
                            )}
                            {(bp.nodesRemaining ?? 0) > 0 && (
                              <span>{((bp.nodesRemaining ?? 0) / 1000).toFixed(0)}K nodes left</span>
                            )}
                          </div>
                        </div>
                      )}
                      {!showBuildBar && startupHint && (
                        <span>
                          <span className="details-label">Status</span>
                          {startupHint}
                        </span>
                      )}
                      {!job.started_at && !job.message && !showBuildBar && !startupHint && (
                        <span style={{ opacity: 0.7 }}>Waiting for first status update...</span>
                      )}
                    </div>
                  </td>
                </tr>
                {diagState[job.region]?.expanded && (
                  <tr key={`${job.job_id}-diag`} className="active-job-row">
                    <td colSpan={5}>
                      <DiagDrawer entry={diagState[job.region]} onClose={() => onCloseDiag(job.region)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
