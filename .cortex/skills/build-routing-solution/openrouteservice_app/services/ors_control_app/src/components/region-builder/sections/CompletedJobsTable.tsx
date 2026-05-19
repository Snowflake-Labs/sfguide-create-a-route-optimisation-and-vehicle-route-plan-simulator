// Recently completed (non-error) jobs table.

import { ProvisionJob } from '../helpers';
import { getTimeSince } from './shared';

interface Props {
  jobs: ProvisionJob[];
  onDismiss: (jobId: string) => void;
}

export default function CompletedJobsTable({ jobs, onDismiss }: Props) {
  if (jobs.length === 0) return null;
  return (
    <>
      <h3>Recent Jobs</h3>
      <table className="services-table">
        <thead>
          <tr><th>Region</th><th>Status</th><th>Message</th><th>Time</th><th></th></tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.job_id}>
              <td>{job.display_name || job.region}</td>
              <td>
                <span className="badge ok">{job.status}</span>
              </td>
              <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {job.message}
              </td>
              <td>{job.completed_at ? getTimeSince(job.completed_at) : job.created_at ? getTimeSince(job.created_at) : ''}</td>
              <td><button className="btn small" onClick={() => onDismiss(job.job_id)}>Dismiss</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
