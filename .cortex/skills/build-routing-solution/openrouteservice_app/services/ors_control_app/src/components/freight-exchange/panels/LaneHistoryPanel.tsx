// Lane history block (Phase B). Receives the row already loaded by the
// orchestrator's useLaneHistory hook.

import type { LaneRow } from '../types';

export default function LaneHistoryPanel({ row }: { row: LaneRow | null }) {
  return (
    <div>
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
        Lane history with this partner
      </div>
      {!row ? (
        <div style={{ color: '#6b7280' }}>No prior shipments on this lane / equipment combo.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <div><b>Shipments:</b> {row.SHIPMENTS}</div>
          <div><b>On-time:</b> {row.SHIPMENTS > 0 ? `${Math.round(100 * row.ON_TIME / row.SHIPMENTS)}%` : '—'}</div>
          <div><b>Late:</b> {row.LATE_CNT}</div>
          <div><b>Damaged:</b> {row.DAMAGED_CNT}</div>
          <div><b>Avg USD/km:</b> {row.AVG_EUR_PER_KM != null ? `$${row.AVG_EUR_PER_KM.toFixed(2)}` : '—'}</div>
          <div><b>Equipment:</b> {row.EQUIPMENT}</div>
        </div>
      )}
    </div>
  );
}
