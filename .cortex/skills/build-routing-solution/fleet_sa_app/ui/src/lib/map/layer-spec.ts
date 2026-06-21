// Map layer DSL for the SA Map area (ported from the control app's spec-types.ts).
//
// The geometry-bearing LayerSpec shapes are copied verbatim from the control app
// so the layer-compiler ports unchanged. The ONLY adaptation for Solution
// Accelerator is the per-layer `data` shape: instead of the control app's
// DataSourceSpec (with server-side `refetchOn`), each layer carries SA's
// `{ query, params }` so it can be fetched through SA's `useViewData` hook (which
// resolves `:params` from store context/viewState and auto-refetches on change).
//
// This module imports nothing from React/deck.gl — pure data.

export type ColorRGBA = [number, number, number, number];

/** Conditional "highlight selected" color (e.g. selected courier). */
export interface ConditionalColor {
  base: ColorRGBA;
  active: ColorRGBA;
  /** Row column compared for the highlight. */
  matchColumn: string;
  /** Dot-path into viewState whose value is compared against `matchColumn`. */
  whenViewStateEquals: string;
}

export type ColorValue = ColorRGBA | ConditionalColor;

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
}

export interface ScatterplotLayerSpec extends LayerBase {
  type: 'scatterplot';
  lng: string;
  lat: string;
  fillColor?: ColorValue;
  radius?: number;
  radiusMinPixels?: number;
  radiusMaxPixels?: number;
}

export interface PathLayerSpec extends LayerBase {
  type: 'path';
  geojsonColumn?: string;
  start?: { lng: string; lat: string };
  end?: { lng: string; lat: string };
  color?: ColorRGBA;
  width?: number;
  widthMinPixels?: number;
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

/** `config` block of a `component: Map` area in an SA view YAML. */
export interface MapAreaConfig {
  layers: LayerSpec[];
  /** Remove inner padding so the map fills its grid cell. */
  noPad?: boolean;
  /** Fixed pixel height; defaults to filling the grid row. */
  height?: number;
  /** Camera fallback when there are no coordinates to fit. */
  fallback?: MapViewStateSpec;
}
