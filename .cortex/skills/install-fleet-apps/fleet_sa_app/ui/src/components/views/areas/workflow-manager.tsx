'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/lib/store';

interface WorkflowInstance {
  instance_id: string;
  workflow_type: string;
  status: string;
  current_step_index: number;
  started_by: string;
  created_at: string | null;
  updated_at: string | null;
}

interface WorkflowManagerAreaProps {
  database: string;
  schema: string;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  paused_at_gate: { bg: '#fef3c7', text: '#92400e' },
  running:        { bg: '#dbeafe', text: '#1e40af' },
  completed:      { bg: '#d1fae5', text: '#065f46' },
  failed:         { bg: '#fee2e2', text: '#991b1b' },
  cancelled:      { bg: '#f3f4f6', text: '#6b7280' },
  pending:   { bg: '#ede9fe', text: '#5b21b6' },
};

function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] ?? { bg: '#f3f4f6', text: '#374151' };
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: '9999px',
      fontSize: '11px',
      fontWeight: 600,
      letterSpacing: '0.03em',
      textTransform: 'uppercase',
      backgroundColor: colors.bg,
      color: colors.text,
    }}>
      {status}
    </span>
  );
}

function fmt(val: string | null): string {
  if (!val) return '-';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return val;
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return val; }
}

export function WorkflowManagerArea({ database, schema }: WorkflowManagerAreaProps) {
  const showView = useAppStore((s) => s.showView);
  const viewsVersion = useAppStore((s) => s.viewsVersion);

  const [rows, setRows] = useState<WorkflowInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [sortKey, setSortKey] = useState<keyof WorkflowInstance>('updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const fqn = `${database}.${schema}`;

  const fetchInstances = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sql = `SELECT instance_id, workflow_type, status, current_step_index, started_by, created_at, updated_at FROM ${fqn}.WORKFLOW_INSTANCES WHERE (status = :status OR :status IS NULL) ORDER BY updated_at DESC NULLS LAST`;
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params: { status: statusFilter || null } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      setRows((result.rows ?? []) as WorkflowInstance[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workflows');
    } finally {
      setLoading(false);
    }
  }, [fqn, statusFilter]);

  useEffect(() => { fetchInstances(); }, [fetchInstances, viewsVersion]);

  const handleSort = (key: keyof WorkflowInstance) => {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const sorted = [...rows].sort((a, b) => {
    const va = a[sortKey] ?? '';
    const vb = b[sortKey] ?? '';
    const cmp = String(va).localeCompare(String(vb));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const handleRowClick = (row: WorkflowInstance) => {
    showView('workflow_detail', { selectedInstanceId: row.instance_id });
  };

  const COLS: { key: keyof WorkflowInstance; label: string }[] = [
    { key: 'instance_id', label: 'Instance' },
    { key: 'workflow_type', label: 'Workflow' },
    { key: 'status', label: 'Status' },
    { key: 'current_step_index', label: 'Step' },
    { key: 'started_by', label: 'Started By' },
    { key: 'updated_at', label: 'Updated' },
  ];

  const thStyle = (key: string): React.CSSProperties => ({
    padding: '10px 12px',
    textAlign: 'left',
    fontWeight: 600,
    fontSize: '12px',
    backgroundColor: 'var(--surface-secondary, #f9fafb)',
    borderBottom: '2px solid var(--border-default, #e5e7eb)',
    color: 'var(--text-secondary, #6b7280)',
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    position: 'sticky',
    top: 0,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-default, #e5e7eb)', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'var(--surface-primary, #fff)' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)', flex: 1 }}>
          Workflow Instances
        </span>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', color: 'var(--text-primary, #111827)', cursor: 'pointer' }}
        >
          <option value="">All statuses</option>
          {['running', 'paused_at_gate', 'completed', 'failed', 'cancelled'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button
          onClick={fetchInstances}
          style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', cursor: 'pointer', color: 'var(--text-secondary, #6b7280)' }}
        >
          ↻ Refresh
        </button>
      </div>

      {loading && (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>
          Loading...
        </div>
      )}
      {error && (
        <div style={{ padding: '16px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>
      )}
      {!loading && !error && (
        <div style={{ overflow: 'auto', flex: 1 }}>
          {sorted.length === 0 ? (
            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-secondary, #9ca3af)', fontSize: '13px' }}>
              No workflow instances found.{' '}
              <span style={{ color: 'var(--text-secondary, #6b7280)' }}>
                Ask the agent to run a workflow to create one.
              </span>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>
                  {COLS.map((col) => (
                    <th key={col.key} style={thStyle(col.key)} onClick={() => handleSort(col.key)}>
                      {col.label}
                      {sortKey === col.key && <span style={{ marginLeft: '4px', fontSize: '10px' }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
                  <tr
                    key={row.instance_id}
                    onClick={() => handleRowClick(row)}
                    style={{ borderBottom: '1px solid var(--border-default, #e5e7eb)', cursor: 'pointer' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = 'var(--surface-hover, #f9fafb)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.backgroundColor = ''; }}
                  >
                    <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-secondary, #6b7280)' }}>{row.instance_id}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-primary, #111827)' }}>{row.workflow_type}</td>
                    <td style={{ padding: '10px 12px' }}><StatusBadge status={row.status} /></td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary, #6b7280)', fontFamily: 'monospace', fontSize: '11px' }}>{row.current_step_index}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary, #6b7280)' }}>{row.started_by}</td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-secondary, #9ca3af)', fontSize: '12px' }}>{fmt(row.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
