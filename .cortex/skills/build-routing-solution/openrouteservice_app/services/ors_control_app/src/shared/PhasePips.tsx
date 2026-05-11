import type { PhaseStatus, OrsProfilePhases } from '../types';

const PHASE_ORDER: Array<keyof OrsProfilePhases> = ['osm', 'lm', 'ch'];
const PHASE_LABEL: Record<keyof OrsProfilePhases, string> = {
  osm: 'OSM',
  lm: 'LM',
  ch: 'CH',
};

const PHASE_TITLES: Record<keyof OrsProfilePhases, string> = {
  osm: 'OSM (base graph import + location_index)',
  lm: 'Landmarks (long-range heuristic)',
  ch: 'Contraction Hierarchies (short-route optimisation)',
};

const STATE_GLYPH: Record<PhaseStatus, string> = {
  done: '\u2713',
  in_progress: '\u22EF',
  not_started: '\u25CB',
  na: '\u2014',
};

const STATE_LABEL: Record<PhaseStatus, string> = {
  done: 'Done',
  in_progress: 'In progress',
  not_started: 'Not started',
  na: 'N/A',
};

const STATE_CLASS: Record<PhaseStatus, string> = {
  done: 'phase-pip done',
  in_progress: 'phase-pip in-progress',
  not_started: 'phase-pip not-started',
  na: 'phase-pip na',
};

interface Props {
  phases?: OrsProfilePhases;
  ready?: boolean;
  showLabel?: boolean;
  size?: 'sm' | 'md';
}

export default function PhasePips({ phases, ready, showLabel = true, size = 'sm' }: Props) {
  const safe: OrsProfilePhases = phases || {
    osm: ready ? 'done' : 'not_started',
    lm: ready ? 'done' : 'not_started',
    ch: ready ? 'done' : 'not_started',
  };
  return (
    <span className={`phase-pip-row size-${size}`}>
      {PHASE_ORDER.map((key) => {
        const state = safe[key];
        return (
          <span
            key={key}
            className={STATE_CLASS[state]}
            title={`${PHASE_TITLES[key]} \u2014 ${STATE_LABEL[state]}`}
          >
            <span className="phase-pip-glyph">{STATE_GLYPH[state]}</span>
            {showLabel && <span className="phase-pip-label">{PHASE_LABEL[key]}</span>}
          </span>
        );
      })}
    </span>
  );
}

export function PhaseLegend() {
  return (
    <div className="phase-legend">
      <span><span className="phase-pip done">{STATE_GLYPH.done}</span> Done</span>
      <span><span className="phase-pip in-progress">{STATE_GLYPH.in_progress}</span> In progress</span>
      <span><span className="phase-pip not-started">{STATE_GLYPH.not_started}</span> Not started</span>
      <span style={{ color: 'var(--text-secondary)' }}>OSM &rarr; LM &rarr; CH (build order)</span>
    </div>
  );
}
