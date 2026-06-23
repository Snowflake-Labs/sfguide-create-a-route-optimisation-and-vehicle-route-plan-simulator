'use client';

import { useMemo } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
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

const CHART_COLORS = [
  'var(--chart-1, #2563eb)',
  'var(--chart-2, #16a34a)',
  'var(--chart-3, #d97706)',
  'var(--chart-4, #dc2626)',
  'var(--chart-5, #7c3aed)',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
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
}

export function ViewChartArea({ areaConfig }: ViewChartAreaProps) {
  const { data, loading, error } = useViewData(areaConfig.data.query, areaConfig.data.params);
  const config = areaConfig.config;

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

  if (loading) {
    return (
      <div style={{ padding: '16px', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '100%', height: '200px', borderRadius: '8px', backgroundColor: 'var(--surface-secondary, #f3f4f6)', animation: 'pulse 2s ease-in-out infinite' }} />
      </div>
    );
  }

  if (error) {
    return <div style={{ padding: '16px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>;
  }

  if (!chartData.length && !groupedData) {
    return <div style={{ padding: '16px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No data</div>;
  }

  const hasBar = config.series.some((s) => s.type === 'bar' || s.type === 'stackedBar');
  const hasGroupBy = groupedData !== null;
  const hasPie = config.series.some((s) => s.type === 'pie');
  const hasScatter = config.series.some((s) => s.type === 'scatter');
  const hasArea = config.series.some((s) => s.type === 'area');

  if (hasPie) {
    const valueField = config.series[0].field;
    return (
      <div style={{ padding: '16px', height: '100%', minHeight: '250px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
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
      <div style={{ padding: '16px', height: '100%', minHeight: '250px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
            <XAxis type="number" dataKey={config.xAxis.field} name={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <YAxis type="number" dataKey={config.series[0].field} name={config.series[0].label} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {config.series.map((s, i) => (
              <Scatter key={s.field} name={s.label} data={chartData} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (hasArea) {
    return (
      <div style={{ padding: '16px', height: '100%', minHeight: '250px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
            <XAxis dataKey={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <YAxis fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {config.series.map((s, i) => (
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
      <div style={{ padding: '16px', height: '100%', minHeight: '250px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={groupedData.data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
            <XAxis dataKey={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <YAxis fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {groupedData.categories.map((cat, i) => (
              <Bar key={cat} dataKey={cat} stackId="a" fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  if (hasBar) {
    return (
      <div style={{ padding: '16px', height: '100%', minHeight: '250px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
            <XAxis dataKey={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <YAxis fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
            <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
            {config.series.map((s, i) => (
              <Bar key={s.field} dataKey={s.field} name={s.label} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div style={{ padding: '16px', height: '100%', minHeight: '250px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default, #e5e7eb)" />
          <XAxis dataKey={config.xAxis.field} fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
          <YAxis yAxisId="left" fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
          {config.series.some((s) => s.yAxis === 'right') && (
            <YAxis yAxisId="right" orientation="right" fontSize={11} tick={{ fill: 'var(--text-secondary, #6b7280)' }} />
          )}
          <Tooltip contentStyle={{ fontSize: '12px', borderRadius: '8px' }} />
          <Legend wrapperStyle={{ fontSize: '12px' }} />
          {config.series.map((s, i) => (
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
