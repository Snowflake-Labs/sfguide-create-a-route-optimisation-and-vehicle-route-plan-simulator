'use client';

interface Row {
  DECIDED_AT?: string;
  TRAILER_ID?: string;
  OFFER_ID?: string;
  SOURCE?: string;
  EMPTY_KM?: number | string;
  USD_RECLAIMED?: number | string;
}

interface Props {
  rows: Row[];
  onRefresh: () => void;
}

export default function DecisionsAudit({ rows, onRefresh }: Props) {
  return (
    <div style={{ marginTop: 16, padding: 12, border: '1px solid var(--border-default, #e5e7eb)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Decisions Audit (last 25)</h3>
        <button onClick={onRefresh} style={{ fontSize: 11, padding: '2px 8px', border: '1px solid var(--border-default, #e5e7eb)', borderRadius: 4, background: 'transparent', cursor: 'pointer' }}>Refresh</button>
        <span style={{ fontSize: 11, color: 'var(--text-secondary, #6b7280)' }}>
          Total reclaimed: ${rows.reduce((s, r) => s + Number(r.USD_RECLAIMED || 0), 0).toLocaleString()}
        </span>
      </div>
      {!rows.length && <div style={{ fontSize: 12, color: 'var(--text-secondary, #6b7280)' }}>No decisions yet. Solve + Confirm Plan to populate.</div>}
      {rows.length > 0 && (
        <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-default, #e5e7eb)' }}>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>Decided</th>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>Trailer</th>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>Offer</th>
              <th style={{ textAlign: 'left', padding: '4px 6px' }}>Source</th>
              <th style={{ textAlign: 'right', padding: '4px 6px' }}>Empty km</th>
              <th style={{ textAlign: 'right', padding: '4px 6px' }}>USD reclaimed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderBottom: '1px solid rgba(0,0,0,0.04)' }}>
                <td style={{ padding: '3px 6px' }}>{r.DECIDED_AT}</td>
                <td style={{ padding: '3px 6px' }}>{r.TRAILER_ID}</td>
                <td style={{ padding: '3px 6px' }}>{r.OFFER_ID}</td>
                <td style={{ padding: '3px 6px' }}>{r.SOURCE}</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.EMPTY_KM}</td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>{r.USD_RECLAIMED}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
