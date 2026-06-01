// Failed jobs cards. Each card shows the error and offers Ask-for-status,
// Retry and Dismiss actions. Diag drawer is shared with ActiveJobsTable.

import { ProvisionJob } from '../helpers';
import type { DiagState } from '../types';
import { DiagDrawer, getTimeSince } from './shared';

interface Props {
  jobs: ProvisionJob[];
  diagState: DiagState;
  onAskForStatus: (region: string) => void;
  onRetry: (job: ProvisionJob) => void;
  onDismiss: (jobId: string) => void;
  onCloseDiag: (region: string) => void;
}

export default function FailedJobsList({
  jobs,
  diagState,
  onAskForStatus,
  onRetry,
  onDismiss,
  onCloseDiag,
}: Props) {
  if (jobs.length === 0) return null;
  return (
    <>
      <h3>Failed Jobs</h3>
      {jobs.map((job) => (
        <div
          key={job.job_id}
          className="error-banner"
          style={{ margin: '8px 0' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div>
              <strong>{job.display_name || job.region}</strong>
              <span className="badge error" style={{ marginLeft: 8 }}>{job.status}</span>
              {job.completed_at && <span style={{ fontSize: 11, color: 'var(--text-secondary)', marginLeft: 8 }}>{getTimeSince(job.completed_at)}</span>}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn small" onClick={() => onAskForStatus(job.region)}>
                {diagState[job.region]?.loading ? 'Asking...' : 'Ask for status'}
              </button>
              <button className="btn small primary" onClick={() => onRetry(job)}>Retry</button>
              <button className="btn small" onClick={() => onDismiss(job.job_id)}>Dismiss</button>
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--red)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {job.error_msg || job.message || 'Unknown error'}
          </div>
          {job.profiles && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Profiles: {job.profiles}</div>
          )}
          {diagState[job.region]?.expanded && (
            <div style={{ marginTop: 8 }}>
              <DiagDrawer entry={diagState[job.region]} onClose={() => onCloseDiag(job.region)} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}
