// GradeCard - a compact per-dimension report card for one scored (vehicle,
// load) pair. Each cell shows a dimension's letter grade colour-coded by
// quality, with the numeric 0-100 score on hover. Dimensions with no data
// render as a muted em-less dash.

import type { ScoredPair } from '../backload-ensemble';
import { DIMENSIONS, DIMENSION_LABELS, gradeColor } from '../backload-ensemble';

export default function GradeCard({ pair, compact = false, consolidationActive = true }: { pair: ScoredPair; compact?: boolean; consolidationActive?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${DIMENSIONS.length}, 1fr)`, gap: compact ? 3 : 4 }}>
      {DIMENSIONS.map((d) => {
        const grade = pair.grades[d];
        const score = pair.scores[d];
        const color = gradeColor(grade);
        const inactiveConsolidation = d === 'consolidation' && !consolidationActive && score == null;
        const title = inactiveConsolidation
          ? `${DIMENSION_LABELS[d]}: run Profit-max backhaul or Ensemble to grade multi-stop tours`
          : `${DIMENSION_LABELS[d]}: ${score == null ? 'no data' : Math.round(score) + '/100'}`;
        return (
          <div
            key={d}
            title={title}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
              padding: compact ? '2px 0' : '3px 0',
              border: '1px solid var(--border)', borderRadius: 4,
              background: grade ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent',
            }}
          >
            <span style={{ fontSize: compact ? 11 : 13, fontWeight: 700, color, lineHeight: 1 }}>{grade ?? '-'}</span>
            {!compact && (
              <span style={{ fontSize: 8, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.2 }}>
                {DIMENSION_LABELS[d].split(' ')[0]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
