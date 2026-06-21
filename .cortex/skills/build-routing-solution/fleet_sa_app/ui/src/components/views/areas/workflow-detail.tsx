'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import { useAppStore } from '@/lib/store';

interface WorkflowDetailAreaProps {
  database: string;
  schema: string;
}

interface StepConfig {
  name: string;
  type?: string;
  description?: string;
}

interface WorkflowRow {
  instance_id: string;
  workflow_type: string;
  status: string;
  current_step_index: number;
  gate_context: string | null;   // JSON: summary data at HITL gate
  started_by: string;
  created_at: string | null;
  updated_at: string | null;
  step_outputs: string | null;   // JSON: outputs from completed steps
  definition: string | null;    // JSON: {steps: [...], gates: [...]}
}

const STATUS_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  paused_at_gate: { bg: '#fef3c7', text: '#92400e', icon: '⏸' },
  running:        { bg: '#dbeafe', text: '#1e40af', icon: '▶' },
  completed:      { bg: '#d1fae5', text: '#065f46', icon: '✓' },
  failed:         { bg: '#fee2e2', text: '#991b1b', icon: '✕' },
  cancelled:      { bg: '#f3f4f6', text: '#6b7280', icon: '✕' },
};

function parseJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function fmt(val: string | null): string {
  if (!val) return '—';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return val;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return val; }
}

function StepStepper({ steps, currentIndex, status }: { steps: StepConfig[]; currentIndex: number; status: string }) {
  const isTerminal = status === 'completed';
  const isFailed   = status === 'failed';
  const isPaused   = status === 'paused_at_gate';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0', marginBottom: '24px', flexWrap: 'wrap', rowGap: '8px' }}>
      {steps.map((step, i) => {
        const isDone   = isTerminal ? true : i < currentIndex;
        const isActive = !isTerminal && i === currentIndex;
        const isBad    = isFailed && i === currentIndex;
        const circleColor = isBad ? '#dc2626' : isDone ? '#065f46' : isActive && isPaused ? '#fef3c7' : isActive ? '#1d4ed8' : '#e5e7eb';
        const textColor   = isDone || isBad ? '#fff' : isActive && isPaused ? '#92400e' : isActive ? '#fff' : '#9ca3af';
        const labelColor  = isActive && isPaused ? '#92400e' : isActive ? 'var(--text-primary, #111827)' : isDone ? '#065f46' : isBad ? '#dc2626' : 'var(--text-secondary, #9ca3af)';
        const border      = isActive && isPaused ? '2px solid #fbbf24' : isActive ? '2px solid #3b82f6' : '2px solid transparent';
        return (
          <div key={step.name} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
              <div style={{
                width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700,
                backgroundColor: circleColor,
                color: textColor,
                border,
                flexShrink: 0,
              }}>
                {isBad ? '✕' : isDone ? '✓' : i + 1}
              </div>
              <span style={{ fontSize: '10px', textAlign: 'center', maxWidth: '80px', lineHeight: '1.2', color: labelColor, fontWeight: isActive ? 700 : 400 }}>
                {step.name.replace(/_/g, ' ')}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div style={{ width: '32px', height: '2px', backgroundColor: (isTerminal || i < currentIndex) ? '#065f46' : '#e5e7eb', marginTop: '-16px', flexShrink: 0 }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function KVBlock({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== null && typeof v !== 'object');
  const nested = Object.entries(data).filter(([, v]) => v !== null && typeof v === 'object');
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', fontSize: '13px' }}>
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <span style={{ color: 'var(--text-secondary, #6b7280)', whiteSpace: 'nowrap', textTransform: 'capitalize' }}>
            {k.replace(/_/g, ' ')}
          </span>
          <span style={{ color: 'var(--text-primary, #111827)', fontWeight: 500 }}>
            {typeof v === 'number' ? v.toLocaleString() : String(v)}
          </span>
        </Fragment>
      ))}
      {nested.map(([k, v]) => (
        <Fragment key={k}>
          <span style={{ color: 'var(--text-secondary, #6b7280)', whiteSpace: 'nowrap', textTransform: 'capitalize', alignSelf: 'start', paddingTop: '2px' }}>
            {k.replace(/_/g, ' ')}
          </span>
          <div style={{ color: 'var(--text-primary, #111827)' }}>
            {Object.entries(v as Record<string, unknown>).map(([ik, iv]) => (
              <div key={ik} style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>
                {ik.replace(/_/g, ' ')}: <span style={{ color: 'var(--text-primary, #111827)', fontWeight: 500 }}>
                  {typeof iv === 'object' ? JSON.stringify(iv) : typeof iv === 'number' ? iv.toLocaleString() : String(iv)}
                </span>
              </div>
            ))}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export function WorkflowDetailArea({ database, schema }: WorkflowDetailAreaProps) {
  const selectedInstanceId = useAppStore((s) => s.panel.viewState.selectedInstanceId as string | undefined);
  const showView = useAppStore((s) => s.showView);

  const [row, setRow] = useState<WorkflowRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fqn = `${database}.${schema}`;

  const fetchInstance = useCallback(async () => {
    if (!selectedInstanceId) return;
    setLoading(true); setError(null);
    try {
      const sql = `SELECT wi.instance_id, wi.workflow_type, wi.status, wi.current_step_index, wi.gate_context::VARCHAR AS gate_context, wi.started_by, wi.created_at, wi.updated_at, wi.step_outputs::VARCHAR AS step_outputs, wd.definition::VARCHAR AS definition FROM ${fqn}.WORKFLOW_INSTANCES wi LEFT JOIN ${fqn}.WORKFLOW_DEFINITIONS wd ON wd.workflow_type = wi.workflow_type WHERE wi.instance_id = :instance_id`;
      const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params: { instance_id: selectedInstanceId } }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      setRow((result.rows?.[0] ?? null) as WorkflowRow | null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load instance');
    } finally {
      setLoading(false);
    }
  }, [fqn, selectedInstanceId]);

  useEffect(() => { fetchInstance(); }, [fetchInstance]);

  const handleAction = async (action: 'approve' | 'reject') => {
    if (!row) return;
    setActionLoading(true); setActionStatus(null);
    try {
      const safeAction = action === 'approve' ? 'approved' : 'rejected';
      // Call the TypeScript workflow service — it executes remaining steps after the gate.
      const res = await fetch('/api/workflow/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: row.instance_id, decision: safeAction }),
      });
      const result = await res.json() as { status?: string; error?: string };
      if (!res.ok || result.error) throw new Error(result.error ?? `HTTP ${res.status}`);
      setActionStatus(action === 'approve' ? 'Approved — workflow resuming.' : 'Rejected — workflow cancelled.');
      await fetchInstance();
    } catch (e) {
      setActionStatus(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (!selectedInstanceId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-secondary, #9ca3af)', gap: '12px' }}>
        <span style={{ fontSize: '32px' }}>⬡</span>
        <span style={{ fontSize: '14px' }}>No workflow selected.</span>
        <button onClick={() => showView('workflow_manager')} style={{ fontSize: '13px', padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'var(--surface-primary, #fff)', cursor: 'pointer', color: 'var(--text-primary, #374151)' }}>
          ← Back to Workflow Manager
        </button>
      </div>
    );
  }

  if (loading) return <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-secondary, #9ca3af)', fontSize: '13px' }}>Loading…</div>;
  if (error) return <div style={{ padding: '24px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>;
  if (!row) return <div style={{ padding: '24px', color: 'var(--text-secondary, #9ca3af)', fontSize: '13px' }}>Instance not found.</div>;

  const stepOutputs = parseJson(row.step_outputs);
  const definition = parseJson(row.definition);
  const steps: StepConfig[] = Array.isArray(definition?.steps) ? definition.steps as StepConfig[] : [];
  const colors = STATUS_COLORS[row.status] ?? { bg: '#f3f4f6', text: '#374151', icon: '○' };
  const isPaused = row.status === 'paused_at_gate';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-default, #e5e7eb)', display: 'flex', alignItems: 'center', gap: '12px', backgroundColor: 'var(--surface-primary, #fff)' }}>
        <button onClick={() => showView('workflow_manager')} style={{ fontSize: '13px', padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--border-default, #e5e7eb)', backgroundColor: 'transparent', cursor: 'pointer', color: 'var(--text-secondary, #6b7280)' }}>
          ← Back
        </button>
        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary, #111827)', flex: 1 }}>
          {row.workflow_type.replace(/_/g, ' ')}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 10px', borderRadius: '9999px', fontSize: '12px', fontWeight: 600, textTransform: 'uppercase', backgroundColor: colors.bg, color: colors.text }}>
          {colors.icon} {row.status}
        </span>
      </div>

      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {steps.length > 0 && <StepStepper steps={steps} currentIndex={row.current_step_index} status={row.status} />}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 32px', fontSize: '13px', padding: '16px', backgroundColor: 'var(--surface-secondary, #f9fafb)', borderRadius: '8px' }}>
          {[
            ['Instance', row.instance_id],
            ['Workflow', row.workflow_type.replace(/_/g, ' ')],
            ['Current Step', row.current_step_index],
            ['Started By', row.started_by],
            ['Started', fmt(row.created_at)],
            ['Updated', fmt(row.updated_at)],
          ].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary, #9ca3af)' }}>{k}</span>
              <span style={{ color: 'var(--text-primary, #111827)', fontFamily: k === 'Instance' ? 'monospace' : undefined, fontSize: k === 'Instance' ? '11px' : '13px' }}>{v}</span>
            </div>
          ))}
        </div>

        {stepOutputs && (
          <div>
            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary, #9ca3af)', marginBottom: '10px' }}>
              Step Outputs
            </div>
            <pre style={{
              padding: '12px 14px',
              backgroundColor: 'var(--surface-secondary, #f9fafb)',
              borderRadius: '8px',
              border: '1px solid var(--border-default, #e5e7eb)',
              fontSize: '11px',
              lineHeight: '1.6',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
              color: 'var(--text-primary, #111827)',
              fontFamily: 'ui-monospace, monospace',
            }}>
              {JSON.stringify(stepOutputs, null, 2)}
            </pre>
          </div>
        )}

        {isPaused && (
          <div style={{ padding: '14px 16px', backgroundColor: '#fef3c7', borderRadius: '8px', border: '1px solid #fde68a' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#92400e', marginBottom: '6px' }}>
              ⏸ Awaiting Approval
            </div>
            {row.gate_context && (
              <div style={{ marginTop: '8px' }}><KVBlock data={parseJson(row.gate_context) ?? {}} /></div>
            )}
          </div>
        )}

        {actionStatus && (
          <div style={{ padding: '12px 16px', backgroundColor: actionStatus.startsWith('Error') ? '#fee2e2' : '#d1fae5', borderRadius: '8px', fontSize: '13px', color: actionStatus.startsWith('Error') ? '#991b1b' : '#065f46' }}>
            {actionStatus}
          </div>
        )}

        {isPaused && (
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => handleAction('approve')}
              disabled={actionLoading}
              style={{ flex: 1, padding: '10px', borderRadius: '8px', border: 'none', backgroundColor: '#16a34a', color: '#fff', fontWeight: 600, fontSize: '14px', cursor: actionLoading ? 'not-allowed' : 'pointer', opacity: actionLoading ? 0.7 : 1 }}
            >
              {actionLoading ? '…' : '✓ Approve'}
            </button>
            <button
              onClick={() => handleAction('reject')}
              disabled={actionLoading}
              style={{ flex: 1, padding: '10px', borderRadius: '8px', border: '2px solid #e5e7eb', backgroundColor: '#fff', color: '#374151', fontWeight: 600, fontSize: '14px', cursor: actionLoading ? 'not-allowed' : 'pointer', opacity: actionLoading ? 0.7 : 1 }}
            >
              {actionLoading ? '…' : '✕ Reject'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
