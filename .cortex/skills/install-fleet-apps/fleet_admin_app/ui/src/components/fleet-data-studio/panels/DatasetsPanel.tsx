'use client';
import { useCallback, useEffect, useState } from 'react';

interface DatasetRow {
  datasetId: string;
  region: string;
  vehicleType: string;
  label: string | null;
  isActive: boolean;
  createdAt: string;
  rowCounts: Record<string, number> | null;
  notes: string | null;
}

const fmt = (n?: number | null) =>
  n == null ? '—' : Number(n).toLocaleString();

const cellStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid #E1E4E8',
  fontSize: 13,
  verticalAlign: 'top',
};
const headStyle: React.CSSProperties = {
  ...cellStyle,
  fontWeight: 600,
  fontSize: 12,
  color: '#57606A',
  background: '#F7F8FA',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};
const btnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  borderRadius: 4,
  border: '1px solid #D0D7DE',
  background: '#fff',
  cursor: 'pointer',
  marginRight: 6,
};
const dangerBtn: React.CSSProperties = {
  ...btnStyle,
  borderColor: '#D32F2F',
  color: '#D32F2F',
};
const activateBtn: React.CSSProperties = {
  ...btnStyle,
  borderColor: '#1A73E8',
  color: '#1A73E8',
};
const badgeStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 12,
  fontSize: 11,
  fontWeight: 600,
  background: active ? '#E6F9ED' : '#F5F5F5',
  color: active ? '#1B7A3D' : '#6E7681',
});

export default function DatasetsPanel() {
  const [rows, setRows] = useState<DatasetRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/studio/datasets');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const activate = async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch(`/api/studio/datasets/${encodeURIComponent(id)}/activate`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await refresh();
    } catch (e: any) {
      alert(`Activate failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const rename = async (id: string, currentLabel: string | null) => {
    const next = window.prompt('New label for this dataset:', currentLabel || '');
    if (next == null) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/studio/datasets/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await refresh();
    } catch (e: any) {
      alert(`Rename failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string, region: string, vt: string) => {
    if (!confirm(`Permanently delete dataset for ${region} / ${vt}?\n\nThis purges all rows in DIM_POIS / DIM_FLEET / FACT_FREIGHT_OFFERS / DIM_PARTNERS / FACT_PARTNER_HISTORY / FACT_TRIPS / FACT_VEHICLE_TELEMETRY where JOB_ID = ${id}.\n\nThis cannot be undone.`)) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/studio/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      await refresh();
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>Datasets</h3>
          <div style={{ fontSize: 12, color: '#57606A', marginTop: 2 }}>
            Each Studio run produces an immutable dataset keyed by JOB_ID.
            One dataset per (Region, Vehicle) is active at a time;
            downstream demos see only the active one.
            Old datasets stay queryable until you delete them.
          </div>
        </div>
        <button style={btnStyle} onClick={refresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {error && (
        <div style={{ color: '#D32F2F', fontSize: 12, marginBottom: 8 }}>
          Error loading datasets: {error}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headStyle}>Region</th>
              <th style={headStyle}>Vehicle</th>
              <th style={headStyle}>Label</th>
              <th style={headStyle}>Created</th>
              <th style={headStyle}>Active</th>
              <th style={{ ...headStyle, textAlign: 'right' }}>POIs</th>
              <th style={{ ...headStyle, textAlign: 'right' }}>Fleet</th>
              <th style={{ ...headStyle, textAlign: 'right' }}>Offers</th>
              <th style={{ ...headStyle, textAlign: 'right' }}>Trips</th>
              <th style={{ ...headStyle, textAlign: 'right' }}>Telemetry</th>
              <th style={headStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={11} style={{ ...cellStyle, color: '#6E7681', fontStyle: 'italic' }}>
                  No datasets yet. Generate one in the Studio above.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const c = r.rowCounts || {};
              return (
                <tr key={r.datasetId} style={{ background: r.isActive ? '#FAFCFE' : 'transparent' }}>
                  <td style={cellStyle}>{r.region}</td>
                  <td style={cellStyle}>{r.vehicleType}</td>
                  <td style={cellStyle}>
                    <div>{r.label || <span style={{ color: '#6E7681' }}>—</span>}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#6E7681', marginTop: 2 }}>
                      {r.datasetId}
                    </div>
                  </td>
                  <td style={cellStyle}>
                    {(() => {
                      try { return new Date(r.createdAt).toLocaleString(); }
                      catch { return r.createdAt; }
                    })()}
                  </td>
                  <td style={cellStyle}>
                    <span style={badgeStyle(r.isActive)}>
                      {r.isActive ? 'ACTIVE' : 'archived'}
                    </span>
                  </td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}>{fmt(c.pois)}</td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}>{fmt(c.fleet)}</td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}>{fmt(c.offers)}</td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}>{fmt(c.trips)}</td>
                  <td style={{ ...cellStyle, textAlign: 'right' }}>{fmt(c.telemetry)}</td>
                  <td style={cellStyle}>
                    {!r.isActive && (
                      <button
                        style={activateBtn}
                        disabled={busy === r.datasetId}
                        onClick={() => activate(r.datasetId)}
                      >
                        Activate
                      </button>
                    )}
                    <button
                      style={btnStyle}
                      disabled={busy === r.datasetId}
                      onClick={() => rename(r.datasetId, r.label)}
                    >
                      Rename
                    </button>
                    <button
                      style={dangerBtn}
                      disabled={busy === r.datasetId}
                      onClick={() => remove(r.datasetId, r.region, r.vehicleType)}
                    >
                      Delete
                    </button>
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
