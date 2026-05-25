// Tiny CSS-only info tooltip. Hover or focus the ⓘ to reveal an
// immediate, styled bubble — replaces the browser's slow native title
// tooltip on every lever in the Backload Matching page.

import { useState } from 'react';

interface Props {
  text: string;
}

export default function InfoTip({ text }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <span
      tabIndex={0}
      aria-label={text}
      role="button"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'help',
        marginLeft: 4,
        width: 14,
        height: 14,
        fontSize: 12,
        color: 'var(--text-secondary)',
        userSelect: 'none',
        outline: 'none',
      }}
    >
      <span aria-hidden="true">ⓘ</span>
      {open && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '50%',
            transform: 'translateX(-50%)',
            background: '#14141f',
            color: '#e8e8f0',
            fontSize: 11,
            lineHeight: 1.4,
            fontWeight: 400,
            padding: '6px 8px',
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
            whiteSpace: 'pre-line',
            maxWidth: 260,
            width: 'max-content',
            textAlign: 'left',
            zIndex: 1000,
            pointerEvents: 'none',
            letterSpacing: 0,
          }}
        >
          {text}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: '100%',
              left: '50%',
              transform: 'translateX(-50%)',
              width: 0,
              height: 0,
              borderLeft: '5px solid transparent',
              borderRight: '5px solid transparent',
              borderTop: '5px solid #14141f',
            }}
          />
        </span>
      )}
    </span>
  );
}
