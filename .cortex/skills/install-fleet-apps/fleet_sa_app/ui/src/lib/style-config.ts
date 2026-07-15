// Style-config resolver: the centralized design surface for the dashboard views
// (app-config.json "style" block, typed as StyleConfig). It defines the row-height
// tiers that app-views.json references via $tokens ($kpi/$content/$map/$heroMap),
// the chart palette, and table density defaults - so spacing, chart colors, and
// list lengths are one config edit, not scattered per-view literals.
//
// Two access paths mirror display-config.ts:
//   - useStyleConfig()        React hook (reads the zustand store) for components.
//   - getStyleConfigGlobal()  module mirror for non-React code paths.
// Every getter falls back to the bundled defaults below, so first paint, SSR, and
// a config without a "style" block all render identically to the legacy look.

import { useAppStore } from './store';
import type { StyleConfig } from './types';

// Row-height tiers (px). Derived from the two polished reference pages:
// Live Asset Operations (map row 420-440px) and Trip Inspector (kpi 96px).
export const DEFAULT_ROW_HEIGHTS: Record<string, number> = {
  kpi: 96,
  content: 360,
  map: 440,
  heroMap: 460,
};

// Snowflake-forward chart palette (cyan-led to match the deck.gl map styling).
export const DEFAULT_CHART_PALETTE: string[] = [
  '#29B5E8',
  '#11567F',
  '#16A34A',
  '#D97706',
  '#7C3AED',
  '#DC2626',
  '#06B6D4',
  '#EC4899',
];

export const DEFAULT_TABLE = { defaultMaxRows: 50, boardMaxRows: 100 };

// Module-level mirror, set alongside the store in app-shell so non-React code can
// read style without a hook.
let globalStyleConfig: StyleConfig | null = null;

export function setStyleConfigGlobal(cfg: StyleConfig | null | undefined): void {
  globalStyleConfig = cfg ?? null;
}

export function getStyleConfigGlobal(): StyleConfig | null {
  return globalStyleConfig;
}

// Resolve the row-height map (merge config over defaults).
export function resolveRowHeights(cfg: StyleConfig | null): Record<string, number> {
  return { ...DEFAULT_ROW_HEIGHTS, ...(cfg?.rowHeights ?? {}) };
}

// Resolve the chart palette (config or defaults; never empty).
export function resolveChartPalette(cfg: StyleConfig | null): string[] {
  const p = cfg?.chart?.palette;
  return p && p.length ? p : DEFAULT_CHART_PALETTE;
}

// Resolve the default table row cap (used when a table omits maxRows).
export function resolveDefaultMaxRows(cfg: StyleConfig | null): number {
  return cfg?.table?.defaultMaxRows ?? DEFAULT_TABLE.defaultMaxRows;
}

// React hook: the style config from the store (null until app-config loads).
export function useStyleConfig(): StyleConfig | null {
  return useAppStore((s) => s.styleConfig);
}
