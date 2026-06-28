'use client';

import { useMemo } from 'react';
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
import { DetailPanelArea } from './areas/detail-panel';
import type { AreaComponentName } from '@/lib/area-components';

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

// Area component names live in a lightweight, React-free module so the dynamic
// spec validator can import them without the renderer's component tree. The
// explicit Record<AreaComponentName, ...> annotation makes this map exhaustive
// over the name list (a missing key is a compile error).
const AREA_COMPONENTS: Record<AreaComponentName, AnyAreaComponent> = {
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
  DetailPanel: DetailPanelArea,
};

// An area pinned as a slide-over drawer (config.position === 'drawer') renders
// OUTSIDE the CSS grid: it positions itself absolutely over the view and is
// shown/hidden by its own selection state, so it never consumes a grid cell.
function isDrawerArea(areaConfig: AreaConfig): boolean {
  return (areaConfig.config as { position?: string } | undefined)?.position === 'drawer';
}

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
    if (/fr|px/.test(rowSpec)) {
      const areas = line.replace(/"/g, '').trim().split(/\s+/);
      areas.forEach((a) => scrollable.add(a));
    }
  });
  return scrollable;
}

export function ViewRenderer({ viewDef }: ViewRendererProps) {
  const layout = viewDef.layout.default;
  const allAreaNames = Object.keys(viewDef.areas);
  const areaNames = allAreaNames.filter((n) => !isDrawerArea(viewDef.areas[n]));
  const drawerAreaNames = allAreaNames.filter((n) => isDrawerArea(viewDef.areas[n]));
  const scrollableAreas = getScrollableAreas(layout.grid, layout.rows || 'auto');
  // When the layout has no flexible (fr) row, its rows are auto/fixed and the
  // grid sizes to content - taller than the viewport once an auto detail row
  // grows - so the view itself must scroll vertically. Views with an fr row
  // keep the current behavior (grid fills 100% height, fr areas scroll inside).
  const hasFlexRow = /\bfr\b/.test(layout.rows ?? 'auto');

  // viewState keys that represent a user selection (emit-type "selection" from a
  // ClickableTable / ComboBox), as opposed to filters (Slider / Checkbox emit "").
  // Passed to Map areas so they can focus the camera on the selected object.
  // Memoized so its identity is stable across renders (Map areas use it in effect
  // deps; a fresh array each render would re-trigger their fetch effects).
  const selectionKeys = useMemo(
    () =>
      Array.from(
        new Set(
          Object.values(viewDef.areas).flatMap((a) =>
            Object.entries(a.emits ?? {})
              .filter(([, emitType]) => emitType === 'selection')
              .map(([key]) => key),
          ),
        ),
      ),
    [viewDef],
  );

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0, overflowY: hasFlexRow ? undefined : 'auto' }}>
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: layout.columns,
        gridTemplateRows: resolveRows(layout.rows || 'auto'),
        gridTemplateAreas: parseGridTemplate(layout.grid),
        gap: '1px',
        height: hasFlexRow ? '100%' : 'auto',
        minHeight: hasFlexRow ? undefined : '100%',
        backgroundColor: 'var(--border-default, #e5e7eb)',
      }}
    >
      {areaNames.map((areaName) => {
        const areaConfig = viewDef.areas[areaName];
        const Component = AREA_COMPONENTS[areaConfig.component as AreaComponentName];

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
            <Component areaConfig={areaConfig} selectionKeys={selectionKeys} />
          </div>
        );
      })}
    </div>
      {/* Drawer-positioned areas render over the grid, not inside a grid cell. */}
      {drawerAreaNames.map((areaName) => {
        const areaConfig = viewDef.areas[areaName];
        const Component = AREA_COMPONENTS[areaConfig.component as AreaComponentName];
        if (!Component) return null;
        return (
          <Component key={areaName} areaConfig={areaConfig} selectionKeys={selectionKeys} />
        );
      })}
    </div>
  );
}
