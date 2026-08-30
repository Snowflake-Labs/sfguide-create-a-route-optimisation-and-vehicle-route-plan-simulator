// Map layer DSL - pure data types, imports nothing from React/deck.gl.
// Extracted to @fleet-kit/core (R1) from the consumer app's lib/map/layer-spec.ts.
// The deck.gl-coupled compiler + camera-fit helpers join this subpath in R1
// increment 2 (they carry @deck.gl/core + h3-js as peer deps).

export type ColorRGBA = [number, number, number, number];

/** Conditional "highlight selected" color (e.g. selected courier).
 *  When not the active row, falls back to a per-category color (baseColumn +
 *  basePalette) if provided, else the flat `base`. */
export interface ConditionalColor {
  base: ColorRGBA;
  active: ColorRGBA;
  /** Row column compared for the highlight. */
  matchColumn: string;
  /** Dot-path into viewState whose value is compared against `matchColumn`. */
  whenViewStateEquals: string;
  /** Optional: when NOT the active row, color by this column via basePalette. */
  baseColumn?: string;
  /** Optional palette keyed by baseColumn value -> color (else `base`). */
  basePalette?: Record<string, ColorRGBA>;
}

/** Categorical color: per-row color by a column value via a palette. */
export interface CategoricalColor {
  /** Row column whose value selects a palette entry. */
  column: string;
  /** Map of column value -> color. */
  palette: Record<string, ColorRGBA>;
  /** Fallback color when the value is not in the palette. */
  default?: ColorRGBA;
}

export type ColorValue = ColorRGBA | ConditionalColor | CategoricalColor;

/** SA-shaped per-layer data source: a SELECT query + optional :param refs. */
export interface MapLayerData {
  query: string;
  /** `:placeholder` -> "viewState.x" | "context.region" | literal (see use-view-data). */
  params?: Record<string, string>;
}

interface LayerBase {
  id?: string;
  data: MapLayerData;
  pickable?: boolean;
  /** HTML tooltip template using `{COLUMN}` tokens, e.g. "<b>{COURIER_ID}</b>". */
  tooltip?: string;
  /** Exclude this layer from selection-driven camera fit. Set on wide context
   *  layers (e.g. a full ZIP choropleth) so focusing a selection frames the
   *  selected object + its ring, not the entire context extent. */
  noFit?: boolean;
  /** viewState key gating this layer's visibility. The layer renders unless the
   *  value is explicitly false/'false' (so it defaults ON before a toggle seeds).
   *  When hidden the layer skips its data fetch entirely (no wasted query). */
  visibleWhen?: string;
}

export interface ScatterplotLayerSpec extends LayerBase {
  type: 'scatterplot';
  lng: string;
  lat: string;
  fillColor?: ColorValue;
  radius?: number;
  radiusMinPixels?: number;
  radiusMaxPixels?: number;
  /** Draw an outline around each point. */
  stroked?: boolean;
  /** Outline color (requires stroked). Defaults to a neutral grey. */
  lineColor?: ColorRGBA;
  /** Minimum outline width in pixels (requires stroked). */
  lineWidthMinPixels?: number;
}

export interface PathLayerSpec extends LayerBase {
  type: 'path';
  geojsonColumn?: string;
  start?: { lng: string; lat: string };
  end?: { lng: string; lat: string };
  color?: ColorRGBA;
  width?: number;
  widthMinPixels?: number;
  /** Color a path takes on hover (requires pickable). Defaults to Snowflake blue. */
  highlightColor?: ColorRGBA;
  /** Max vertices kept per line before stride-decimation (defaults to
   *  DEFAULT_MAX_PATH_POINTS). Bounds GPU buffer + parse cost so heavy route
   *  GeoJSON does not freeze the basemap; endpoints are always preserved. */
  maxPathPoints?: number;
}

export interface H3HexagonLayerSpec extends LayerBase {
  type: 'h3';
  hexColumn: string;
  valueColumn?: string;
  colorScale?: [ColorRGBA, ColorRGBA];
  extruded?: boolean;
}

export interface GeoJsonLayerSpec extends LayerBase {
  type: 'geojson';
  geojsonColumn: string;
  fillColor?: ColorRGBA;
  lineColor?: ColorRGBA;
  lineWidth?: number;
  // Per-feature choropleth: color each feature by the value of `colorColumn`
  // (read from the row's properties) looked up in `colorMap` (keyed by the
  // stringified value). Falls back to `fillColor` when the value is absent.
  colorColumn?: string;
  colorMap?: Record<string, ColorRGBA>;
  /** Max vertices kept per LineString/MultiLineString before stride-decimation
   *  (defaults to DEFAULT_MAX_PATH_POINTS). Polygon rings are never decimated. */
  maxPathPoints?: number;
}

export interface ArcLayerSpec extends LayerBase {
  type: 'arc';
  source: { lng: string; lat: string };
  target: { lng: string; lat: string };
  sourceColor?: ColorRGBA;
  targetColor?: ColorRGBA;
  width?: number;
}

export type LayerSpec =
  | ScatterplotLayerSpec
  | PathLayerSpec
  | H3HexagonLayerSpec
  | GeoJsonLayerSpec
  | ArcLayerSpec;

/** Fallback camera when no layer data exists to fit to. */
export interface MapViewStateSpec {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

/** One entry in a map legend: a labeled color swatch. */
export interface LegendItem {
  label: string;
  /** Swatch colour; optional when `gradient` is set (gradient items omit it). */
  color?: ColorRGBA;
  /** Swatch shape; defaults to 'dot'. */
  shape?: 'dot' | 'line';
  /** When set, render a horizontal colour-gradient bar instead of a swatch. */
  gradient?: ColorRGBA[];
  /** Label shown under the left end of the gradient bar. */
  minLabel?: string;
  /** Label shown under the right end of the gradient bar. */
  maxLabel?: string;
}

/** One interactive layer-toggle checkbox rendered as a clickable map overlay. */
export interface MapToggleItem {
  /** viewState key written on change (matches a layer's `visibleWhen`). */
  key: string;
  label: string;
  /** Initial checked state seeded into viewState once; defaults to true. */
  default?: boolean;
}

/** Wire map clicks into viewState (click-to-anchor). A pick on a data object
 *  emits `object` = the picked row's `objectColumn` (default poi_name). A click
 *  on empty map emits `lng`/`lat` = the clicked coordinate and clears `object`,
 *  so a live-catchment view can anchor on an existing venue OR a greenfield point. */
export interface MapClickEmits {
  /** viewState key set to the picked object's value on an object click. */
  object?: string;
  /** Row column read from the picked object for the object emit; defaults to poi_name. */
  objectColumn?: string;
  /** viewState key set to the clicked longitude on an empty-map click. */
  lng?: string;
  /** viewState key set to the clicked latitude on an empty-map click. */
  lat?: string;
}

/** `config` block of a `component: Map` area in an SA view YAML. */
export interface MapAreaConfig {
  layers: LayerSpec[];
  /** Remove inner padding so the map fills its grid cell. */
  noPad?: boolean;
  /** Fixed pixel height; defaults to filling the grid row. */
  height?: number;
  /** Camera fallback when there are no coordinates to fit. */
  fallback?: MapViewStateSpec;
  /** Optional legend rendered as an overlay card on the map. */
  legend?: LegendItem[];
  /** Optional second legend card (e.g. a category color key) rendered as its
   *  own collapsible overlay, separate from `legend`. */
  categoryLegend?: LegendItem[];
  /** Optional interactive layer-toggle checkboxes rendered as a map overlay. */
  toggles?: MapToggleItem[];
  /** Optional: route map clicks into viewState (click-to-anchor). */
  clickEmits?: MapClickEmits;
  /** Fit the camera once on load (and again on a region change), then never
   *  auto re-frame. Selections, layer toggles and periodic refetches leave the
   *  camera exactly where the user left it. */
  lockCamera?: boolean;
  /** One-shot camera focus driven by viewState. When both keys hold finite
   *  numbers the camera pans to that point (and zooms to `zoom`, when given).
   *  Typically written by a table row click, so a user gesture can move the
   *  camera even on a `lockCamera` map. */
  focusOn?: { lngKey: string; latKey: string; zoom?: number };
}
