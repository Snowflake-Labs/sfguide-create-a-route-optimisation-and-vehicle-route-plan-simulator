import { Assignment, ROUTE_COLORS } from './helpers';

interface Props {
  assignments: Assignment[];
  unassigned: { id: number; reason?: string }[];
  selectedTrailer: string | null;
  onSelect: (id: string) => void;
  rationale: Record<string, string>;
  rationaleLoading: boolean;
  onAskRationale: (a: Assignment) => void;
}

export default function AssignmentList({ assignments, unassigned, selectedTrailer, onSelect, rationale, rationaleLoading, onAskRationale }: Props) {
  return (
    <div style={{ height: 560, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
      <h3 style={{ fontSize: 13, marginTop: 0 }}>Assignments ({assignments.length})</h3>
      {!assignments.length && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Click <b>Solve Backloads</b> to compute the optimal plan.</div>}
      {assignments.map((a, i) => {
        const c = ROUTE_COLORS[i % ROUTE_COLORS.length];
        const isSel = selectedTrailer === a.TRAILER_ID;
        return (
          <div key={a.TRAILER_ID} onClick={() => onSelect(a.TRAILER_ID)}
               style={{ padding: 8, borderRadius: 6, marginBottom: 6, cursor: 'pointer',
                        border: isSel ? '1px solid #0DB048' : '1px solid var(--border)',
                        background: isSel ? 'rgba(13,176,72,0.06)' : 'transparent' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${c.join(',')})`, flexShrink: 0 }} />
              <b style={{ fontSize: 12 }}>{a.TRAILER_ID}</b>
              <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: a.SOURCE === 'INTERNAL' ? 'rgba(41,181,232,0.18)' : 'rgba(200,200,200,0.4)' }}>
                {a.SOURCE}
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
              {a.PICKUP_CITY} -&gt; {a.PROPOSAL_DROPOFF_CITY}
            </div>
            <div style={{ fontSize: 11, marginTop: 2 }}>
              empty {Math.round(a.EMPTY_KM)} km - loaded {Math.round(a.LOADED_KM)} km - {a.PRODUCT}
            </div>
            {isSel && (
              <div style={{ marginTop: 6 }}>
                <button onClick={(e) => { e.stopPropagation(); onAskRationale(a); }} disabled={rationaleLoading}
                        style={{ fontSize: 11, padding: '3px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>
                  {rationaleLoading ? 'Asking Cortex...' : 'Why this assignment?'}
                </button>
                {rationale[a.TRAILER_ID] && (
                  <div style={{ marginTop: 6, padding: 6, fontSize: 11, background: 'rgba(0,0,0,0.04)', borderRadius: 4 }}>
                    {rationale[a.TRAILER_ID]}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {unassigned.length > 0 && (
        <div style={{ fontSize: 11, marginTop: 8, color: 'var(--text-secondary)' }}>
          {unassigned.length} jobs unassigned (capacity / time / skill mismatch).
        </div>
      )}
    </div>
  );
}
