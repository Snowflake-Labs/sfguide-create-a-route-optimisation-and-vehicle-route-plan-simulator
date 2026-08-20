// VehicleList - vehicle-centered master view. One selectable card per vehicle
// showing its best-ranked backload (grade dial, route cities, economics,
// constraint chips, session decision actions) with an expandable list of
// alternative loads. Operates on the ranked-by-weights per-vehicle grouping.

import type { RankedTrailer } from '../backload-ensemble';
import { FAMILY_LABELS, gradeColor } from '../backload-ensemble';
import { SELECT_RING, SELECT_BG, panelStyle, REJECT_REASONS } from './constants';
import { fmtKm, place } from './format';
import { ProposalActions, ConstraintChips } from './badges';
import type { ChipDef, Decision, DecisionState } from './types';

interface Props {
  rows: RankedTrailer[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  expanded: string | null;
  onToggleExpand: (trailerId: string) => void;
  decisions: Record<string, DecisionState>;
  reasonFor: string | null;
  onOpenReason: (key: string | null) => void;
  onDecide: (key: string, action: Decision, reason?: string) => void;
  onExplain?: (key: string) => void;
  chipsFor: (trailerId: string, loadId: string) => ChipDef[];
  busy: boolean;
  labelNoun?: string;
  ranAt: number;
}

export default function VehicleList({
  rows, selectedKey, onSelect, expanded, onToggleExpand, decisions, reasonFor,
  onOpenReason, onDecide, onExplain, chipsFor, busy, labelNoun = 'vehicle', ranAt,
}: Props) {
  return (
    <div style={{ ...panelStyle, overflowY: 'auto', padding: 8, minHeight: 0 }}>
      {rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: 16 }}>
          {ranAt > 0 ? 'No proposals match the current filters. Relax the filters or raise Max vehicles / loads.' : <>Run a strategy to generate per-{labelNoun} backload recommendations.</>}
        </div>
      )}
      {rows.map((t) => {
        const b = t.best;
        const isSel = b.key === selectedKey;
        const isExpanded = expanded === t.trailerId;
        const color = gradeColor(t.grade);
        return (
          <div
            key={t.trailerId}
            style={{ padding: 8, borderRadius: 6, marginBottom: 6, border: isSel ? `1px solid ${SELECT_RING}` : '1px solid var(--border)', background: isSel ? SELECT_BG : 'transparent' }}
          >
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }} onClick={() => { onSelect(b.key); onToggleExpand(t.trailerId); }}>
              <span style={{ width: 30, height: 30, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', background: color, flexShrink: 0 }}>{t.grade}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 12 }}>{t.trailerId}</b>
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{'\u2192'} {b.loadId}</span>
                  <span className={`status-badge ${b.isInternal ? 'success' : 'neutral'}`}>{b.isInternal ? 'INTERNAL' : 'EXTERNAL'}</span>
                  <span className="status-badge neutral">{FAMILY_LABELS[b.bestSource]}</span>
                  <span style={{ marginLeft: 'auto' }}>
                    <ProposalActions
                      proposalKey={b.key}
                      decision={decisions[b.key]}
                      reasonOpen={reasonFor === b.key}
                      reasons={REJECT_REASONS}
                      busy={busy}
                      onOpenReason={onOpenReason}
                      onDecide={onDecide}
                      onExplain={onExplain}
                    />
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {place(b.emptyCity)} {'\u2192'} {place(b.pickupCity, b.pickupCountry)}{b.deliveryCity ? ` \u2192 ${place(b.deliveryCity)}` : ''}
                </div>
                <div style={{ fontSize: 11, marginTop: 2 }}>
                  empty {fmtKm(b.emptyKm)} km
                  {b.loadedKm != null && <> {'\u00B7'} loaded {fmtKm(b.loadedKm)} km</>}
                  <span style={{ marginLeft: 6, fontWeight: 600 }}>score {Math.round(t.composite)}</span>
                  {t.orderCount > 1 && <span style={{ color: 'var(--text-secondary)' }}> {'\u00B7'} {t.orderCount} options</span>}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 6 }}>
              <ConstraintChips chips={chipsFor(t.trailerId, b.loadId)} />
            </div>

            {isExpanded && t.orderCount > 1 && (
              <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8, fontSize: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Alternative loads</div>
                {t.orders.slice(1, 6).map((o) => (
                  <div
                    key={o.key}
                    onClick={() => onSelect(o.key)}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '3px 4px', borderRadius: 4, cursor: 'pointer', color: 'var(--text-secondary)', background: o.key === selectedKey ? SELECT_BG : 'transparent' }}
                  >
                    <span>{o.loadId} {'\u00B7'} {place(o.pickupCity, o.pickupCountry)}{o.deliveryCity ? ` \u2192 ${place(o.deliveryCity)}` : ''} ({FAMILY_LABELS[o.bestSource]})</span>
                    <span style={{ whiteSpace: 'nowrap' }}>score {Math.round(o.composite)} {'\u00B7'} empty {fmtKm(o.emptyKm)} km</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
