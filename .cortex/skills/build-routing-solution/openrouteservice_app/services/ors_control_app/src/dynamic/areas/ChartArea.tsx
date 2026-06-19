import { useMemo } from 'react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell,
} from 'recharts';
import type { ChartArea as ChartSpec } from '../spec-types';
import { useDataSource } from '../useDataSource';
import type { AreaComponentProps } from './types';

// Palette + axis styling lifted from the hand-coded dashboards so converted
// charts match their originals (Snowflake blue primary, neutral secondary).
const PALETTE = ['#29B5E8', '#FF6B35', '#3d4454', '#7D44CF', '#11A472', '#E8A317'];
const AXIS_TICK = { fill: '#6E7681', fontSize: 11 };
const GRID_STROKE = 'rgba(0,0,0,0.06)';
const TOOLTIP_STYLE = { background: '#FFFFFF', border: '1px solid #E1E4E8', borderRadius: 8, fontSize: 12 };

export default function ChartArea({ area, scope, defaults }: AreaComponentProps) {
  const spec = area as ChartSpec;
  const { rows, loading } = useDataSource(spec.data, scope, defaults);
  const cfg = spec.config;

  // Reshape rows per config.map (rename + numeric coercion). Without a map,
  // coerce each series column to a number in place.
  const data = useMemo(() => {
    const seriesKeys = cfg.series.map((s) => s.dataKey);
    if (cfg.map) {
      const entries = Object.entries(cfg.map);
      return rows.map((r) => {
        const o: Record<string, any> = {};
        for (const [outKey, col] of entries) {
          const v = r[col];
          o[outKey] = outKey === cfg.xKey ? v : (v == null || v === '' ? null : Number(v));
        }
        return o;
      });
    }
    return rows.map((r) => {
      const o: Record<string, any> = { ...r, [cfg.xKey]: r[cfg.xKey] };
      for (const k of seriesKeys) o[k] = r[k] == null || r[k] === '' ? null : Number(r[k]);
      return o;
    });
  }, [rows, cfg]);

  const height = cfg.height ?? 250;
  const color = (i: number, c?: string) => c ?? PALETTE[i % PALETTE.length];

  if (loading) return <div className="chart-card-empty">Loading...</div>;

  let chart: React.ReactElement;
  switch (cfg.chartType) {
    case 'bar':
    case 'stackedBar': {
      const stackId = cfg.chartType === 'stackedBar' ? 'a' : undefined;
      const vertical = cfg.orientation === 'vertical';
      chart = (
        <BarChart data={data} layout={vertical ? 'vertical' : 'horizontal'}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          {vertical
            ? <><XAxis type="number" tick={AXIS_TICK} /><YAxis type="category" dataKey={cfg.xKey} width={120} tick={{ ...AXIS_TICK, fontSize: 10 }} /></>
            : <><XAxis dataKey={cfg.xKey} tick={AXIS_TICK} /><YAxis tick={AXIS_TICK} /></>}
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          {cfg.series.length > 1 && <Legend />}
          {cfg.series.map((s, i) => (
            <Bar key={s.dataKey} dataKey={s.dataKey} name={s.label ?? s.dataKey} stackId={stackId} radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} fill={color(i, s.color)}>
              {cfg.series.length === 1 && data.map((_, idx) => <Cell key={idx} fill={idx < 3 ? PALETTE[0] : PALETTE[2]} />)}
            </Bar>
          ))}
        </BarChart>
      );
      break;
    }
    case 'area':
      chart = (
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis dataKey={cfg.xKey} tick={AXIS_TICK} /><YAxis tick={AXIS_TICK} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          {cfg.series.length > 1 && <Legend />}
          {cfg.series.map((s, i) => (
            <Area key={s.dataKey} type="monotone" dataKey={s.dataKey} name={s.label ?? s.dataKey} stroke={color(i, s.color)} fill={color(i, s.color)} fillOpacity={0.25} />
          ))}
        </AreaChart>
      );
      break;
    case 'pie':
      chart = (
        <PieChart>
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          <Pie data={data} dataKey={cfg.series[0].dataKey} nameKey={cfg.xKey} cx="50%" cy="50%" outerRadius={Math.min(height / 2 - 10, 100)} label>
            {data.map((_, idx) => <Cell key={idx} fill={PALETTE[idx % PALETTE.length]} />)}
          </Pie>
        </PieChart>
      );
      break;
    case 'scatter':
      chart = (
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis type="number" dataKey={cfg.xKey} tick={AXIS_TICK} /><YAxis type="number" dataKey={cfg.series[0].dataKey} tick={AXIS_TICK} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          {cfg.series.map((s, i) => (
            <Scatter key={s.dataKey} data={data} dataKey={s.dataKey} name={s.label ?? s.dataKey} fill={color(i, s.color)} />
          ))}
        </ScatterChart>
      );
      break;
    case 'line':
    default:
      chart = (
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis dataKey={cfg.xKey} tick={AXIS_TICK} /><YAxis tick={AXIS_TICK} />
          <Tooltip contentStyle={TOOLTIP_STYLE} />
          {cfg.series.length > 1 && <Legend />}
          {cfg.series.map((s, i) => (
            <Line key={s.dataKey} type="monotone" dataKey={s.dataKey} name={s.label ?? s.dataKey} stroke={color(i, s.color)} strokeWidth={2} dot={false} />
          ))}
        </LineChart>
      );
  }

  return (
    <div className="chart-card">
      {spec.title && <h3>{spec.title}</h3>}
      <ResponsiveContainer width="100%" height={height}>
        {chart}
      </ResponsiveContainer>
    </div>
  );
}
