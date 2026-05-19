// Helper used by Active and Failed sections to render the diagnose drawer
// triggered by "Ask for status".

import type { DiagEntry } from '../types';

export function DiagDrawer({
  entry,
  onClose,
}: {
  entry: DiagEntry | undefined;
  onClose: () => void;
}) {
  if (!entry?.expanded) return null;
  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'rgba(46, 134, 171, 0.08)',
        borderLeft: '3px solid var(--accent)',
        borderRadius: 6,
        fontSize: 13,
      }}
    >
      {entry.loading && <div>Diagnosing...</div>}
      {entry.error && (
        <div style={{ color: 'var(--error, #e53935)' }}>Error: {entry.error}</div>
      )}
      {entry.markdown && (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit' }}>
          {entry.markdown}
        </pre>
      )}
      {entry.markdown && (
        <details style={{ marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
          <summary>Raw diagnostic data</summary>
          <pre style={{ overflow: 'auto', maxHeight: 240 }}>
            {JSON.stringify(entry.raw, null, 2)}
          </pre>
        </details>
      )}
      <button className="btn small ghost" style={{ marginTop: 6 }} onClick={onClose}>
        Close
      </button>
    </div>
  );
}

export function getTimeSince(timestamp: string) {
  if (!timestamp) return '';
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}
