// Modal drawer for inspecting a specific job's logs + metadata. Closes on
// backdrop click. Streams live logs for RUNNING jobs (handled in
// useJobDetail).

import React from 'react';
import type { DetailMeta } from '../types';

interface Props {
  selectedJobId: string | null;
  detailMeta: DetailMeta;
  detailLines: string[];
  detailLoading: boolean;
  detailLogRef: React.Ref<HTMLDivElement>;
  onClose: () => void;
}

export default function JobDetailDrawer({
  selectedJobId, detailMeta, detailLines, detailLoading, detailLogRef, onClose,
}: Props) {
  if (!selectedJobId) return null;
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 8, width: 'min(900px, 100%)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #E5E7EB', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Job Details</div>
            <div style={{ fontSize: 11, color: '#6E7681', marginTop: 2, fontFamily: 'monospace' }}>{selectedJobId}</div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: '1px solid #E5E7EB', borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
          >Close</button>
        </div>
        <div style={{ padding: '12px 18px', borderBottom: '1px solid #F1F3F5', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, fontSize: 12 }}>
          <div><div style={{ color: '#6E7681', fontSize: 10 }}>Status</div><div style={{ fontWeight: 600 }}>{detailMeta?.status || '-'}</div></div>
          <div><div style={{ color: '#6E7681', fontSize: 10 }}>Points</div><div style={{ fontWeight: 600 }}>{Number(detailMeta?.pointsGenerated || 0).toLocaleString()}</div></div>
          <div><div style={{ color: '#6E7681', fontSize: 10 }}>Trips</div><div style={{ fontWeight: 600 }}>{Number(detailMeta?.tripsGenerated || 0).toLocaleString()}</div></div>
          <div><div style={{ color: '#6E7681', fontSize: 10 }}>Source</div><div style={{ fontWeight: 600 }}>{detailMeta?.source === 'memory' ? 'Live (memory)' : detailMeta?.source === 'db' ? 'Persisted (DB)' : '-'}</div></div>
        </div>
        <div
          ref={detailLogRef}
          style={{ flex: 1, overflowY: 'auto', background: '#1B1F23', color: '#8DC891', fontFamily: 'monospace', fontSize: 11, padding: 12, minHeight: 240 }}
        >
          {detailLoading && detailLines.length === 0 ? (
            <span style={{ color: '#6E7681' }}>Loading logs...</span>
          ) : detailLines.length === 0 ? (
            <span style={{ color: '#6E7681' }}>(No log events)</span>
          ) : (
            detailLines.map((line, i) => (
              <div key={i} style={{ color: line === '--- Live ---' ? '#E0AF68' : line.startsWith('WARNING') ? '#E5C07B' : line.startsWith('Error') ? '#F07178' : undefined }}>{line}</div>
            ))
          )}
        </div>
        {detailMeta?.error && (
          <div style={{ padding: '8px 18px', background: '#FFEBEE', color: '#D32F2F', fontSize: 12, borderTop: '1px solid #FFCDD2' }}>
            {detailMeta.error}
          </div>
        )}
      </div>
    </div>
  );
}
