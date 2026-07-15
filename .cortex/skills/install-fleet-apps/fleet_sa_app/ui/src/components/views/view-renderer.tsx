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
  MarkdownArea,
} from './areas';
import { EntityDetailArea } from './areas/entity-detail';
import { DetailPanelArea } from './areas/detail-panel';
import type { AreaComponentName } from '@/lib/area-components';
import { useStyleConfig, resolveRowHeights } from '@/lib/style-config';
import { useDisplayConfig, interpolateTokens } from '@/lib/display-config';

export interface AreaConfig {
  component: string;
  data: Record<string, unknown>;
  config?: Record<string, unknown>;
  emits?: Record<string, string>;
  // Optional area heading: renders a consistent header bar above the component.
  // Omit for areas that own their header (KPI cards, controls, detail panels).
  title?: string;
  subtitle?: string;
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
  Markdown: MarkdownArea,
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

// Resolve a rows string in two passes: first swap $tokens ($content/$map/...) for
// their pixel height from the style config, then expand any `fr` to a minmax so
// flexible rows keep a sensible minimum. Literal `auto`/`<n>px`/`<n>fr` pass through.
function resolveRows(rows: string, heights: Record<string, number>): string {
  const FR_BASE_PX = 200;
  return rows
    .split(/\s+/)
    .map((val) => {
      const tokenMatch = val.match(/^\$(\w+)$/);
      if (tokenMatch) {
        const px = heights[tokenMatch[1]];
        if (px != null) return `${px}px`;
        return 'auto';
      }
      const frMatch = val.match(/^(\d+(?:\.\d+)?)fr$/);
      if (frMatch) {
        return `minmax(${Math.round(Number(frMatch[1]) * FR_BASE_PX)}px, ${val})`;
      }
      return val;
    })
    .join(' ');
}

// Consistent area header bar rendered above charts/tables/maps when an area
// declares a `title`. Style language mirrors the polished metric cards
// (11px uppercase label, subtle bottom border).
function AreaHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div
      style={{
        flexShrink: 0,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-default, #e5e7eb)',
        display: 'flex',
        alignItems: 'baseline',
        gap: '8px',
        backgroundColor: 'var(--surface-primary, #fff)',
      }}
    >
      <span
        style={{
          fontSize: '11px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--text-secondary, #6b7280)',
        }}
      >
        {title}
      </span>
      {subtitle && (
        <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--text-tertiary, #9ca3af)' }}>
          {subtitle}
        </span>
      )}
    </div>
  );
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
  const styleConfig = useStyleConfig();
  const displayConfig = useDisplayConfig();
  const rowHeights = resolveRowHeights(styleConfig);
  const resolvedRows = resolveRows(layout.rows || 'auto', rowHeights);
  const allAreaNames = Object.keys(viewDef.areas);
  const areaNames = allAreaNames.filter((n) => !isDrawerArea(viewDef.areas[n]));
  const drawerAreaNames = allAreaNames.filter((n) => isDrawerArea(viewDef.areas[n]));
  const scrollableAreas = getScrollableAreas(layout.grid, resolvedRows);
  // When the layout has no flexible (fr) row, its rows are auto/fixed/token and the
  // grid sizes to content - taller than the viewport once an auto detail row
  // grows - so the view itself must scroll vertically. Views with an fr row
  // keep the current behavior (grid fills 100% height, fr areas scroll inside).
  // $tokens resolve to fixed px, so a token-only layout opts into page scroll.
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
        gridTemplateRows: resolvedRows,
        gridTemplateAreas: parseGridTemplate(layout.grid),
        gap: '1px',
        height: hasFlexRow ? '100%' : 'auto',
        minHeight: hasFlexRow ? undefined : '100%',
        // Without a flexible (fr) row the grid is forced to minHeight:100% but its
        // fixed/auto rows don't fill it; the grid default (align-content:stretch)
        // would then balloon the auto rows (e.g. KPI), opening a gap before the
        // content. Pack rows at the top so free space collapses to the bottom.
        alignContent: hasFlexRow ? undefined : 'start',
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
        // Header source: explicit area title, else a chart's config.title (so every
        // titled chart gets a consistent header bar without per-area JSON edits).
        const rawTitle =
          areaConfig.title ?? (areaConfig.config as { title?: string } | undefined)?.title;
        const headerTitle = rawTitle ? interpolateTokens(rawTitle, displayConfig) : null;
        const headerSubtitle = areaConfig.subtitle
          ? interpolateTokens(areaConfig.subtitle, displayConfig)
          : undefined;
        const scrolls = scrollableAreas.has(areaName);
        return (
          <div
            key={areaName}
            style={{
              gridArea: areaName,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
              backgroundColor: 'var(--surface-primary, #fff)',
            }}
          >
            {headerTitle && <AreaHeader title={headerTitle} subtitle={headerSubtitle} />}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflow: noPad ? 'hidden' : scrolls ? 'auto' : 'visible',
                padding: noPad ? '0' : '16px',
              }}
            >
              <Component areaConfig={areaConfig} selectionKeys={selectionKeys} />
            </div>
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
