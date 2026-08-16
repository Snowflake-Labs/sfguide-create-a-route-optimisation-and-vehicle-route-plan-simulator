// EnsembleList - master view for the ensemble grade mode. One card per vehicle,
// ranked by the vehicle's best weighted composite. Each card shows the best
// composite (large) + overall grade on the left rail, then nests one sub-row
// per load that vehicle was matched to. Each load sub-row carries a badge for
// every strategy that proposed it (the winning one highlighted), the route
// economics, and a compact per-dimension GradeCard.
//
// Selecting a sub-row selects the underlying pair key so the map + drawer light
// up. Session-only Accept/Reject/Flag on the best pair via the card header.

import type { RankedTrailer, RankedPair, StrategyFamily } from '../backload-ensemble';
import { FAMILY_LABELS, gradeColor } from '../backload-ensemble';
import { SELECT_RING, SELECT_BG, panelStyle, FAMILY_BADGE, REJECT_REASONS } from './constants';
import { fmtKm, fmtSlack, fmtIdle, place } from './format';
import { ProposalActions } from './badges';
import type { ChipDef, Decision, DecisionState } from './types';
import GradeCard from './GradeCard';

interface Props {
  rows: RankedTrailer[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  decisions: Record<string, DecisionState>;
  reasonFor: string | null;
  onOpenReason: (key: string | null) => void;
  onDecide: (key: string, action: Decision, reason?: string) => void;
  onExplain?: (key: string) => void;
  chipsFor: (trailerId: string, loadId: string) => ChipDef[];
  busy: boolean;
  consolidationActive?: boolean;
  labelNoun?: string;
  ranAt: number;
}

// Best-pick consensus chip: how many of the strategies that evaluated this unit
// independently ranked this exact assignment as their #1.
function ConsensusBadge({ n, of, kind }: { n: number; of: number; kind: 'load' | 'carrier' }) {
  if (of <= 0) return null;
  const variant = of <= 1 ? 'neutral' : (n * 2 > of ? 'success' : 'caution');
  const label = kind === 'load' ? 'best load' : 'best carrier';
  const unitWord = kind === 'load' ? 'this vehicle' : 'this load';
  const pickWord = kind === 'load' ? 'this load as its #1 backload' : 'this vehicle as its best carrier';
  return (
    <span className={`status-badge ${variant}`} title={`${n} of ${of} ${of === 1 ? 'strategy' : 'strategies'} that evaluated ${unitWord} ranked ${pickWord}.`}>
      {n}/{of} {label}
    </span>
  );
}

function AlgoBadges({ pair }: { pair: RankedPair }) {
  return (
    <>
      {pair.families.map((f: StrategyFamily) => {
        const isWinner = f === pair.bestSource;
        return (
          <span
            key={f}
            className={`status-badge ${isWinner ? FAMILY_BADGE[f] : 'neutral'}`}
            title={isWinner ? 'Winning strategy for this load' : 'Also proposed by this strategy'}
            style={isWinner ? undefined : { opacity: 0.75 }}
          >
            {FAMILY_LABELS[f]}
          </span>
        );
      })}
    </>
  );
}

export default function EnsembleList({
  rows, selectedKey, onSelect, decisions, reasonFor, onOpenReason, onDecide, onExplain,
  chipsFor, busy, consolidationActive = true, labelNoun = 'vehicle', ranAt,
}: Props) {
  return (
    <div style={{ ...panelStyle, overflowY: 'auto', padding: 8, minHeight: 0 }}>
      {rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: 16 }}>
          {ranAt > 0
            ? 'No ensemble results for the active preset. Raise Max vehicles / loads or check the region routing service.'
            : <>No ensemble results yet. Click <b>Run ensemble</b> to run every strategy and grade each {labelNoun} side-by-side.</>}
        </div>
      )}
      {rows.map((t, i) => {
        const color = gradeColor(t.grade);
        const bestChips = chipsFor(t.trailerId, t.best.loadId);
        return (
          <div key={t.trailerId} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 8, borderRadius: 6, marginBottom: 6, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 46 }}>
              <span style={{ fontSize: 9, color: 'var(--text-secondary)' }}>#{i + 1}</span>
              <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1, color }}>{Math.round(t.composite)}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color }}>{t.grade}</span>
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <b style={{ fontSize: 12 }}>{t.trailerId}</b>
                <span className="status-badge neutral" title={`Loads this ${labelNoun} was matched to`}>
                  {t.orderCount} load{t.orderCount === 1 ? '' : 's'}
                </span>
                <ConsensusBadge n={t.best.trailerConsensus} of={t.best.trailerConsensusOf} kind="load" />
                <span style={{ marginLeft: 'auto' }}>
                  <ProposalActions
                    proposalKey={t.best.key}
                    decision={decisions[t.best.key]}
                    reasonOpen={reasonFor === t.best.key}
                    reasons={REJECT_REASONS}
                    busy={busy}
                    onOpenReason={onOpenReason}
                    onDecide={onDecide}
                    onExplain={onExplain}
                  />
                </span>
              </div>

              {t.orders.map((p) => {
                const isSel = p.key === selectedKey;
                return (
                  <div
                    key={p.key}
                    onClick={() => onSelect(p.key)}
                    style={{ marginTop: 6, padding: 6, borderRadius: 5, cursor: 'pointer', border: isSel ? `1px solid ${SELECT_RING}` : '1px solid var(--border)', background: isSel ? SELECT_BG : 'transparent' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{'\u2192'} {p.loadId}</span>
                      <span className={`status-badge ${p.isInternal ? 'success' : 'neutral'}`}>{p.isInternal ? 'INTERNAL' : 'EXTERNAL'}</span>
                      <AlgoBadges pair={p} />
                      <ConsensusBadge n={p.trailerConsensus} of={p.trailerConsensusOf} kind="load" />
                      <ConsensusBadge n={p.loadConsensus} of={p.loadConsensusOf} kind="carrier" />
                    </div>

                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                      {place(p.emptyCity)} {'\u2192'} {place(p.pickupCity, p.pickupCountry)}
                      {p.deliveryCity ? ` \u2192 ${place(p.deliveryCity)}` : ''}
                    </div>

                    <div style={{ fontSize: 11, marginTop: 2 }}>
                      empty {fmtKm(p.emptyKm)} km
                      {p.loadedKm != null && <> {'\u00B7'} loaded {fmtKm(p.loadedKm)} km</>}
                      {p.detourKm != null && <> {'\u00B7'} detour +{fmtKm(p.detourKm)} km</>}
                      {p.marginUsd != null && <> {'\u00B7'} margin ${Math.round(p.marginUsd)}</>}
                      {p.pickupSlackHrs != null && <> {'\u00B7'} slack {fmtSlack(p.pickupSlackHrs)} h</>}
                      {p.idleHours != null && <> {'\u00B7'} idle {fmtIdle(p.idleHours)}</>}
                      {p.maxStopSeq != null && p.maxStopSeq > 1 && <> {'\u00B7'} {p.maxStopSeq}-stop tour</>}
                    </div>

                    <div style={{ marginTop: 6 }}>
                      <GradeCard pair={p} compact consolidationActive={consolidationActive} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
