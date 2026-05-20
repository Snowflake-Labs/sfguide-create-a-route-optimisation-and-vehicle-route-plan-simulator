// Provisioning steps strip + legend, used across the RegionBuilder page.

import { Fragment } from 'react';
import { PROVISION_PHASES, PHASE_ORDER, STEP_GLYPH, StepState } from './helpers';

export function StepsStrip({ currentStage, allDone = false, elapsedHint }: { currentStage?: string; allDone?: boolean; elapsedHint?: string }) {
  const stage = (currentStage || '').toLowerCase();
  const currentIdx = stage === 'ready' ? PROVISION_PHASES.length : PHASE_ORDER.indexOf(stage);
  const activePhase = currentIdx > 0 && currentIdx <= PROVISION_PHASES.length ? PROVISION_PHASES[currentIdx - 1] : null;
  return (
    <span className="steps-strip" aria-label="Provisioning steps">
      {PROVISION_PHASES.map((phase, idx) => {
        let state: StepState;
        if (allDone) state = 'done';
        else if (currentIdx < 0) state = 'pending';
        else if (idx + 1 < currentIdx) state = 'done';
        else if (idx + 1 === currentIdx) state = 'active';
        else state = 'pending';
        return (
          <span
            key={phase.id}
            className={`step-pip ${state}`}
            title={`${idx + 1}. ${phase.label} \u2014 ${state === 'done' ? 'done' : state === 'active' ? 'in progress' : 'not started'}`}
          >
            {STEP_GLYPH[state]}
          </span>
        );
      })}
      {!allDone && activePhase && elapsedHint && (
        <span className="steps-elapsed" title={`Active step: ${activePhase.label}`}>
          {activePhase.label} \u00b7 {elapsedHint}
        </span>
      )}
    </span>
  );
}

export function StepsLegend() {
  return (
    <div className="steps-legend" role="note">
      <div className="legend-section">
        <strong style={{ color: 'var(--text-primary, inherit)', opacity: 0.85 }}>Steps:</strong>
        {PROVISION_PHASES.map((p, i) => (
          <Fragment key={p.id}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ opacity: 0.7 }}>{i + 1}.</span>
              <span>{p.label}</span>
              {i < PROVISION_PHASES.length - 1 && <span className="legend-arrow">{'\u2192'}</span>}
            </span>
          </Fragment>
        ))}
      </div>
      <span className="legend-divider">|</span>
      <div className="legend-section">
        <strong style={{ color: 'var(--text-primary, inherit)', opacity: 0.85 }}>Legend:</strong>
        <span><span className="legend-glyph done">{STEP_GLYPH.done}</span>Done</span>
        <span><span className="legend-glyph active">{STEP_GLYPH.active}</span>In progress</span>
        <span><span className="legend-glyph pending">{STEP_GLYPH.pending}</span>Not started</span>
      </div>
    </div>
  );
}
