'use client';

import { RoleSelector } from './role-selector';

interface HeaderProps {
  name?: string;
  onAboutClick?: () => void;
}

export function Header({ name = 'Data App', onAboutClick }: HeaderProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: '48px',
        padding: '0 16px',
        borderBottom: '1px solid var(--border-default, #e5e7eb)',
        backgroundColor: 'var(--surface-primary, #fff)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>
          {name}
        </span>
        <span
          style={{
            fontSize: '11px',
            fontWeight: 500,
            padding: '2px 8px',
            borderRadius: '10px',
            backgroundColor: 'var(--surface-success, #ecfdf5)',
            color: 'var(--text-success, #059669)',
          }}
        >
          Production
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <RoleSelector />
        <button
          aria-label="Settings"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '16px',
            padding: '4px',
            color: 'var(--text-secondary, #6b7280)',
          }}
        >
          ⚙
        </button>
        <button
          onClick={onAboutClick}
          title="About this app"
          aria-label="About this app"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '16px',
            padding: '4px',
            color: 'var(--text-secondary, #6b7280)',
          }}
        >
          ?
        </button>
      </div>
    </header>
  );
}
