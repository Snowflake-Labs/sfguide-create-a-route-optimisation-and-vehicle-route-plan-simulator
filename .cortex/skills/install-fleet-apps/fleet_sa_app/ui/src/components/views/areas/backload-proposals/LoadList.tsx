// LoadList - load-centered master view. Groups ranked pairs by load, with the
// competing vehicles nested under each load header (best composite first).
// Mirror of VehicleList for the load-first perspective.

import { useMemo } from 'react';
import type { RankedPair } from '../backload-ensemble';
import { FAMILY_LABELS } from '../backload-ensemble';
import { SELECT_RING, SELECT_BG, panelStyle, REJECT_REASONS } from './constants';
import { fmtKm, place } from './format';
import { ProposalActions } from './badges';
import type { Decision, DecisionState } from './types';

interface Props {
  rows: RankedPair[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  decisions: Record<string, DecisionState>;
  reasonFor: string | null;
  onOpenReason: (key: string | null) => void;
  onDecide: (key: string, action: Decision, reason?: string) => void;
  onExplain?: (key: string) => void;
  busy: boolean;
  ranAt: number;
}

export default function LoadList({ rows, selectedKey, onSelect, decisions, reasonFor, onOpenReason, onDecide, onExplain, busy, ranAt }: Props) {
  const grouped = useMemo(() => {
    const map = new Map<string, RankedPair[]>();
    for (const r of rows) {
      const arr = map.get(r.loadId) ?? [];
      arr.push(r);
      map.set(r.loadId, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => b.composite - a.composite || (a.emptyKm ?? Infinity) - (b.emptyKm ?? Infinity));
    return [...map.entries()].sort((a, b) => (b[1][0]?.composite ?? 0) - (a[1][0]?.composite ?? 0));
  }, [rows]);

  return (
    <div style={{ ...panelStyle, overflowY: 'auto', padding: 8, minHeight: 0 }}>
      {grouped.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: 16 }}>
          {ranAt > 0 ? 'No proposals match the current filters. Relax the filters or raise Max vehicles / loads.' : 'Run a strategy to generate load-to-vehicle recommendations.'}
        </div>
      )}
      {grouped.map(([loadId, pairs]) => {
        const first = pairs[0];
        const anySel = pairs.some((p) => p.key === selectedKey);
        return (
          <div key={loadId} style={{ borderRadius: 6, marginBottom: 8, border: anySel ? `1px solid ${SELECT_RING}` : '1px solid var(--border)', overflow: 'hidden' }}>
            <div
              onClick={() => onSelect(first.key)}
              style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)', background: anySel ? SELECT_BG : 'rgba(0,0,0,0.02)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 12 }}>{loadId}</b>
                <span className={`status-badge ${first.isInternal ? 'success' : 'neutral'}`}>{first.isInternal ? 'INTERNAL' : 'EXTERNAL'}</span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{place(first.pickupCity, first.pickupCountry)}{first.deliveryCity ? ` \u2192 ${place(first.deliveryCity)}` : ''}</span>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)', marginLeft: 'auto' }}>{pairs.length} vehicle{pairs.length !== 1 ? 's' : ''}</span>
              </div>
            </div>
            {pairs.map((p, idx) => {
              const isSel = p.key === selectedKey;
              return (
                <div
                  key={p.key}
                  onClick={() => onSelect(p.key)}
                  style={{ padding: '6px 10px 6px 16px', cursor: 'pointer', borderTop: idx > 0 ? '1px solid var(--border)' : undefined, background: isSel ? 'rgba(13,176,72,0.10)' : 'transparent' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontWeight: 600, minWidth: 18 }}>#{idx + 1}</span>
                    <b style={{ fontSize: 11 }}>{p.trailerId}</b>
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{place(p.emptyCity)}</span>
                    <span className="status-badge neutral">{FAMILY_LABELS[p.bestSource]}</span>
                    <span style={{ marginLeft: 'auto' }}>
                      <ProposalActions
                        proposalKey={p.key}
                        decision={decisions[p.key]}
                        reasonOpen={reasonFor === p.key}
                        reasons={REJECT_REASONS}
                        busy={busy}
                        onOpenReason={onOpenReason}
                        onDecide={onDecide}
                        onExplain={onExplain}
                      />
                    </span>
                  </div>
                  <div style={{ fontSize: 11, marginTop: 2, paddingLeft: 26 }}>
                    empty {fmtKm(p.emptyKm)} km
                    {p.loadedKm != null && <> {'\u00B7'} loaded {fmtKm(p.loadedKm)} km</>}
                    <span style={{ marginLeft: 6, fontWeight: 600 }}>score {Math.round(p.composite)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
