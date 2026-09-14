// Snowflake base theme for the inline Vega-Lite charts the agent produces.
//
// WHY A BASE AND NOT AN OVERRIDE. Three parties style one chart:
//   1. this theme            - the app's own look, the weakest voice
//   2. the agent's spec      - deliberate per-question encodings
//   3. the server template   - app/agent-spec.json `vega_template`, merged into
//                              the spec BEFORE it ever reaches this client
// Since (3) is already baked into the incoming spec, an override-style merge
// here would silently undo the agent's chosen sort, axis format and colours.
// So `mergeThemeUnder` puts the theme UNDERNEATH: every key the spec (or the
// server template) sets wins. That direction is load-bearing and is asserted by
// scripts/check_chart_rendering.py.
//
// The palette comes from lib/style-config.ts (app-config.json `style.chart`),
// the SAME source the dashboard charts read, so the app and the chat answer to
// the same question look alike and a palette change is one config edit.
//
// FONTS: generic families ONLY (sans-serif / serif / monospace). A named font is
// not installed in the server-side render container, and the agent is told the
// same rule in its chart_customization block - a mismatch here would make the
// in-app chart diverge from the one CoWork renders.

const FONT = 'sans-serif';

// Neutral tones matching the app's --text-secondary / --border-default fallbacks
// (message-part.tsx, view-chart.tsx). Concrete hex rather than CSS vars because
// Vega renders to canvas/SVG attributes and does not resolve var().
const INK = '#111827';
const INK_MUTED = '#6b7280';
const RULE = '#e5e7eb';

/** Sequential ramp for a quantitative colour channel (heatmaps, shaded rects).
 *  Light-to-Snowflake-blue, so it reads as one hue rather than a rainbow - the
 *  same instruction the map guidance gives. */
export const SEQUENTIAL_RAMP = [
  '#eaf7fd', '#b8e6f7', '#7cd3f0', '#29b5e8', '#1a88b4', '#11567f',
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Vega-Lite `config` for the given categorical palette.
 *
 * `mark`/`bar`/`line`/`arc`/`point` all get an explicit default colour. That is
 * not decoration: a single-series spec has no `color` channel for the palette
 * `range` to apply to, so without these a lone bar rendered in Vega's stock
 * `#4c78a8` - observed in a live turn, whose color_mapping reported exactly that
 * while the palette sat unused in the spec's encoding block.
 */
export function buildVegaTheme(palette: string[]): Record<string, unknown> {
  const primary = palette[0];
  return {
    background: 'transparent',
    font: FONT,
    padding: 4,
    title: { font: FONT, fontSize: 13, fontWeight: 600, color: INK, anchor: 'start', offset: 8 },
    axis: {
      labelFont: FONT, titleFont: FONT,
      labelFontSize: 11, titleFontSize: 12,
      labelColor: INK_MUTED, titleColor: INK_MUTED,
      gridColor: RULE, domainColor: RULE, tickColor: RULE,
      labelLimit: 160,
    },
    axisY: { grid: true, domain: false, ticks: false, titlePadding: 6 },
    axisX: { grid: false },
    legend: {
      labelFont: FONT, titleFont: FONT,
      labelFontSize: 11, titleFontSize: 12,
      labelColor: INK_MUTED, titleColor: INK_MUTED,
      symbolType: 'square', symbolSize: 64,
    },
    header: { labelFont: FONT, titleFont: FONT, labelFontSize: 11, titleFontSize: 12 },
    view: { stroke: null },
    mark: { font: FONT, color: primary, tooltip: true },
    bar: { fill: primary, cornerRadiusEnd: 2 },
    line: { stroke: primary, strokeWidth: 2 },
    area: { fill: primary, fillOpacity: 0.25, line: { stroke: primary, strokeWidth: 2 } },
    point: { fill: primary, filled: true, size: 48 },
    arc: { fill: primary, innerRadius: 0 },
    rect: { fill: primary },
    boxplot: { box: { fill: primary }, median: { color: '#ffffff' } },
    rule: { stroke: INK_MUTED },
    text: { font: FONT, fontSize: 11, fill: INK },
    range: {
      category: palette,
      ordinal: SEQUENTIAL_RAMP,
      ramp: SEQUENTIAL_RAMP,
      heatmap: SEQUENTIAL_RAMP,
    },
  };
}

/**
 * Deep-merge `theme` UNDER `spec`: a key present anywhere in the spec keeps the
 * spec's value, including when the spec's value is explicitly `null` (Vega-Lite
 * uses `null` meaningfully, e.g. `sort: null`, `view.stroke: null`).
 *
 * Arrays are NEVER merged element-wise - a spec array replaces the theme's
 * wholesale, so a spec-supplied `scale.range` of two colours does not inherit
 * six trailing theme colours.
 */
export function mergeThemeUnder<T extends Record<string, unknown>>(
  spec: T,
  theme: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...theme };
  for (const [k, specVal] of Object.entries(spec)) {
    const themeVal = out[k];
    if (isPlainObject(specVal) && isPlainObject(themeVal)) {
      out[k] = mergeThemeUnder(specVal, themeVal);
    } else {
      out[k] = specVal;
    }
  }
  return out as T;
}

/** Apply the theme to a parsed Vega-Lite spec, returning a new spec. */
export function themeSpec(
  spec: Record<string, unknown>,
  palette: string[],
): Record<string, unknown> {
  const config = isPlainObject(spec.config) ? spec.config : {};
  return { ...spec, config: mergeThemeUnder(config, buildVegaTheme(palette)) };
}
