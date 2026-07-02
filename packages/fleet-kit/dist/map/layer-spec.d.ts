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
    start?: {
        lng: string;
        lat: string;
    };
    end?: {
        lng: string;
        lat: string;
    };
    color?: ColorRGBA;
    width?: number;
    widthMinPixels?: number;
    /** Color a path takes on hover (requires pickable). Defaults to Snowflake blue. */
    highlightColor?: ColorRGBA;
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
    colorColumn?: string;
    colorMap?: Record<string, ColorRGBA>;
}
export interface ArcLayerSpec extends LayerBase {
    type: 'arc';
    source: {
        lng: string;
        lat: string;
    };
    target: {
        lng: string;
        lat: string;
    };
    sourceColor?: ColorRGBA;
    targetColor?: ColorRGBA;
    width?: number;
}
export type LayerSpec = ScatterplotLayerSpec | PathLayerSpec | H3HexagonLayerSpec | GeoJsonLayerSpec | ArcLayerSpec;
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
    color: ColorRGBA;
    /** Swatch shape; defaults to 'dot'. */
    shape?: 'dot' | 'line';
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
}
export {};
//# sourceMappingURL=layer-spec.d.ts.map