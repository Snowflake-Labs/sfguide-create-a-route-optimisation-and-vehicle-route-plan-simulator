'use client';

import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  ComposedChart,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { useViewData } from '@/hooks/use-view-data';
import { useStyleConfig, resolveChartPalette } from '@/lib/style-config';
import { useDisplayConfig, interpolateTokens } from '@/lib/display-config';
import { buildChartMemo, useAgentMemo } from '@/lib/agent-memo';
import { chartPlotDiagnostic } from '@/lib/chart-encodings';
import { formatNumber, formatCellValue } from '@/lib/format-number';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';
// Axis ticks and tooltips had NO formatter at all, so a FLOAT metric printed its
// full binary expansion on hover. Both go through the shared decimal policy; the
// tooltip passes the series name as the column so a coordinate axis keeps 5dp.
const numericTick = (v: unknown) => formatNumber(v, { compact: true, grouping: true }) ?? String(v ?? '');
const tooltipFormatter = (value: unknown, name: unknown): [string, string] => [
  formatCellValue(value, { column: name == null ? undefined : String(name), grouping: true }),
  String(name ?? ''),
];


interface SeriesConfig {
  type: string;
  field: string;
  label: string;
  color?: string;
  yAxis?: string;
  groupBy?: string;
}

interface ChartConfig {
  xAxis: { field: string; fieldType: string };
  series: SeriesConfig[];
}

interface ViewChartAreaProps {
  areaConfig: {
    data: {
      query: string;
      params?: Record<string, string>;
    };
    config: ChartConfig;
  };
  // The area's own key in the view layout, supplied by the renderer. Namespaces
  // this chart's agent memo so sibling charts in one view do not clobber it.
  areaName?: string;
}

export function ViewChartArea({ areaConfig, areaName }: ViewChartAreaProps) {
  const { data, loading, error, suspended, refetch } = useViewData(areaConfig.data.query, areaConfig.data.params);
  const config = areaConfig.config;
  // Chart palette comes from the centralized style config (app-config.json),
  // falling back to the bundled Snowflake-forward defaults.
  const CHART_COLORS = resolveChartPalette(useStyleConfig());
  const display = useDisplayConfig();

  // Series labels carry the same neutral {{labels.x}} / {{units.x}} tokens as
  // every other authored string, but only the area TITLE was ever interpolated
  // (view-renderer does that). So a titled chart read correctly while its legend
  // and tooltip printed the raw token - e.g. "{{labels.operator_plural}}: 32".
  // Resolved once here and used for every display name below; `field` is never
  // touched, so data binding is unaffected.
  const series = useMemo(
    () => config.series.map((s) => ({ ...s, label: interpolateTokens(s.label, display) })),
    [config.series, display],
  );

  const chartData = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows.map((row) => {
      const point: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        point[key] = typeof value === 'string' && !isNaN(Number(value)) ? Number(value) : value;
      }
      return point;
    });
  }, [data]);

  const groupedData = useMemo(() => {
    const groupBySeries = config.series.find((s) => s.groupBy);
    if (!groupBySeries || !data?.rows) return null;

    const grouped = new Map<string, Map<string, number>>();
    const categories = new Set<string>();

    for (const row of data.rows) {
      const xVal = String(row[config.xAxis.field] ?? '');
      const group = String(row[groupBySeries.groupBy!] ?? '');
      const val = Number(row[groupBySeries.field] ?? 0);
      categories.add(group);

      if (!grouped.has(xVal)) grouped.set(xVal, new Map());
      grouped.get(xVal)!.set(group, (grouped.get(xVal)!.get(group) || 0) + val);
    }

    const points: Record<string, unknown>[] = [];
    for (const [x, groups] of grouped) {
      const point: Record<string, unknown> = { [config.xAxis.field]: x };
      for (const cat of categories) {
        point[cat] = groups.get(cat) || 0;
      }
      points.push(point);
    }

    return { data: points, categories: Array.from(categories) };
  }, [data, config]);

  // A chart needs ComposedChart when its series disagree about mark type, or
  // when one of them is pinned to the second axis.
  //
  // Neither was honoured before. `hasBar` is a some(), so the bar branch won for
  // ANY config containing a bar and then mapped EVERY series to <Bar> - an
  // authored `type: "line"` was never a line. And `yAxis` was read only by
  // <Line> in the line-only branch, so it was a silent no-op everywhere else.
  // Together that put a headcount series on a currency axis: measured 19,340 vs
  // 22 on one week of the labor view, a bar 0.1% of plot height - drawn,
  // hit-testable, invisible.
  //
  // Computed here, above the early returns, because `kindOf()` in the agent memo
  // must name the SAME branch the renderer takes; two copies of this expression
  // would drift and the memo would describe a chart that is not on screen.
  // Excludes a grouped chart: its value columns are category VALUES derived from
  // one series, so per-series type and axis have nothing to bind to.
  const isCombo = useMemo(() => {
    if (groupedData) return false;
    const types = new Set(config.series.map((s) => s.type));
    return types.size > 1 || config.series.some((s) => s.yAxis === 'right');
  }, [config.series, groupedData]);

  // Checked against the raw rows, not chartData/groupedData: a grouped chart's
  // point keys are category values, so the derived shape cannot distinguish a
  // missing column from an absent category. Must sit above the early returns to
  // keep hook order stable.
  const undrawable = useMemo(
    () => chartPlotDiagnostic({
      xField: config.xAxis.field,
      valueFields: config.series.map((s) => s.field),
      groupBy: config.series.find((s) => s.groupBy)?.groupBy,
      rows: data?.rows ?? [],
    }),
    [config, data],
  );

  // Agent grounding: a chart publishes no readable numbers anywhere else, and its
  // shape IS the finding ("which site is worst", "is this trending up"), so
  // summarize what is plotted. Chart-kind precedence mirrors the render branches
  // below exactly (pie, scatter, area, grouped stacked bar, bar, else line) so the
  // memo never claims a different chart than the one on screen.
  useAgentMemo(
    areaName,
    useMemo(() => {
      const kindOf = (): string => {
        if (config.series.some((s) => s.type === 'pie')) return 'pie';
        if (config.series.some((s) => s.type === 'scatter')) return 'scatter';
        if (config.series.some((s) => s.type === 'area')) return 'area';
        if (groupedData) return 'stacked bar';
        // Mirrors the ComposedChart branch, which sits between the grouped and
        // bar branches in the render dispatch below. Names the marks actually
        // drawn rather than collapsing to 'bar', so the memo cannot claim a
        // single-axis bar chart where two scales are plotted.
        if (isCombo) return `combo (${Array.from(new Set(config.series.map((s) => s.type))).join(' + ')})`;
        if (config.series.some((s) => s.type === 'bar' || s.type === 'stackedBar')) return 'bar';
        return 'line';
      };
      const points = groupedData ? groupedData.data : chartData;
      if (!points.length) return '';
      // buildChartMemo drops the memo entirely when the plotted columns are not on
      // the points - `points` is non-empty in that case (chartData copies every row
      // verbatim), so an empty plot would otherwise be described as a real series.
      // A grouped chart's yKey is a category VALUE, not a column, hence the flag.
      return buildChartMemo({
        chartType: kindOf(),
        xKey: config.xAxis.field,
        // A grouped chart has one value column per category, so report the first
        // category as the y key and name the rest as series.
        yKey: groupedData ? (groupedData.categories[0] ?? config.series[0].field) : config.series[0].field,
        yKeyIsColumn: !groupedData,
        points,
        seriesNames: groupedData
          ? groupedData.categories
          : series
              // A dual-axis chart plots two SCALES, and the memo reports one
              // yKey plus these names - so without the axis said out loud the
              // agent reads 19,340 and 22 as comparable magnitudes on one axis.
              .map((s) => (s.yAxis === 'right' && isCombo ? `${s.label} (right axis)` : s.label))
              .filter(Boolean),
      });
    }, [chartData, groupedData, config, series, isCombo]),
    'chart',
  );

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
        <div style={{ width: '100%', height: '100%', borderRadius: '8px', backgroundColor: 'var(--surface-secondary, #f3f4f6)', animation: 'pulse 2s ease-in-out infinite' }} />
      </div>
    );
  }

  if (suspended) {
    return <RoutingSuspendedNotice info={suspended} onRetry={refetch} compact />;
  }

  if (error) {
    return <div style={{ color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>;
  }

  if (!chartData.length && !groupedData) {
    return <div style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No data</div>;
  }

  // Rows arrived but no series column is on them, so recharts would render axes
  // with no marks and no explanation - indistinguishable from an empty filter.
  // Say which column was looked for instead, the same way the maps now do.
  if (undrawable) {
    return (
      <div style={{ color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>
        This chart returned data it could not plot. {undrawable}
      </div>
    );
  }

  const hasBar = config.series.some((s) => s.type === 'bar' || s.type === 'stackedBar');
  const hasGroupBy = groupedData !== null;
  const hasPie = config.series.some((s) => s.type === 'pie');
  const hasScatter = config.series.some((s) => s.type === 'scatter');
  const hasArea = config.series.some((s) => s.type === 'area');

  if (hasPie) {
    const valueField = config.series[0].field;
    return (
      <div style={{ height: '100%', minHeight: '220px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip formatter={tooltipFormatter} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            <Pie data={chartData} dataKey={valueField} nameKey={config.xAxis.field} outerRadius="80%" label>
              {chartData.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (hasScatter) {
    return (
      <div style={{ height: '100%', minHeight: '220px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
            <XAxis type="number" dataKey={config.xAxis.field} name={config.xAxis.field} fontSize={11} tickFormatter={numericTick} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <YAxis type="number" dataKey={series[0].field} name={series[0].label} fontSize={11} tickFormatter={numericTick} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={tooltipFormatter} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {series.map((s, i) => (
              <Scatter key={s.field} name={s.label} data={chartData} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (hasArea) {
    return (
      <div style={{ height: '100%', minHeight: '220px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
            <XAxis dataKey={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <YAxis fontSize={11} tickFormatter={numericTick} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <Tooltip formatter={tooltipFormatter} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {series.map((s, i) => (
              <Area
                key={s.field}
                type="monotone"
                dataKey={s.field}
                name={s.label}
                stroke={CHART_COLORS[i % CHART_COLORS.length]}
                fill={CHART_COLORS[i % CHART_COLORS.length]}
                fillOpacity={0.25}
                stackId={config.series.length > 1 ? 'a' : undefined}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (hasGroupBy && groupedData) {
    return (
      <div style={{ height: '100%', minHeight: '220px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={groupedData.data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
            <XAxis dataKey={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <YAxis fontSize={11} tickFormatter={numericTick} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <Tooltip formatter={tooltipFormatter} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {groupedData.categories.map((cat, i) => (
              <Bar key={cat} dataKey={cat} stackId="a" fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (isCombo) {
    // Every mark carries an explicit yAxisId. Recharts drops a series whose
    // yAxisId matches no mounted axis, so omitting it on the left-axis marks
    // (or mounting only the right axis) empties the plot rather than erroring.
    const axisLabel = (side: 'left' | 'right') => {
      const owned = series.filter((s) => (s.yAxis === 'right' ? 'right' : 'left') === side);
      return owned.length === 1 ? owned[0].label : undefined;
    };
    const hasRightAxis = series.some((s) => s.yAxis === 'right');
    return (
      <div style={{ height: '100%', minHeight: '220px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
            <XAxis dataKey={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <YAxis
              yAxisId="left"
              fontSize={11}
              tickFormatter={numericTick}
              tick={{ fill: 'var(--text-secondary, #6b7280)' }}
              label={axisLabel('left') ? { value: axisLabel('left'), angle: -90, position: 'insideLeft', fontSize: 11, fill: 'var(--text-secondary, #6b7280)', style: { textAnchor: 'middle' } } : undefined}
            />
            {/* Two axes with no labels is differently misleading, not fixed: the
                reader cannot tell which scale a mark belongs to. Labelled only
                when exactly one series owns the axis, since a shared axis has no
                single name to give it. */}
            {hasRightAxis && (
              <YAxis
                yAxisId="right"
                orientation="right"
                fontSize={11}
                tickFormatter={numericTick}
                tick={{ fill: 'var(--text-secondary, #6b7280)' }}
                label={axisLabel('right') ? { value: axisLabel('right'), angle: 90, position: 'insideRight', fontSize: 11, fill: 'var(--text-secondary, #6b7280)', style: { textAnchor: 'middle' } } : undefined}
              />
            )}
            <Tooltip formatter={tooltipFormatter} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {series.map((s, i) => {
              const axisId = s.yAxis === 'right' ? 'right' : 'left';
              const color = CHART_COLORS[i % CHART_COLORS.length];
              if (s.type === 'line') {
                return (
                  <Line key={s.field} type="monotone" dataKey={s.field} name={s.label} stroke={color} yAxisId={axisId} dot={false} strokeWidth={2} />
                );
              }
              if (s.type === 'area') {
                return (
                  <Area key={s.field} type="monotone" dataKey={s.field} name={s.label} stroke={color} fill={color} fillOpacity={0.25} yAxisId={axisId} />
                );
              }
              // Unknown types keep the previous behaviour (a bar), so adding a
              // mark type to app-views.json degrades rather than blanks the chart.
              return <Bar key={s.field} dataKey={s.field} name={s.label} fill={color} yAxisId={axisId} />;
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (hasBar) {
    return (
      <div style={{ height: '100%', minHeight: '220px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
            <XAxis dataKey={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <YAxis fontSize={11} tickFormatter={numericTick} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <Tooltip formatter={tooltipFormatter} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {series.map((s, i) => (
              <Bar key={s.field} dataKey={s.field} name={s.label} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', minHeight: '220px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
          <XAxis dataKey={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
          <YAxis yAxisId="left" fontSize={11} tickFormatter={numericTick} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
          {config.series.some((s) => s.yAxis === 'right') && (
            <YAxis yAxisId="right" orientation="right" fontSize={11} tickFormatter={numericTick} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
          )}
          <Tooltip formatter={tooltipFormatter} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
          <Legend wrapperStyle={{ fontSize: '12px' }} />
          {series.map((s, i) => (
            <Line
              key={s.field}
              type="monotone"
              dataKey={s.field}
              name={s.label}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              yAxisId={s.yAxis === 'right' ? 'right' : 'left'}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
