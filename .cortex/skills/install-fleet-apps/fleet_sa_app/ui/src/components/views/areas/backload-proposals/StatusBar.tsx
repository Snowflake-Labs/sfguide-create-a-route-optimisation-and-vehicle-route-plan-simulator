// Single consolidated status surface for the Backload Proposals cockpit. A slim
// full-width bar under the filter controls that shows live progress (busy), a
// dismissible error, or a dismissible info message - one at a time. Priority:
// busy > error > info. Renders null when idle.

interface Props {
  busy: string | null;
  error: string | null;
  info: string | null;
  onClearError: () => void;
  onClearInfo: () => void;
  onClearBusy?: () => void;
}

const barBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  margin: 0,
  padding: '8px 12px',
  borderRadius: 6,
  fontSize: 13,
  borderLeft: '3px solid transparent',
};

const dismissBtn: React.CSSProperties = {
  marginLeft: 'auto',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: '0 2px',
  color: 'inherit',
  opacity: 0.7,
};

export default function StatusBar({ busy, error, info, onClearError, onClearInfo, onClearBusy }: Props) {
  if (busy) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{ ...barBase, background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '3px solid var(--accent)', color: 'var(--text)' }}
      >
        <span
          aria-hidden="true"
          style={{ width: 14, height: 14, flexShrink: 0, borderRadius: '50%', border: '2px solid var(--border)', borderTopColor: 'var(--accent)', animation: 'spin 1s linear infinite' }}
        />
        <span>{busy}</span>
        {onClearBusy && (
          <button type="button" style={dismissBtn} aria-label="Dismiss progress" onClick={onClearBusy}>&#10005;</button>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" style={{ ...barBase, background: 'rgba(220,38,38,0.10)', borderLeft: '3px solid var(--red)', color: 'var(--red)' }}>
        <span style={{ fontWeight: 600 }}>Error:</span>
        <span>{error}</span>
        <button type="button" style={dismissBtn} aria-label="Dismiss error" onClick={onClearError}>&#10005;</button>
      </div>
    );
  }

  if (info) {
    return (
      <div role="status" aria-live="polite" style={{ ...barBase, background: 'rgba(13,176,72,0.10)', borderLeft: '3px solid var(--green)', color: '#157a3a' }}>
        <span>{info}</span>
        <button type="button" style={dismissBtn} aria-label="Dismiss message" onClick={onClearInfo}>&#10005;</button>
      </div>
    );
  }

  return null;
}
