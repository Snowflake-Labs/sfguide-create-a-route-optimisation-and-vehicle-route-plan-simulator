// WeightSliders - a collapsible panel of one 0-100 slider per grading
// dimension plus named presets, letting the dispatcher tune how the ensemble
// composite is weighted. Changes apply live: the parent re-ranks the already
// scored pairs client-side with no server round-trip.

import type { EnsembleWeights, EnsembleDimension } from '../backload-ensemble';
import { DIMENSIONS, DIMENSION_LABELS, DIMENSION_HELP, WEIGHT_PRESETS } from '../backload-ensemble';

interface Props {
  weights: EnsembleWeights;
  onChange: (w: EnsembleWeights) => void;
  open: boolean;
  onToggle: () => void;
  // False when no proposal carries a consolidation score (no Profit-max /
  // Ensemble run yet). The consolidation slider is then disabled + dimmed.
  consolidationActive?: boolean;
}

const pct = (v: number) => Math.round((Number(v) || 0) * 100);

function activePreset(w: EnsembleWeights): string | null {
  for (const [name, preset] of Object.entries(WEIGHT_PRESETS)) {
    if (DIMENSIONS.every((d) => Math.abs((preset[d] ?? 0) - (w[d] ?? 0)) < 0.005)) return name;
  }
  return null;
}

const CONSOLIDATION_HINT =
  'Consolidation grades multi-stop tour depth - populated only by the Profit-max backhaul or Ensemble strategies. Run one of those to enable this dimension.';

export default function WeightSliders({ weights, onChange, open, onToggle, consolidationActive = true }: Props) {
  const current = activePreset(weights);
  const setDim = (d: EnsembleDimension, percent: number) =>
    onChange({ ...weights, [d]: Math.max(0, percent) / 100 });

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)' }}>
      <button
        type="button"
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', padding: '8px 12px', color: 'var(--text)', fontSize: 12, fontWeight: 600 }}
      >
        <span aria-hidden="true" style={{ fontSize: 10 }}>{open ? '\u25BC' : '\u25B6'}</span>
        Scoring weights
        <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>{current ? `\u00B7 ${current}` : '\u00B7 Custom'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {Object.keys(WEIGHT_PRESETS).map((name) => (
              <button
                key={name}
                type="button"
                className={`btn small ${current === name ? 'primary' : 'secondary'}`}
                onClick={() => onChange({ ...WEIGHT_PRESETS[name] })}
              >
                {name}
              </button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px' }}>
            {DIMENSIONS.map((d) => {
              const inactive = d === 'consolidation' && !consolidationActive;
              const labelColor = inactive ? 'var(--text-secondary)' : 'var(--text)';
              return (
                <label
                  key={d}
                  style={{ display: 'flex', flexDirection: 'column', gap: 2, opacity: inactive ? 0.55 : 1 }}
                  title={inactive ? CONSOLIDATION_HINT : DIMENSION_HELP[d]}
                >
                  <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: labelColor }}>
                    <span>{DIMENSION_LABELS[d]}{inactive ? ' \u00B7 needs Profit-max' : ''}</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' }}>{pct(weights[d])}</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    step={1}
                    value={pct(weights[d])}
                    disabled={inactive}
                    onChange={(e) => setDim(d, Number(e.target.value))}
                    style={{ width: '100%', accentColor: 'var(--accent)', cursor: inactive ? 'not-allowed' : 'pointer' }}
                  />
                </label>
              );
            })}
          </div>
          <p style={{ fontSize: 10, color: 'var(--text-secondary)', margin: '10px 0 0' }}>
            Weights are relative - the composite renormalizes over the dimensions each pair has data for, so a pair missing one dimension is not penalized.
          </p>
          {!consolidationActive && (
            <p style={{ fontSize: 10, color: 'var(--text-secondary)', margin: '6px 0 0' }}>{CONSOLIDATION_HINT}</p>
          )}
        </div>
      )}
    </div>
  );
}
