'use client';

// Inline chart for Cortex `data_to_chart` results in chat.
//
// cortex-stream.ts has always emitted a `render_chart` part for the
// `response.chart` event, and nothing was registered for it - so every
// data_to_chart call rendered as a collapsed "Tool result" JSON blob. This
// closes that.
//
// The payload is a Vega-Lite spec STRING. The app carries recharts and no vega
// runtime, and pulling in vega + vega-embed for this one surface would add
// megabytes to the SPCS image, so the common Cortex shapes (bar / line / area /
// point over inline `data.values`) are mapped onto recharts instead. Anything
// outside that is reported as unsupported and the underlying rows are shown
// rather than swallowed - a chart we cannot draw must not become an empty card.

import { useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, AreaChart, Area,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useStyleConfig, resolveChartPalette } from '@/lib/style-config';
import { DataTable } from './data-table';

type Row = Record<string, unknown>;

interface ParsedChart {
  kind: 'bar' | 'line' | 'area' | 'point';
  rows: Row[];
  xField: string;
  yFields: string[];
  title?: string;
}

/** Vega-Lite mark names Cortex emits, mapped onto the recharts equivalents. */
const MARK_MAP: Record<string, ParsedChart['kind']> = {
  bar: 'bar',
  line: 'line',
  area: 'area',
  point: 'point',
  circle: 'point',
  square: 'point',
  tick: 'point',
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fieldOf(channel: unknown): string | undefined {
  if (!isObject(channel)) return undefined;
  const f = channel.field;
  return typeof f === 'string' && f !== '' ? f : undefined;
}

/**
 * Best-effort Vega-Lite -> recharts translation. Returns null (with a reason)
 * when the spec is outside the supported subset, so the caller can fall back to
 * showing the data instead of silently rendering nothing.
 */
function parseChartSpec(raw: unknown): { chart: ParsedChart } | { reason: string; rows: Row[] } {
  let spec: unknown = raw;
  if (typeof raw === 'string') {
    try {
      spec = JSON.parse(raw);
    } catch (e) {
      return { reason: `chart spec is not valid JSON: ${(e as Error).message}`, rows: [] };
    }
  }
  if (!isObject(spec)) return { reason: 'chart spec is not an object', rows: [] };

  const data = spec.data;
  const values = isObject(data) ? data.values : undefined;
  const rows: Row[] = Array.isArray(values) ? (values as Row[]).filter(isObject) : [];

  // A layered / faceted / concatenated spec has no single mark+encoding pair.
  const markRaw = spec.mark;
  const markName = typeof markRaw === 'string'
    ? markRaw
    : isObject(markRaw) && typeof markRaw.type === 'string'
      ? markRaw.type
      : undefined;
  if (!markName) return { reason: 'this chart type is not supported inline (layered or faceted spec)', rows };
  const kind = MARK_MAP[markName];
  if (!kind) return { reason: `chart mark '${markName}' is not supported inline`, rows };

  const enc = spec.encoding;
  if (!isObject(enc)) return { reason: 'chart spec has no encoding block', rows };
  const xField = fieldOf(enc.x);
  const yField = fieldOf(enc.y);
  if (!xField || !yField) return { reason: 'chart spec has no x/y field encoding', rows };
  if (rows.length === 0) return { reason: 'chart spec carries no inline data', rows };

  // A `color` channel splits one y measure into a series per category. Pivot it
  // so recharts sees one dataKey per series, matching view-chart's grouped form.
  const colorField = fieldOf(enc.color);
  const title = typeof spec.title === 'string' ? spec.title : undefined;

  if (colorField && colorField !== xField) {
    const cats = Array.from(new Set(rows.map((r) => String(r[colorField] ?? '')))).filter(Boolean);
    const byX = new Map<string, Row>();
    for (const r of rows) {
      const xv = String(r[xField] ?? '');
      const bucket = byX.get(xv) ?? { [xField]: r[xField] };
      bucket[String(r[colorField] ?? '')] = r[yField];
      byX.set(xv, bucket);
    }
    return { chart: { kind, rows: Array.from(byX.values()), xField, yFields: cats, title } };
  }

  return { chart: { kind, rows, xField, yFields: [yField], title } };
}

const AXIS_STYLE = { fontSize: 11 };

export function ChartInline(props: Record<string, unknown>) {
  const palette = resolveChartPalette(useStyleConfig());
  const parsed = useMemo(() => parseChartSpec(props.chartSpec ?? props.chart_spec ?? props), [props]);

  if ('reason' in parsed) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>{parsed.reason}</div>
        {parsed.rows.length ? (
          <DataTable
            columns={Object.keys(parsed.rows[0] as Row).map((k) => ({ key: k, label: k }))}
            rows={parsed.rows}
            totalRows={parsed.rows.length}
          />
        ) : null}
      </div>
    );
  }

  const { kind, rows, xField, yFields, title } = parsed.chart;
  const color = (i: number) => palette[i % palette.length];

  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
      <XAxis dataKey={xField} tick={AXIS_STYLE} />
      <YAxis tick={AXIS_STYLE} />
      <Tooltip />
      {yFields.length > 1 ? <Legend wrapperStyle={AXIS_STYLE} /> : null}
    </>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {title ? (
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>{title}</div>
      ) : null}
      <div style={{ width: '100%', height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          {kind === 'bar' ? (
            <BarChart data={rows}>
              {axes}
              {yFields.map((f, i) => (
                <Bar key={f} dataKey={f} name={f} fill={color(i)} />
              ))}
            </BarChart>
          ) : kind === 'area' ? (
            <AreaChart data={rows}>
              {axes}
              {yFields.map((f, i) => (
                <Area key={f} type="monotone" dataKey={f} name={f} stroke={color(i)} fill={color(i)} fillOpacity={0.25} />
              ))}
            </AreaChart>
          ) : kind === 'point' ? (
            <ScatterChart data={rows}>
              {axes}
              {yFields.map((f, i) => (
                <Scatter key={f} dataKey={f} name={f} fill={color(i)} />
              ))}
            </ScatterChart>
          ) : (
            <LineChart data={rows}>
              {axes}
              {yFields.map((f, i) => (
                <Line key={f} type="monotone" dataKey={f} name={f} stroke={color(i)} dot={false} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
