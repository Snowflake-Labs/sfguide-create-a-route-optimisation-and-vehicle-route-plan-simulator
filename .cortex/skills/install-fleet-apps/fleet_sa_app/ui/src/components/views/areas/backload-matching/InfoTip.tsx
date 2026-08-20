'use client';

// CSS-only info tooltip. Hover/focus the info glyph to reveal a styled bubble.
// Rendered through a body-level portal with position:fixed so it escapes any
// ancestor overflow:hidden and clamps inside the viewport.

import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props { text: string; }
interface Pos { top: number; left: number; width: number; arrowLeft: number; }

const MAX_WIDTH = 260;
const VIEWPORT_MARGIN = 8;
const GAP = 6;

export default function InfoTip({ text }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);

  // Allow literal "\n" in string-attribute form and still render line breaks.
  const rendered = text.replace(/\\n/g, '\n');

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = Math.min(MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
      const centerX = r.left + r.width / 2;
      const minLeft = VIEWPORT_MARGIN;
      const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
      const left = Math.max(minLeft, Math.min(centerX - width / 2, maxLeft));
      const top = r.top - GAP;
      const arrowLeft = Math.max(8, Math.min(centerX - left, width - 8));
      setPos({ top, left, width, arrowLeft });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  return (
    <span
      ref={triggerRef}
      tabIndex={0}
      aria-label={text.replace(/\\n/g, ' ')}
      role="button"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      style={{
        position: 'relative', display: 'inline-flex', alignItems: 'center',
        justifyContent: 'center', cursor: 'help', marginLeft: 4, width: 14,
        height: 14, fontSize: 12, color: 'var(--text-secondary, #6b7280)',
        userSelect: 'none', outline: 'none',
      }}
    >
      <span aria-hidden="true">&#9432;</span>
      {open && pos &&
        createPortal(
          <span
            role="tooltip"
            style={{
              position: 'fixed', top: pos.top, left: pos.left, width: pos.width,
              maxWidth: MAX_WIDTH, transform: 'translateY(-100%)',
              background: '#14141f', color: '#e8e8f0', fontSize: 11, lineHeight: 1.4,
              fontWeight: 400, padding: '6px 8px', borderRadius: 4,
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)', whiteSpace: 'pre-line',
              textAlign: 'left', zIndex: 1000, pointerEvents: 'none',
              letterSpacing: 0, boxSizing: 'border-box',
            }}
          >
            {rendered}
            <span
              aria-hidden="true"
              style={{
                position: 'absolute', top: '100%', left: pos.arrowLeft,
                transform: 'translateX(-50%)', width: 0, height: 0,
                borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                borderTop: '5px solid #14141f',
              }}
            />
          </span>,
          document.body,
        )}
    </span>
  );
}
