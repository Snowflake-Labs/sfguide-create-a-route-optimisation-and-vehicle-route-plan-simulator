'use client';

import type { AppConfig } from './app-shell';

interface AboutDialogProps {
  config: AppConfig;
  onClose: () => void;
}

export function AboutDialog({ config, onClose }: AboutDialogProps) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: 'var(--surface-primary, #fff)',
          borderRadius: '12px',
          padding: '32px',
          maxWidth: '520px',
          width: '90%',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.15)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>
            {config.name}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '20px',
              color: 'var(--text-secondary, #6b7280)',
              padding: '0 4px',
              lineHeight: 1,
            }}
          >
            x
          </button>
        </div>

        {config.description && (
          <p style={{ margin: '0 0 20px', fontSize: '14px', lineHeight: 1.6, color: 'var(--text-secondary, #6b7280)' }}>
            {config.description}
          </p>
        )}

        {config.targetUsers.length > 0 && (
          <div style={{ marginBottom: '20px' }}>
            <h3 style={{ margin: '0 0 8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Who is this for
            </h3>
            <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', lineHeight: 1.8, color: 'var(--text-secondary, #6b7280)' }}>
              {config.targetUsers.map((u, i) => <li key={i}>{u}</li>)}
            </ul>
          </div>
        )}

        {config.capabilities.length > 0 && (
          <div>
            <h3 style={{ margin: '0 0 8px', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              What it can do
            </h3>
            <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', lineHeight: 1.8, color: 'var(--text-secondary, #6b7280)' }}>
              {config.capabilities.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
