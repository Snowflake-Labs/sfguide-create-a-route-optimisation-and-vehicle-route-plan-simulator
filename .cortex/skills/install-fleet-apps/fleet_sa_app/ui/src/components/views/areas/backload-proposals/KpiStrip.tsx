// Compact inline KPI strip for the Backload Proposals cockpit. One horizontal
// band of inline stats (ALLCAPS label + XL value + optional sub) with a single
// bottom rule, matching how Snowsight renders summary stats above a table.

export interface KpiStat {
  label: string;
  value: string | number;
  sub?: string;
}

export default function KpiStrip({ stats }: { stats: KpiStat[] }) {
  if (!stats.length) return null;
  return (
    <div className="kpi-strip">
      {stats.map((s, i) => (
        <div className="kpi-stat" key={i}>
          <span className="kpi-stat-label">{s.label}</span>
          <span className="kpi-stat-value">{s.value}</span>
          {s.sub && <span className="kpi-stat-sub">{s.sub}</span>}
        </div>
      ))}
    </div>
  );
}
