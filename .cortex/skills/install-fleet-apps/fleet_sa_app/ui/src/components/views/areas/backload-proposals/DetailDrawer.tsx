// Right-rail detail drawer for the selected proposal: header (vehicle -> load,
// winning strategy, grade), optional Cortex rationale, assigned-vehicle facts,
// load facts, a numbered route-leg timeline, the constraint chips, and the
// session decision actions.

import type { RankedPair } from '../backload-ensemble';
import { FAMILY_LABELS, DIMENSION_LABELS, DIMENSIONS, gradeColor } from '../backload-ensemble';
import { REJECT_REASONS } from './constants';
import { fmtKm, fmtSlack, fmtIdle, place } from './format';
import { ProposalActions, ConstraintChips } from './badges';
import type { ChipDef, Decision, DecisionState } from './types';

interface Props {
  pair: RankedPair | null;
  chips: ChipDef[];
  decision: DecisionState | undefined;
  reasonFor: string | null;
  onOpenReason: (key: string | null) => void;
  onDecide: (key: string, action: Decision, reason?: string) => void;
  onExplain: (key: string) => void;
  rationale: string | null;
  explaining: boolean;
  busy: boolean;
  labelNoun?: string;
}

type LegKind = 'start' | 'pickup' | 'delivery';
const KIND_STYLES: Record<LegKind, { label: string; bg: string; fg: string; ring: string }> = {
  start:   { label: 'EMPTY',    bg: 'rgba(120,120,130,0.16)', fg: '#374151', ring: '#787882' },
  pickup:  { label: 'PICKUP',   bg: 'rgba(217,119,6,0.18)',   fg: '#92400e', ring: '#d97706' },
  delivery:{ label: 'DELIVERY', bg: 'rgba(22,127,55,0.18)',   fg: '#065f46', ring: '#167f37' },
};

const HR = <hr style={{ margin: '10px 0', border: 'none', borderTop: '1px solid var(--border)' }} />;

export default function DetailDrawer({ pair, chips, decision, reasonFor, onOpenReason, onDecide, onExplain, rationale, explaining, busy, labelNoun = 'vehicle' }: Props) {
  if (!pair) {
    return (
      <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', padding: 12, minHeight: 0 }}>
        <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>
          Select a proposal in the list or on the map to inspect the assigned {labelNoun}, load, route legs, and grading.
        </div>
      </div>
    );
  }

  const legs: { kind: LegKind; place: string }[] = [
    { kind: 'start', place: place(pair.emptyCity) },
    { kind: 'pickup', place: place(pair.pickupCity, pair.pickupCountry) },
    ...(pair.deliveryCity ? [{ kind: 'delivery' as const, place: place(pair.deliveryCity) }] : []),
  ];
  const color = gradeColor(pair.grade);

  return (
    <div style={{ overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)', padding: 12, minHeight: 0, fontSize: 12, lineHeight: 1.5 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#fff', background: color }}>{pair.grade}</span>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{pair.trailerId} {'\u2192'} {pair.loadId}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
              {FAMILY_LABELS[pair.bestSource]} {'\u00B7'} score {Math.round(pair.composite)} {'\u00B7'} {pair.isInternal ? 'internal' : 'external'}
            </div>
          </div>
        </div>
        <ProposalActions
          proposalKey={pair.key}
          decision={decision}
          reasonOpen={reasonFor === pair.key}
          reasons={REJECT_REASONS}
          busy={busy}
          onOpenReason={onOpenReason}
          onDecide={onDecide}
          onExplain={onExplain}
        />
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button type="button" className="btn small secondary" disabled={explaining} onClick={() => onExplain(pair.key)}>{explaining ? 'Explaining\u2026' : 'Explain (Cortex)'}</button>
      </div>
      {rationale && <div style={{ marginTop: 8, padding: 8, fontSize: 11, background: 'rgba(0,0,0,0.04)', borderRadius: 4 }}>{rationale}</div>}

      {HR}
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Assigned {labelNoun}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <div><b>ID:</b> {pair.trailerId}</div>
        <div><b>Empty at:</b> {place(pair.emptyCity)}</div>
        <div><b>Empty leg:</b> {fmtKm(pair.emptyKm)} km</div>
        <div><b>Idle:</b> {fmtIdle(pair.idleHours)}</div>
      </div>

      {HR}
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Backload</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <div><b>Load:</b> {pair.loadId} ({pair.isInternal ? 'internal' : 'external'})</div>
        <div><b>Pickup:</b> {place(pair.pickupCity, pair.pickupCountry)}</div>
        <div><b>Delivery:</b> {place(pair.deliveryCity)}</div>
        <div><b>Loaded:</b> {fmtKm(pair.loadedKm)} km</div>
        {pair.detourKm != null && <div><b>Detour:</b> +{fmtKm(pair.detourKm)} km</div>}
        {pair.pickupSlackHrs != null && <div><b>Slack:</b> {fmtSlack(pair.pickupSlackHrs)} h</div>}
        {pair.marginUsd != null && <div><b>Margin:</b> ${Math.round(pair.marginUsd)}</div>}
      </div>

      {HR}
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Route</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {legs.map((l, i) => {
          const ks = KIND_STYLES[l.kind];
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '28px 84px 1fr', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 4, border: `1px solid ${ks.ring}33`, background: ks.bg }}>
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#fff', border: `2px solid ${ks.ring}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: ks.fg }}>{i + 1}</div>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: ks.fg }}>{ks.label}</span>
              <span style={{ fontSize: 12 }}>{l.place}</span>
            </div>
          );
        })}
      </div>

      {HR}
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Constraints</div>
      {chips.length ? <ConstraintChips chips={chips} /> : <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>No constraint data for this pair.</div>}

      <div style={{ marginTop: 10, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {DIMENSIONS.map((d) => {
          const g = pair.grades[d];
          const s = pair.scores[d];
          return (
            <span key={d} className="status-badge neutral" title={`${DIMENSION_LABELS[d]}: ${s == null ? 'no data' : Math.round(s) + '/100'}`} style={{ color: gradeColor(g) }}>
              {DIMENSION_LABELS[d].split(' ')[0]} {g ?? '-'}
            </span>
          );
        })}
      </div>
    </div>
  );
}
