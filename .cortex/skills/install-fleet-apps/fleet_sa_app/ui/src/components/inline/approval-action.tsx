'use client';

import { useState } from 'react';
import { useAppStore } from '@/lib/store';

type ActionStatus = 'idle' | 'loading' | 'approved' | 'rejected' | 'error';

interface ApprovalActionProps {
  instance_id: string;
  prompt?: string;
  message?: string;
}

export function ApprovalAction({ instance_id, prompt, message }: ApprovalActionProps) {
  const [status, setStatus] = useState<ActionStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const bumpViewsVersion = useAppStore((s) => s.bumpViewsVersion);

  const handleAction = async (decision: 'approved' | 'rejected') => {
    setStatus('loading');
    try {
      // Call the workflow service via Next.js proxy — the TypeScript engine executes remaining steps.
      // Do NOT call RESUME_WORKFLOW directly via SQL; it bypasses the TypeScript engine steps.
      const res = await fetch('/api/workflow/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id, decision }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      bumpViewsVersion();
      setStatus(decision);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Action failed');
      setStatus('error');
    }
  };

  const containerStyle: React.CSSProperties = {
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid var(--border-default, #e5e7eb)',
    backgroundColor: 'var(--surface-secondary, #f9fafb)',
    fontSize: '13px',
    marginTop: '8px',
  };

  if (status === 'approved') {
    return (
      <div style={{ ...containerStyle, backgroundColor: '#d1fae5', borderColor: '#6ee7b7' }}>
        <span style={{ color: '#065f46', fontWeight: 600 }}>✓ Approved — workflow is resuming.</span>
      </div>
    );
  }
  if (status === 'rejected') {
    return (
      <div style={{ ...containerStyle, backgroundColor: '#fee2e2', borderColor: '#fca5a5' }}>
        <span style={{ color: '#991b1b', fontWeight: 600 }}>✗ Rejected — workflow cancelled.</span>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={{ fontWeight: 600, color: 'var(--text-primary, #111827)', marginBottom: '4px' }}>
        ⏸ Approval Required
      </div>
      <div style={{ color: 'var(--text-secondary, #6b7280)', marginBottom: '12px', lineHeight: '1.5' }}>
        {prompt ?? message ?? 'Review the workflow before proceeding.'}
      </div>
      {status === 'error' && (
        <div style={{ color: '#b91c1c', fontSize: '12px', marginBottom: '10px' }}>{errorMsg}</div>
      )}
      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          onClick={() => handleAction('approved')}
          disabled={status === 'loading'}
          style={{
            padding: '8px 20px', borderRadius: '6px', border: 'none',
            backgroundColor: '#16a34a', color: '#fff', fontWeight: 600,
            fontSize: '13px', cursor: status === 'loading' ? 'not-allowed' : 'pointer',
            opacity: status === 'loading' ? 0.7 : 1,
          }}
        >
          {status === 'loading' ? '…' : '✓ Approve'}
        </button>
        <button
          onClick={() => handleAction('rejected')}
          disabled={status === 'loading'}
          style={{
            padding: '8px 20px', borderRadius: '6px',
            border: '1px solid var(--border-default, #d1d5db)',
            backgroundColor: 'transparent', color: 'var(--text-primary, #111827)',
            fontWeight: 500, fontSize: '13px',
            cursor: status === 'loading' ? 'not-allowed' : 'pointer',
            opacity: status === 'loading' ? 0.7 : 1,
          }}
        >
          ✗ Reject
        </button>
      </div>
    </div>
  );
}
