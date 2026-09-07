'use client';
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

// ERROR_MSG holds an internal token, not prose. Rendering it raw put strings
// like `provisioner_killed_by_1h_task_timeout` in front of an operator, which
// reads as an unexplained internal bug and says nothing about what to do -
// while the one line that DID explain it (MESSAGE, e.g. an upstream 502) was
// shown only when ERROR_MSG happened to be empty. Map the token to a headline
// and always keep MESSAGE as supporting detail.
const ERROR_HEADLINES: Record<string, string> = {
  download_relaunched_origin:
    'The upstream PBF host is unreachable or returning errors. Data already '
    + 'downloaded is preserved, and the build resumes automatically once the '
    + 'host recovers.',
  download_relaunched:
    'Superseded by an automatic download resume. Already-downloaded data was '
    + 'kept; a newer job for this region is carrying the build.',
  provisioner_killed_by_1h_task_timeout:
    'The provisioning task hit its 1 hour timeout (since raised to 12 hours). '
    + 'The download resumes automatically from where it stopped.',
  graph_load_timeout:
    'The routing engine did not finish loading its graph in time. The build is '
    + 'retried automatically.',
  ors_status_unreachable:
    'The routing service did not become reachable. The build is retried '
    + 'automatically.',
};

function headlineFor(job: ProvisionJob): string | null {
  const token = (job.error_msg || '').trim();
  return token ? ERROR_HEADLINES[token] || token : null;
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
      {jobs.map((job) => {
        const headline = headlineFor(job);
        const detail = (job.message || '').trim();
        return (
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
            {headline || detail || 'Unknown error'}
          </div>
          {/* Detail is shown IN ADDITION to the headline, never instead of it:
              the underlying message is what an operator needs to distinguish an
              upstream outage from a genuine build failure. */}
          {headline && detail && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 4 }}>
              {detail}
            </div>
          )}
          {job.profiles && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>Profiles: {job.profiles}</div>
          )}
          {diagState[job.region]?.expanded && (
            <div style={{ marginTop: 8 }}>
              <DiagDrawer entry={diagState[job.region]} onClose={() => onCloseDiag(job.region)} />
            </div>
          )}
        </div>
        );
      })}
    </>
  );
}
