'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAppStore } from '@/lib/store';

export type Operation = 'create' | 'update' | 'delete' | 'restore';
type Status = 'idle' | 'loading' | 'done' | 'undoing' | 'undone' | 'committed' | 'conflict' | 'error';

interface UndoToken {
  entity: string;
  operation: Operation;
  record_id: string;
  fields?: Record<string, unknown>;
  expected_version: number;
}

interface WriteResponse {
  success: boolean;
  record_id?: string;
  version?: number;
  undo?: UndoToken;
  reason?: 'conflict' | 'error';
  current?: Record<string, unknown>;
  error?: string;
}

interface ConfirmActionProps {
  // Write intent - passed from the agent's propose_write tool result
  entity?: string;
  operation?: Operation;
  record_id?: string;
  fields?: Record<string, unknown>;
  expected_version?: number;

  // Display
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;

  // Legacy callbacks (kept for backwards compat; new code uses entity/operation/fields)
  onConfirm?: () => void;
  onCancel?: () => void;
}

const UNDO_WINDOW_MS = 10_000;

function deriveTitle(entity?: string, operation?: string, record_id?: string): string {
  if (!entity || !operation) return 'Confirm action';
  const opLabel: Record<string, string> = { create: 'Create', update: 'Update', delete: 'Delete', restore: 'Restore' };
  const label = opLabel[operation] ?? operation;
  const id = record_id ? ` (${record_id.slice(0, 8)}…)` : '';
  return `${label} ${entity}${id}`;
}

export function ConfirmAction({
  entity,
  operation,
  record_id,
  fields,
  expected_version,
  title: titleProp,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmActionProps) {
  // Derive a title from entity+operation when not explicitly provided
  const title = titleProp ?? deriveTitle(entity, operation, record_id);
  const bumpViewsVersion = useAppStore((s) => s.bumpViewsVersion);
  const [status, setStatus] = useState<Status>('idle');
  const [undoToken, setUndoToken] = useState<UndoToken | null>(null);
  const [undoSecondsLeft, setUndoSecondsLeft] = useState(0);
  const [conflictCurrent, setConflictCurrent] = useState<Record<string, unknown> | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  // Countdown timer for undo window
  useEffect(() => {
    if (status !== 'done' || !undoToken) return;
    setUndoSecondsLeft(Math.ceil(UNDO_WINDOW_MS / 1000));
    const interval = setInterval(() => {
      setUndoSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval);
          setStatus('committed'); // window expired, write is committed, undo no longer available
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [status, undoToken]);

  const executeWrite = useCallback(async (req: {
    entity: string;
    operation: Operation;
    record_id?: string;
    fields?: Record<string, unknown>;
    expected_version?: number;
  }): Promise<WriteResponse> => {
    const res = await fetch('/api/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return res.json() as Promise<WriteResponse>;
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!entity || !operation) {
      onConfirm?.();
      return;
    }
    // fields may be a JSON string in some edge cases; normalize to object
    const resolvedFields = typeof fields === 'string'
      ? (() => { try { return JSON.parse(fields as string); } catch { return {}; } })()
      : fields;

    setStatus('loading');
    try {
      const result = await executeWrite({ entity, operation, record_id, fields: resolvedFields, expected_version });
      if (result.success && result.undo) {
        bumpViewsVersion();
        setUndoToken(result.undo);
        setStatus('done');
      } else if (!result.success && result.reason === 'conflict') {
        setConflictCurrent(result.current ?? null);
        setStatus('conflict');
      } else {
        setErrorMsg(result.error ?? 'Write failed');
        setStatus('error');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Network error');
      setStatus('error');
    }
  }, [entity, operation, record_id, fields, expected_version, onConfirm, executeWrite]);

  const handleUndo = useCallback(async () => {
    if (!undoToken) return;
    setStatus('undoing');
    try {
      const result = await executeWrite({
        entity: undoToken.entity,
        operation: undoToken.operation,
        record_id: undoToken.record_id,
        fields: undoToken.fields,
        expected_version: undoToken.expected_version,
      });
      if (result.success) {
        bumpViewsVersion();
        setStatus('undone');
        setUndoToken(null);
      } else if (!result.success && result.reason === 'conflict') {
        setConflictCurrent(result.current ?? null);
        setStatus('conflict');
      } else {
        setErrorMsg(result.error ?? 'Undo failed');
        setStatus('error');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Network error');
      setStatus('error');
    }
  }, [undoToken, executeWrite]);

  const containerStyle: React.CSSProperties = {
    padding: '16px',
    borderRadius: '12px',
    border: '1px solid var(--border-default, #e5e7eb)',
    backgroundColor: 'var(--surface-primary, #fff)',
    fontSize: '13px',
  };

  // ── Done state: show "✓ Saved" + Undo button immediately ──────────────────
  if (status === 'done' && undoToken) {
    return (
      <div style={{ ...containerStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <span style={{ color: 'var(--text-success, #16a34a)', fontWeight: 500 }}>
          ✓ Saved
        </span>
        <button
          onClick={handleUndo}
          style={{
            padding: '4px 12px',
            borderRadius: '6px',
            border: '1px solid var(--border-default, #e5e7eb)',
            backgroundColor: 'var(--surface-primary, #fff)',
            color: 'var(--text-primary, #111827)',
            fontSize: '12px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Undo ({undoSecondsLeft}s)
        </button>
      </div>
    );
  }

  // ── Undoing state ──────────────────────────────────────────────────────────
  if (status === 'undoing') {
    return (
      <div style={{ ...containerStyle, color: 'var(--text-secondary, #6b7280)' }}>
        <Spinner /> Undoing...
      </div>
    );
  }

  // ── Committed state (undo window expired, write is final) ─────────────────
  if (status === 'committed') {
    return (
      <div style={{ ...containerStyle, color: 'var(--text-success, #16a34a)', fontWeight: 500 }}>
        ✓ Saved
      </div>
    );
  }

  // ── Undone state (user clicked Undo and it succeeded) ──────────────────────
  if (status === 'undone') {
    return (
      <div style={{ ...containerStyle, color: 'var(--text-secondary, #6b7280)' }}>
        ↩ Undone
      </div>
    );
  }

  // ── Conflict state ─────────────────────────────────────────────────────────
  if (status === 'conflict') {
    return (
      <div style={{ ...containerStyle, borderColor: 'var(--border-warning, #fcd34d)', backgroundColor: 'var(--surface-warning, #fffbeb)' }}>
        <div style={{ fontWeight: 600, color: 'var(--text-warning, #b45309)', marginBottom: '4px' }}>
          ⚠ Could not complete - record was modified by someone else
        </div>
        {conflictCurrent && (
          <div style={{ color: 'var(--text-secondary, #6b7280)', marginTop: '4px' }}>
            {Object.entries(conflictCurrent)
              .filter(([k]) => !['tenant_id', 'version', 'created_at', 'updated_at', 'created_by', 'custom_fields'].includes(k))
              .slice(0, 3)
              .map(([k, v]) => (
                <span key={k} style={{ marginRight: '12px' }}>
                  {k}: <strong>{String(v ?? '-')}</strong>
                </span>
              ))}
          </div>
        )}
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div style={{ ...containerStyle, borderColor: 'var(--border-error, #fecaca)', backgroundColor: 'var(--surface-error, #fef2f2)' }}>
        <span style={{ color: 'var(--text-error, #dc2626)' }}>✗ {errorMsg}</span>
      </div>
    );
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <div style={{ ...containerStyle, color: 'var(--text-secondary, #6b7280)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Spinner /> {confirmLabel}ing...
      </div>
    );
  }

  // ── Idle state (default) ───────────────────────────────────────────────────
  return (
    <div style={containerStyle}>
      <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '4px', color: 'var(--text-primary, #111827)' }}>
        {title}
      </div>
      {description && (
        <div style={{ color: 'var(--text-secondary, #6b7280)', marginBottom: '12px' }}>
          {description}
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          data-testid="confirm-action-confirm"
          onClick={handleConfirm}
          style={{
            padding: '6px 16px',
            borderRadius: '8px',
            border: 'none',
            backgroundColor: 'var(--surface-accent-bold, #2563eb)',
            color: '#fff',
            fontSize: '13px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {confirmLabel}
        </button>
        <button
          data-testid="confirm-action-cancel"
          onClick={onCancel}
          style={{
            padding: '6px 16px',
            borderRadius: '8px',
            border: '1px solid var(--border-default, #e5e7eb)',
            backgroundColor: 'var(--surface-primary, #fff)',
            color: 'var(--text-primary, #111827)',
            fontSize: '13px',
            cursor: 'pointer',
          }}
        >
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: '12px',
        height: '12px',
        border: '2px solid var(--border-default, #e5e7eb)',
        borderTopColor: 'var(--text-accent, #2563eb)',
        borderRadius: '50%',
        animation: 'spin 0.6s linear infinite',
      }}
    />
  );
}
