'use client';

interface ProgressCardProps {
  title: string;
  steps: Array<{ label: string; status: 'done' | 'active' | 'pending' }>;
}

export function ProgressCard({ title, steps }: ProgressCardProps) {
  return (
    <div
      style={{
        padding: '16px',
        borderRadius: '12px',
        border: '1px solid var(--border-default, #e5e7eb)',
        backgroundColor: 'var(--surface-primary, #fff)',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '12px', color: 'var(--text-primary, #111827)' }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {steps.map((step, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '11px',
                fontWeight: 600,
                flexShrink: 0,
                ...(step.status === 'done'
                  ? { backgroundColor: 'var(--surface-success, #ecfdf5)', color: 'var(--text-success, #059669)' }
                  : step.status === 'active'
                    ? { backgroundColor: 'var(--surface-accent, #e0edff)', color: 'var(--text-accent, #2563eb)' }
                    : { backgroundColor: 'var(--surface-secondary, #f3f4f6)', color: 'var(--text-tertiary, #9ca3af)' }),
              }}
            >
              {step.status === 'done' ? '✓' : step.status === 'active' ? '•' : i + 1}
            </div>
            <span
              style={{
                fontSize: '13px',
                color:
                  step.status === 'done'
                    ? 'var(--text-secondary, #6b7280)'
                    : step.status === 'active'
                      ? 'var(--text-primary, #111827)'
                      : 'var(--text-tertiary, #9ca3af)',
                fontWeight: step.status === 'active' ? 500 : 400,
                textDecoration: step.status === 'done' ? 'line-through' : 'none',
              }}
            >
              {step.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
