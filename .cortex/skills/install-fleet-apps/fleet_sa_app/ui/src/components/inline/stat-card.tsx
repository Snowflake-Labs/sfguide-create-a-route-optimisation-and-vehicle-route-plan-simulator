'use client';

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: string;
  trendDirection?: 'up' | 'down' | 'neutral';
  breakdown?: Array<{ label: string; value: string | number }>;
}

export function StatCard({ label, value, trend, trendDirection, breakdown }: StatCardProps) {
  return (
    <div
      style={{
        padding: '16px',
        borderRadius: '12px',
        border: '1px solid var(--border-default, #e5e7eb)',
        backgroundColor: 'var(--surface-primary, #fff)',
      }}
    >
      <div style={{ fontSize: '13px', color: 'var(--text-secondary, #6b7280)', marginBottom: '4px' }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary, #111827)' }}>
          {value}
        </span>
        {trend && (
          <span
            style={{
              fontSize: '13px',
              fontWeight: 500,
              color:
                trendDirection === 'up'
                  ? 'var(--text-success, #059669)'
                  : trendDirection === 'down'
                    ? 'var(--text-error, #dc2626)'
                    : 'var(--text-secondary, #6b7280)',
            }}
          >
            {trendDirection === 'up' ? '↑' : trendDirection === 'down' ? '↓' : '→'} {trend}
          </span>
        )}
      </div>
      {breakdown && breakdown.length > 0 && (
        <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {breakdown.slice(0, 6).map((item, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
              <span style={{ color: 'var(--text-secondary, #6b7280)' }}>{item.label}</span>
              <span style={{ fontWeight: 500, color: 'var(--text-primary, #111827)' }}>{item.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
