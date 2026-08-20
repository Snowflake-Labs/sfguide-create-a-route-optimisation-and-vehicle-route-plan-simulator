import type { Layer } from '@deck.gl/core';
import type { LayerSpec } from './layer-spec';
type Row = Record<string, any>;
/**
 * Single-parse compile: build the deck.gl Layer AND its camera-fit coordinates
 * from ONE parse pass. For `path` / `geojson` layers this parses each row's
 * GeoJSON string exactly once (the layer data and the fit coords are both
 * derived from the parsed+decimated result), instead of the double parse you get
 * from calling compileLayer + layerFitCoords separately. Non-parsing layer types
 * (scatterplot / arc / h3) delegate to those helpers, which are already cheap.
 *
 * Prefer this over calling compileLayer and layerFitCoords back-to-back when the
 * spec may carry heavy route GeoJSON - halving the parse is what keeps the
 * basemap responsive.
 */
export declare function compileLayerWithFit(spec: LayerSpec, rows: Row[], viewState: Record<string, unknown>, index: number, hovered?: {
    layerId: string;
    value: unknown;
} | null): {
    layer: Layer | null;
    fitCoords: [number, number][];
};
/**
 * Compile one LayerSpec + its fetched rows into a deck.gl Layer.
 * `index` provides a stable fallback id. Returns null when there is no data.
 */
export declare function compileLayer(spec: LayerSpec, rows: Row[], viewState: Record<string, unknown>, index: number, hovered?: {
    layerId: string;
    value: unknown;
} | null): Layer | null;
/** Collect [lng,lat] coordinates from a layer's rows for camera fitting. */
export declare function layerFitCoords(spec: LayerSpec, rows: Row[]): [number, number][];
export {};
//# sourceMappingURL=layer-compiler.d.ts.map