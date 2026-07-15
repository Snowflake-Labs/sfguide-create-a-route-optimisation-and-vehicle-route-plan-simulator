'use client';
import type { CSSProperties } from 'react';

interface RecenterButtonProps {
  onClick: () => void;
  disabled?: boolean;
  /** Override default top-right placement. */
  style?: CSSProperties;
  title?: string;
}

const baseStyle: CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 10,
  background: 'rgba(255,255,255,0.95)',
  backdropFilter: 'blur(8px)',
  border: '1px solid var(--border, #d0d0d0)',
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--text, #1a1a1a)',
  cursor: 'pointer',
  boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  lineHeight: 1,
};

const disabledStyle: CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
};

export default function RecenterButton({
  onClick,
  disabled = false,
  style,
  title = 'Recenter map to current data',
}: RecenterButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label="Recenter map"
      style={{ ...baseStyle, ...(disabled ? disabledStyle : null), ...style }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </svg>
      Recenter
    </button>
  );
}
