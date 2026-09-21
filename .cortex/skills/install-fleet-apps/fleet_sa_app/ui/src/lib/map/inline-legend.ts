// Derives an inline map's legend from the colour encoding the compiler will
// actually draw, and synthesizes a tooltip template when the agent omitted one.
//
// Why derive rather than trust the spec. `render_map` let the agent author a
// `legend` array, which shipped as a labelled key that had nothing to do with
// the map beside it: the observed spec (kept verbatim as OBSERVED_SPEC in
// fleet_tools/user/verify_map_spec.mts) carried an h3 layer with NO `colorScale`
// plus a legend of #ffffcc / #fd8d3c / #800026 "Low / Medium / High dwell". The
// compiler has no way to know about those colours, so it lerped its own default
// blue ramp and the user got blue hexes under a yellow-to-red key with no
// numbers on it. An LLM cannot know the compiler's defaults, and it certainly
// cannot know the data's min/max, so any hand-authored key is a guess. The
// encoding plus the rows it was compiled from are the only honest source.
//
// This module is deliberately PURE - types only, no deck.gl, no React - because
// verify_map_spec.mts runs under tsx, where any transitive @deck.gl import dies
// inside @luma.gl/shadertools. That is also why the compiler defaults are
// re-declared here instead of imported from @fleet-kit/core/map: importing them
// would pull the deck.gl layer classes. The harness closes the drift that
// duplication opens by reading the compiler SOURCE and asserting the numbers
// match.

import type {
  LayerSpec, LegendItem, ColorRGBA, ColorValue,
  ScatterplotLayerSpec, PathLayerSpec, H3HexagonLayerSpec, GeoJsonLayerSpec, ArcLayerSpec,
} from '@/lib/map/layer-spec';
import { MAX_LEGEND_ITEMS } from '@/lib/map-spec-schema';

/** Compiler fallbacks, mirrored from packages/fleet-kit/src/map/layer-compiler.ts.
 *  A legend swatch has to show what is DRAWN, so when a layer omits its colour
 *  these are the colours the legend must report. Kept in step with the compiler
 *  by an assertion in verify_map_spec.mts that greps the compiler source. */
export const COMPILER_DEFAULTS = {
  /** H3HexagonLayer `s.colorScale ?? [...]` - the low and high ends of the ramp. */
  h3Scale: [[41, 181, 232, 80], [41, 181, 232, 220]] as [ColorRGBA, ColorRGBA],
  /** ScatterplotLayer `colorAccessor(s.fillColor, ..., [...])`. */
  scatterplotFill: [100, 100, 100, 180] as ColorRGBA,
  /** PathLayer `getColor: s.color ?? [...]`. */
  pathColor: [41, 181, 232, 150] as ColorRGBA,
  /** GeoJsonLayer `s.fillColor ?? [...]`. */
  geojsonFill: [41, 181, 232, 40] as ColorRGBA,
  /** ArcLayer `getSourceColor: s.sourceColor ?? [...]`. */
  arcSourceColor: [41, 181, 232, 200] as ColorRGBA,
  /** ArcLayer `getTargetColor: s.targetColor ?? [...]`. */
  arcTargetColor: [255, 107, 53, 200] as ColorRGBA,
} as const;

/** Numeric range of a layer's `valueColumn` over the rows the layer was compiled
 *  from. Reported by the fetcher, because only it sees the rows AFTER the inline
 *  row cap - a range describing rows that were truncated away would mislabel the
 *  ramp. */
export interface ValueDomain {
  min: number;
  max: number;
}

/** Per-layer facts the fetcher observes at render time. */
export interface LayerFacts {
  domain?: ValueDomain;
  /** Column names present on the returned rows, used to synthesize a tooltip. */
  columns?: string[];
}

/** Optional per-layer legend text. Lives on the spec as a passthrough key (see
 *  validateMapLayers) and in the shared DSL as LayerBase.legendLabel. */
type Labelled = { legendLabel?: unknown };

function legendLabelOf(layer: LayerSpec): string | undefined {
  const v = (layer as Labelled).legendLabel;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** `TOTAL_DWELL_MINUTES` -> `Total dwell minutes`. Column names are the only
 *  label available when the spec supplies none, and raw SNAKE_CASE reads as a
 *  leaked identifier. */
export function humanizeColumn(name: string): string {
  const words = name.replace(/[_\s]+/g, ' ').trim().toLowerCase();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Compact number for a gradient end label: 1234567 -> 1.2M, 0.5 -> 0.5. */
export function formatDomainValue(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (abs >= 10 || Number.isInteger(v)) return String(Math.round(v));
  return String(Number(v.toFixed(2)));
}

function sameColor(a: ColorRGBA | undefined, b: ColorRGBA | undefined): boolean {
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** A ColorValue is a flat colour only when it is the 4-tuple form. */
function flatColor(c: ColorValue | undefined): ColorRGBA | undefined {
  return Array.isArray(c) ? (c as ColorRGBA) : undefined;
}

/** The categorical palette a layer colours by, if it has one. Covers both DSL
 *  spellings: CategoricalColor on a scatterplot fill, and colorColumn/colorMap
 *  on a geojson choropleth. */
function paletteOf(layer: LayerSpec): Record<string, ColorRGBA> | undefined {
  if (layer.type === 'geojson') {
    const s = layer as GeoJsonLayerSpec;
    if (s.colorColumn && s.colorMap && Object.keys(s.colorMap).length) return s.colorMap;
    return undefined;
  }
  if (layer.type === 'scatterplot') {
    const fill = (layer as ScatterplotLayerSpec).fillColor;
    if (fill && !Array.isArray(fill) && 'palette' in fill && Object.keys(fill.palette).length) {
      return fill.palette;
    }
  }
  return undefined;
}

/** Swatch shape for a layer type: a line-like layer must not show a dot. */
function shapeOf(layer: LayerSpec): 'dot' | 'line' {
  return layer.type === 'path' || layer.type === 'arc' ? 'line' : 'dot';
}

/** The flat colour a layer draws with when it has no palette and no ramp. */
function flatColorOf(layer: LayerSpec): ColorRGBA {
  switch (layer.type) {
    case 'scatterplot':
      return flatColor((layer as ScatterplotLayerSpec).fillColor) ?? COMPILER_DEFAULTS.scatterplotFill;
    case 'path':
      return (layer as PathLayerSpec).color ?? COMPILER_DEFAULTS.pathColor;
    case 'geojson':
      return (layer as GeoJsonLayerSpec).fillColor ?? COMPILER_DEFAULTS.geojsonFill;
    case 'arc':
      return (layer as ArcLayerSpec).sourceColor ?? COMPILER_DEFAULTS.arcSourceColor;
    case 'h3':
      // An h3 layer with no valueColumn is drawn with the HIGH end of the ramp
      // (the compiler's lerp returns `hi` when there is nothing to interpolate).
      return ((layer as H3HexagonLayerSpec).colorScale ?? COMPILER_DEFAULTS.h3Scale)[1];
    default:
      return COMPILER_DEFAULTS.scatterplotFill;
  }
}

/** Fall back to the agent's own legend text for a flat-colour layer, but only
 *  when it is unambiguous: the item at this layer's index, and only if its
 *  colour agrees with what the layer draws (or the agent gave exactly one item
 *  for exactly one layer). Otherwise a mismatched key would be laundered into a
 *  derived legend and look authoritative. */
function borrowedLabel(
  index: number,
  layerCount: number,
  color: ColorRGBA,
  agentLegend: LegendItem[] | undefined,
): string | undefined {
  if (!agentLegend?.length) return undefined;
  const at = agentLegend[index];
  if (!at) return undefined;
  if (agentLegend.length === layerCount && (sameColor(at.color, color) || layerCount === 1)) {
    return at.label;
  }
  return undefined;
}

/**
 * Build the legend the map actually warrants.
 *
 * One or more items per layer, in layer order:
 *  - a `valueColumn` layer becomes ONE gradient bar over the ramp the compiler
 *    will lerp, labelled with the real min/max of the drawn rows. Discrete bins
 *    cannot describe a continuous lerp, which is why the agent's three-bin key
 *    was wrong in structure as well as in colour.
 *  - a categorical layer becomes one swatch per palette entry, coloured from the
 *    palette itself.
 *  - anything else becomes one swatch of its flat colour.
 *
 * `agentLegend` is consulted for TEXT only (see borrowedLabel); its colours are
 * never drawn.
 */
export function deriveInlineLegend(
  layers: LayerSpec[],
  facts: Record<number, LayerFacts | undefined>,
  agentLegend?: LegendItem[],
): LegendItem[] {
  const out: LegendItem[] = [];
  layers.forEach((layer, i) => {
    const label = legendLabelOf(layer);
    const valueColumn = layer.type === 'h3' ? (layer as H3HexagonLayerSpec).valueColumn : undefined;
    const domain = facts[i]?.domain;

    if (valueColumn) {
      const scale = (layer as H3HexagonLayerSpec).colorScale ?? COMPILER_DEFAULTS.h3Scale;
      const item: LegendItem = {
        label: label ?? humanizeColumn(valueColumn),
        gradient: [scale[0], scale[1]],
      };
      // Absent when the layer returned no usable numbers; a bar with no end
      // labels is still honest, an invented 0-100 would not be.
      if (domain) {
        item.minLabel = formatDomainValue(domain.min);
        item.maxLabel = formatDomainValue(domain.max);
      }
      out.push(item);
      return;
    }

    const palette = paletteOf(layer);
    if (palette) {
      const keys = Object.keys(palette);
      const shape = shapeOf(layer);
      const room = Math.max(0, MAX_LEGEND_ITEMS - out.length);
      for (const k of keys.slice(0, room)) {
        out.push({ label: k, color: palette[k], shape });
      }
      const dropped = keys.length - Math.min(keys.length, room);
      if (dropped > 0 && out.length < MAX_LEGEND_ITEMS) {
        out.push({ label: `+${dropped} more`, color: [148, 163, 184, 200], shape });
      }
      return;
    }

    const color = flatColorOf(layer);
    out.push({
      label: label ?? borrowedLabel(i, layers.length, color, agentLegend) ?? humanizeColumn(layer.id ?? `Layer ${i + 1}`),
      color,
      shape: shapeOf(layer),
    });
  });
  return out.slice(0, MAX_LEGEND_ITEMS);
}

/** Columns a layer reads to PLACE a feature, for a diagnostic message.
 *
 *  Lives here, next to tooltipExcludes, rather than in the deck.gl compiler
 *  where it was first written. Two reasons, both measured:
 *
 *  1. It is a pure function of the spec - no rows, no deck.gl - and its only
 *     callers are the "returned rows but drew nothing" notices in
 *     render-map-inline. Reaching it through `@/lib/map/layer-compiler` ->
 *     `export * from '@fleet-kit/core/map'` made the binding depend on webpack
 *     tracing a symbol across a package boundary, in the one code path that runs
 *     when a map is already failing. A stale webpack cache reported it as
 *     "not exported" (4 warnings; 0 on a clean build), which was benign here but
 *     is not a property worth relying on for an error handler.
 *  2. Nothing could TEST it there: verify_map_spec.mts runs under tsx, where any
 *     transitive @deck.gl import dies in @luma.gl/shadertools. `drawnCount`
 *     stays in the compiler because it needs pathData / geoFeatures; this does
 *     not need anything.
 *
 *  Deliberately NOT merged with tooltipExcludes, which answers a different
 *  question: an h3 `hexColumn` is an encoding column AND worth showing on hover,
 *  so it appears here but not there. Kept adjacent so the two stay comparable.
 */
export function encodingColumns(layer: LayerSpec): string[] {
  // Every branch is filtered, because the caller interpolates the result with
  // `.join(', ')` into a user-facing notice. A hole prints "lon, , lat" - or, for
  // an h3 layer with no hexColumn at all, "no usable value in ." - which reads as
  // a bug in the message explaining the bug. validateMapLayers now rejects a
  // missing encoding up front, but this runs in an ERROR path reached from an
  // authored app-views.json Map area too, so it must not assume that gate ran.
  const cols = (() => {
    switch (layer.type) {
      case 'scatterplot': {
        const s = layer as ScatterplotLayerSpec;
        return [s.lng, s.lat];
      }
      case 'arc': {
        const s = layer as ArcLayerSpec;
        return [s.source?.lng, s.source?.lat, s.target?.lng, s.target?.lat];
      }
      case 'h3': {
        const s = layer as H3HexagonLayerSpec;
        return [s.hexColumn, s.valueColumn];
      }
      case 'path': {
        const s = layer as PathLayerSpec;
        return s.geojsonColumn
          ? [s.geojsonColumn]
          : [s.start?.lng, s.start?.lat, s.end?.lng, s.end?.lat];
      }
      case 'geojson':
        return [(layer as GeoJsonLayerSpec).geojsonColumn];
      default:
        return [];
    }
  })();
  return cols.filter((c): c is string => typeof c === 'string' && c.length > 0);
}

/** Columns that carry geometry or raw coordinates rather than something a reader
 *  wants in a tooltip. */
function tooltipExcludes(layer: LayerSpec): Set<string> {
  const skip = new Set<string>();
  const add = (c?: string) => {
    if (c) skip.add(c.toUpperCase());
  };
  switch (layer.type) {
    case 'scatterplot':
      add((layer as ScatterplotLayerSpec).lng);
      add((layer as ScatterplotLayerSpec).lat);
      break;
    case 'path': {
      const s = layer as PathLayerSpec;
      add(s.geojsonColumn);
      add(s.start?.lng); add(s.start?.lat); add(s.end?.lng); add(s.end?.lat);
      break;
    }
    case 'geojson':
      add((layer as GeoJsonLayerSpec).geojsonColumn);
      break;
    case 'arc': {
      const s = layer as ArcLayerSpec;
      add(s.source.lng); add(s.source.lat); add(s.target.lng); add(s.target.lat);
      break;
    }
    default:
      break;
  }
  return skip;
}

/** Tokens shown in a synthesized tooltip. Beyond a handful the card stops being
 *  a hover hint and starts being a table. */
const MAX_SYNTH_TOKENS = 4;

/**
 * Build a `{COLUMN}` tooltip template for a layer that did not declare one.
 *
 * A hoverable map with no tooltip is the state the user reported; without a
 * template `getTooltip` returns null even once picking works, so forcing
 * `pickable` alone would have fixed nothing for a spec that omits `tooltip`.
 * The measure or category the layer colours by leads, since that is what the
 * user is hovering to read.
 *
 * Returns undefined when there is nothing worth showing, so the caller can leave
 * the layer without a tooltip rather than render an empty black box.
 */
export function synthesizeTooltip(layer: LayerSpec, columns: string[] | undefined): string | undefined {
  if (!columns?.length) return undefined;
  const skip = tooltipExcludes(layer);
  const lead: string[] = [];
  const pushLead = (c?: string) => {
    if (c && !lead.includes(c)) lead.push(c);
  };
  if (layer.type === 'h3') {
    pushLead((layer as H3HexagonLayerSpec).valueColumn);
    pushLead((layer as H3HexagonLayerSpec).hexColumn);
  } else if (layer.type === 'geojson') {
    pushLead((layer as GeoJsonLayerSpec).colorColumn);
  } else if (layer.type === 'scatterplot') {
    const fill = (layer as ScatterplotLayerSpec).fillColor;
    if (fill && !Array.isArray(fill) && 'palette' in fill) pushLead(fill.column);
  }

  const seen = new Set<string>();
  const picked: string[] = [];
  const consider = (col: string) => {
    const up = col.toUpperCase();
    if (picked.length >= MAX_SYNTH_TOKENS || seen.has(up) || skip.has(up)) return;
    seen.add(up);
    picked.push(col);
  };
  // Lead columns are matched case-insensitively against the real row keys, since
  // a spec may name `dwell_minutes` for a column Snowflake returns as
  // DWELL_MINUTES.
  for (const l of lead) {
    const hit = columns.find((c) => c.toUpperCase() === l.toUpperCase());
    if (hit) consider(hit);
  }
  for (const c of columns) consider(c);
  if (!picked.length) return undefined;

  const [first, ...rest] = picked;
  const line = (c: string) => `${humanizeColumn(c)}: {${c}}`;
  return [`<b>${line(first)}</b>`, ...rest.map(line)].join('<br/>');
}
