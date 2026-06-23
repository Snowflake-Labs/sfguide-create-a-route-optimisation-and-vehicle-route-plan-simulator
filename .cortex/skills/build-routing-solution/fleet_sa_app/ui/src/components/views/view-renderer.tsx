'use client';

import {
  MetricCardsArea,
  ViewChartArea,
  ViewTableArea,
  ViewComboBoxArea,
  ViewFilterBarArea,
  ViewMapArea,
  ViewSliderArea,
  ViewClickableTableArea,
  ViewCheckboxArea,
} from './areas';
import { EntityDetailArea } from './areas/entity-detail';

export interface AreaConfig {
  component: string;
  data: Record<string, unknown>;
  config?: Record<string, unknown>;
  emits?: Record<string, string>;
}

export interface ViewLayout {
  columns: string;
  rows?: string;
  grid: string;
}

export interface ParsedViewDef {
  id: string;
  label: string;
  description: string;
  layout: {
    default: ViewLayout;
    tablet?: ViewLayout;
    mobile?: ViewLayout;
  };
  areas: Record<string, AreaConfig>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAreaComponent = React.ComponentType<any>;

const AREA_COMPONENTS: Record<string, AnyAreaComponent> = {
  MetricCards: MetricCardsArea,
  Chart: ViewChartArea,
  Table: ViewTableArea,
  ComboBox: ViewComboBoxArea,
  FilterBar: ViewFilterBarArea,
  Map: ViewMapArea,
  Slider: ViewSliderArea,
  ClickableTable: ViewClickableTableArea,
  Checkbox: ViewCheckboxArea,
  EntityDetail: EntityDetailArea,
};

function parseGridTemplate(grid: string): string {
  const lines = grid.trim().split('\n');
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('"')) return trimmed;
      return `"${trimmed}"`;
    })
    .join(' ');
}

function resolveRows(rows: string): string {
  const FR_BASE_PX = 200;
  return rows
    .split(/\s+/)
    .map((val) => {
      const frMatch = val.match(/^(\d+(?:\.\d+)?)fr$/);
      if (frMatch) {
        return `minmax(${Math.round(Number(frMatch[1]) * FR_BASE_PX)}px, ${val})`;
      }
      return val;
    })
    .join(' ');
}

interface ViewRendererProps {
  viewDef: ParsedViewDef;
}

function getScrollableAreas(grid: string, rows: string): Set<string> {
  const rowTokens = rows.split(/\s+/);
  const gridLines = grid.trim().split('\n');
  const scrollable = new Set<string>();
  gridLines.forEach((line, rowIdx) => {
    const rowSpec = rowTokens[rowIdx] || 'auto';
    if (/fr/.test(rowSpec)) {
      const areas = line.replace(/"/g, '').trim().split(/\s+/);
      areas.forEach((a) => scrollable.add(a));
    }
  });
  return scrollable;
}

export function ViewRenderer({ viewDef }: ViewRendererProps) {
  const layout = viewDef.layout.default;
  const areaNames = Object.keys(viewDef.areas);
  const scrollableAreas = getScrollableAreas(layout.grid, layout.rows || 'auto');

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: layout.columns,
        gridTemplateRows: resolveRows(layout.rows || 'auto'),
        gridTemplateAreas: parseGridTemplate(layout.grid),
        gap: '1px',
        height: '100%',
        backgroundColor: 'var(--border-default, #e5e7eb)',
      }}
    >
      {areaNames.map((areaName) => {
        const areaConfig = viewDef.areas[areaName];
        const Component = AREA_COMPONENTS[areaConfig.component];

        if (!Component) {
          return (
            <div key={areaName} style={{ gridArea: areaName, padding: '16px', backgroundColor: 'var(--surface-primary, #fff)' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary, #6b7280)' }}>
                Unknown component: {areaConfig.component}
              </span>
            </div>
          );
        }

        const noPad = areaConfig.config?.noPad === true;
        return (
          <div
            key={areaName}
            style={{
              gridArea: areaName,
              overflow: noPad ? 'hidden' : (scrollableAreas.has(areaName) ? 'auto' : 'visible'),
              backgroundColor: 'var(--surface-primary, #fff)',
              padding: noPad ? '0' : '16px',
            }}
          >
            <Component areaConfig={areaConfig} />
          </div>
        );
      })}
    </div>
  );
}
