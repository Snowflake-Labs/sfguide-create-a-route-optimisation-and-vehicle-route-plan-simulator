'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Per-view info overlay: a centered modal that renders a view's `info` markdown
// (methodology / attribution notes). Triggered by the "i" button in the view
// bar. Mirrors the AboutDialog pattern (fixed backdrop, click-outside to close).
interface ViewInfoDialogProps {
  title: string;
  content: string;
  onClose: () => void;
}

export function ViewInfoDialog({ title, content, onClose }: ViewInfoDialogProps) {
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
          padding: '28px 32px',
          maxWidth: '560px',
          width: '90%',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.15)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
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
        <div
          className="markdown-body"
          style={{ fontSize: '14px', lineHeight: 1.6, color: 'var(--text-secondary, #4b5563)' }}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
