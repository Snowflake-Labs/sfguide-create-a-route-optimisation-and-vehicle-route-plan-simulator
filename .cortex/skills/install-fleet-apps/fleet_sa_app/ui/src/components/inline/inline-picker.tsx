'use client';

import { useState } from 'react';

interface InlinePickerProps {
  label: string;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  onSelect?: (value: string) => void;
}

export function InlinePicker({ label, options, placeholder = 'Select...' }: InlinePickerProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const filtered = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
  const selectedLabel = options.find((o) => o.value === selected)?.label;

  return (
    <div
      style={{
        padding: '12px 16px',
        borderRadius: '12px',
        border: '1px solid var(--border-default, #e5e7eb)',
        backgroundColor: 'var(--surface-primary, #fff)',
      }}
    >
      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '6px', color: 'var(--text-primary, #111827)' }}>
        {label}
      </div>
      <div style={{ position: 'relative' }}>
        <input
          type="text"
          value={open ? query : selectedLabel || ''}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          style={{
            width: '100%',
            padding: '6px 10px',
            borderRadius: '6px',
            border: '1px solid var(--border-default, #e5e7eb)',
            fontSize: '13px',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {open && filtered.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              marginTop: '4px',
              borderRadius: '6px',
              border: '1px solid var(--border-default, #e5e7eb)',
              backgroundColor: 'var(--surface-primary, #fff)',
              boxShadow: '0 4px 8px rgba(0,0,0,0.08)',
              maxHeight: '150px',
              overflow: 'auto',
              zIndex: 10,
            }}
          >
            {filtered.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setSelected(opt.value);
                  setQuery('');
                  setOpen(false);
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 10px',
                  border: 'none',
                  backgroundColor: opt.value === selected ? 'var(--surface-accent, #e0edff)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '13px',
                  color: 'var(--text-primary, #111827)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
