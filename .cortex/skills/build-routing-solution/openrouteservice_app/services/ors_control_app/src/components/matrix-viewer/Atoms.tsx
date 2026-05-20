// Small UI atoms reused inside MatrixViewer.

export function RoadFilterBadge({ on }: { on: boolean | undefined }) {
  if (!on) return null;
  return (
    <span
      title="Built with Road-Aware Filtering: only hexagons intersecting road segments were tessellated"
      style={{
        display: 'inline-block',
        marginLeft: 6,
        padding: '1px 6px',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: 'uppercase',
        color: '#3fb950',
        background: 'rgba(63, 185, 80, 0.12)',
        border: '1px solid rgba(63, 185, 80, 0.4)',
        borderRadius: 4,
        verticalAlign: 'middle',
      }}
    >
      road-aware
    </span>
  );
}

export function SegControl<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg-control">
      {options.map(o => (
        <button key={o.value} className={`seg-btn${value === o.value ? ' active' : ''}`} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
