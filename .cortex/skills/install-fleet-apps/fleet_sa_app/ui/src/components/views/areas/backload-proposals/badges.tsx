// Small badge / chip / action renderers shared by the cockpit master lists and
// the detail drawer. JSX-only. Uses the shared .status-badge / .btn classes.

import type { ChipDef, Decision, DecisionState } from './types';

// Green/red pill for a single constraint check.
export function Chip({ label, ok }: ChipDef) {
  return <span className={`status-badge ${ok ? 'success' : 'critical'}`}>{ok ? '\u2713' : '\u2717'} {label}</span>;
}

export function ConstraintChips({ chips }: { chips: ChipDef[] }) {
  if (!chips.length) return null;
  return (
    <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {chips.map((c) => <Chip key={c.label} label={c.label} ok={c.ok} />)}
    </span>
  );
}

const DECISION_VARIANT: Record<Decision, string> = { ACCEPT: 'success', REJECT: 'critical', FLAG: 'caution' };

export function DecisionBadge({ decision }: { decision: DecisionState }) {
  return (
    <span className={`status-badge ${DECISION_VARIANT[decision.action] ?? 'neutral'}`} title={decision.reason || ''}>
      {decision.action}{decision.reason ? `: ${decision.reason}` : ''}
    </span>
  );
}

// Inline decision controls (Accept / Reject-with-reason / Flag) + optional
// Cortex Explain. Session-only: the parent stores the decision in component
// state, nothing is written back. `stopPropagation` so clicking an action does
// not also select/toggle the enclosing card.
interface ActionsProps {
  proposalKey: string;
  decision: DecisionState | undefined;
  reasonOpen: boolean;
  reasons: string[];
  busy: boolean;
  onOpenReason: (key: string | null) => void;
  onDecide: (key: string, action: Decision, reason?: string) => void;
  onExplain?: (key: string) => void;
}

const iconBtn: React.CSSProperties = {
  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)',
  borderRadius: 4, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: '3px 6px',
};

export function ProposalActions({ proposalKey, decision, reasonOpen, reasons, busy, onOpenReason, onDecide, onExplain }: ActionsProps) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
      {decision ? (
        <DecisionBadge decision={decision} />
      ) : reasonOpen ? (
        <select
          className="sf-select"
          autoFocus
          disabled={busy}
          defaultValue=""
          onChange={(e) => { if (e.target.value) onDecide(proposalKey, 'REJECT', e.target.value); }}
        >
          <option value="" disabled>reason&#8230;</option>
          {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      ) : (
        <>
          <button type="button" style={iconBtn} disabled={busy} title="Accept" onClick={() => onDecide(proposalKey, 'ACCEPT')}>{'\u2713'}</button>
          <button type="button" style={iconBtn} disabled={busy} title="Reject (with reason)" onClick={() => onOpenReason(proposalKey)}>{'\u2717'}</button>
          <button type="button" style={iconBtn} disabled={busy} title="Flag" onClick={() => onDecide(proposalKey, 'FLAG')}>{'\u2691'}</button>
        </>
      )}
      {onExplain && !decision && (
        <button type="button" style={iconBtn} disabled={busy} title="Explain with Cortex" onClick={() => onExplain(proposalKey)}>{'\uD83D\uDCAC'}</button>
      )}
    </span>
  );
}
