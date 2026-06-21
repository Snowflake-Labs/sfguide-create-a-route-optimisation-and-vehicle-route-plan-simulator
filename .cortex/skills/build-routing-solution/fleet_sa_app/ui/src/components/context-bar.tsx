'use client';

import { useAppStore } from '@/lib/store';

export interface ContextBarField {
  id: string;
  type: string;
  label?: string;
  default?: string;
  configColumn?: string;
  options?: Array<{ value: string; label: string }>;
}

// Renders the region/vehicle (enum) context pickers. Implements the client half of the
// "Hybrid" context decision: on change it (1) sets store context.<id> so every dashboard
// view whose params reference context.<id> auto-refetches (the refetchOn replacement), and
// (2) POSTs /api/region so the server-side per-schema CONFIG row is updated, keeping the
// routing tool layer and projection views aligned with the dashboards.
export function ContextBar({ fields }: { fields: ContextBarField[] }) {
  const context = useAppStore((s) => s.context);
  const setContext = useAppStore((s) => s.setContext);

  const enumFields = fields.filter((f) => f.type === 'enum' && (f.options?.length ?? 0) > 0);
  if (enumFields.length === 0) return null;

  const onChange = (field: ContextBarField, value: string) => {
    setContext(field.id, value);
    // Fire-and-forget the server-side CONFIG write; dashboards already refetch from context.
    void fetch('/api/region', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field.id]: value }),
    }).catch(() => {
      /* non-fatal: client context still applies */
    });
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '16px',
        padding: '6px 16px',
        borderBottom: '1px solid var(--border-default, #e5e7eb)',
        backgroundColor: 'var(--surface-secondary, #f9fafb)',
        flexShrink: 0,
      }}
    >
      {enumFields.map((field) => {
        const current = (context[field.id] as string | undefined) ?? field.default ?? '';
        return (
          <label key={field.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary, #6b7280)' }}>
              {field.label ?? field.id}
            </span>
            <select
              value={current}
              onChange={(e) => onChange(field, e.target.value)}
              style={{
                fontSize: '13px',
                padding: '3px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border-default, #e5e7eb)',
                backgroundColor: 'var(--surface-primary, #fff)',
                color: 'var(--text-primary, #111827)',
                cursor: 'pointer',
              }}
            >
              {field.options!.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
