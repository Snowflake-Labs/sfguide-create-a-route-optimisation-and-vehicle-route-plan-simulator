'use client';

interface ChoiceListProps {
  title: string;
  options: Array<{ label: string; description?: string; value: string }>;
  onSelect?: (value: string) => void;
}

export function ChoiceList({ title, options }: ChoiceListProps) {
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {options.slice(0, 5).map((opt) => (
          <button
            key={opt.value}
            style={{
              display: 'flex',
              flexDirection: 'column',
              padding: '10px 12px',
              borderRadius: '8px',
              border: '1px solid var(--border-default, #e5e7eb)',
              backgroundColor: 'var(--surface-primary, #fff)',
              cursor: 'pointer',
              textAlign: 'left',
              width: '100%',
            }}
          >
            <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-primary, #111827)' }}>
              {opt.label}
            </span>
            {opt.description && (
              <span style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)', marginTop: '2px' }}>
                {opt.description}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
