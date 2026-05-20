// Job history table + click-through job-detail drawer modal.

import { Square, Trash2 } from 'lucide-react';

interface Props {
  jobHistory: any[];
  cancellingJob: string | null;
  deletingJob: string | null;
  onOpenDetail: (jobId: string, status: string) => void;
  onCancelJobById: (jobId: string) => void;
  onDeleteJobData: (jobId: string) => void;
}

export default function JobHistoryTable({
  jobHistory, cancellingJob, deletingJob,
  onOpenDetail, onCancelJobById, onDeleteJobData,
}: Props) {
  if (jobHistory.length === 0) return null;
  return (
    <div className="chart-card" style={{ marginTop: 16, padding: 16 }}>
      <h3 style={{ fontSize: 14, marginBottom: 12 }}>Job History</h3>
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th className="data-table-th">Preset</th>
              <th className="data-table-th">Region</th>
              <th className="data-table-th">Profile</th>
              <th className="data-table-th">Vehicles</th>
              <th className="data-table-th">Status</th>
              <th className="data-table-th">Points</th>
              <th className="data-table-th">Trips</th>
              <th className="data-table-th">Duration</th>
              <th className="data-table-th">Started</th>
              <th className="data-table-th">Details</th>
              <th className="data-table-th"></th>
            </tr>
          </thead>
          <tbody>
            {jobHistory.map((j: any, i: number) => {
              const status = j.STATUS || '';
              const statusColor = status === 'COMPLETED' ? '#1B7A3D' : status === 'FAILED' ? '#D32F2F' : status === 'STOPPED' ? '#E65100' : status === 'CANCELLED' ? '#6E7681' : status === 'RUNNING' ? '#1A73E8' : '#6E7681';
              const statusBg = status === 'COMPLETED' ? '#E6F9ED' : status === 'FAILED' ? '#FFEBEE' : status === 'STOPPED' ? '#FFF3E0' : status === 'CANCELLED' ? '#F5F5F5' : status === 'RUNNING' ? '#E6F0FF' : '#F5F5F5';
              const dur = j.DURATION_SEC;
              const durStr = dur != null ? (dur >= 3600 ? `${Math.floor(dur / 3600)}h ${Math.floor((dur % 3600) / 60)}m` : dur >= 60 ? `${Math.floor(dur / 60)}m ${dur % 60}s` : `${dur}s`) : '-';
              const started = j.STARTED_AT ? new Date(j.STARTED_AT).toLocaleString() : '-';
              return (
                <tr
                  key={j.JOB_ID || i}
                  onClick={() => j.JOB_ID && onOpenDetail(j.JOB_ID, status)}
                  style={{ cursor: j.JOB_ID ? 'pointer' : 'default' }}
                  title={j.JOB_ID ? 'Click to view logs and progress' : undefined}
                >
                  <td style={{ fontWeight: 500, fontSize: 12 }}>{j.PRESET_NAME || '-'}</td>
                  <td style={{ fontSize: 12 }}>{j.REGION || '-'}</td>
                  <td style={{ fontSize: 12 }}>{j.ORS_PROFILE || '-'}</td>
                  <td style={{ fontSize: 12, textAlign: 'right' }}>{j.NUM_VEHICLES ?? '-'}</td>
                  <td>
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: statusBg, color: statusColor, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {status}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, textAlign: 'right', fontWeight: 500 }}>{j.POINTS_GENERATED?.toLocaleString() || '0'}</td>
                  <td style={{ fontSize: 12, textAlign: 'right' }}>{j.TRIPS_GENERATED?.toLocaleString() || '0'}</td>
                  <td style={{ fontSize: 12, textAlign: 'right', color: '#6E7681' }}>{durStr}</td>
                  <td style={{ fontSize: 11, color: '#6E7681', whiteSpace: 'nowrap' }}>{started}</td>
                  <td style={{ fontSize: 11, maxWidth: 200 }}>
                    {j.ERROR_MESSAGE ? (
                      <span title={j.ERROR_MESSAGE} style={{ color: '#D32F2F', cursor: 'help', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
                        {j.ERROR_MESSAGE}
                      </span>
                    ) : (
                      <span style={{ color: '#9CA3AF' }}>-</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                    {status === 'RUNNING' ? (
                      <button
                        onClick={() => onCancelJobById(j.JOB_ID)}
                        disabled={cancellingJob === j.JOB_ID}
                        title="Cancel this running job"
                        style={{ background: 'none', border: '1px solid #D32F2F', color: '#D32F2F', cursor: cancellingJob === j.JOB_ID ? 'wait' : 'pointer', padding: '2px 8px', borderRadius: 4, fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, opacity: cancellingJob === j.JOB_ID ? 0.5 : 1 }}
                      >
                        <Square size={11} /> {cancellingJob === j.JOB_ID ? 'Cancelling...' : 'Cancel'}
                      </button>
                    ) : status !== 'DELETED' && (
                      <button
                        onClick={() => onDeleteJobData(j.JOB_ID)}
                        disabled={deletingJob === j.JOB_ID}
                        title="Delete generated data for this job"
                        style={{ background: 'none', border: 'none', cursor: deletingJob === j.JOB_ID ? 'wait' : 'pointer', padding: 4, borderRadius: 4, opacity: deletingJob === j.JOB_ID ? 0.4 : 0.6 }}
                      >
                        <Trash2 size={14} color="#D32F2F" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
