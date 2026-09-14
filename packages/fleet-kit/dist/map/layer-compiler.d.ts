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
/**
 * Rows of `rows` that carry every column `spec` needs to place a feature.
 *
 * Exists so a caller can tell "the query matched nothing" apart from "the query
 * matched plenty and NONE of it could be drawn" - two states that looked
 * identical (an empty basemap, no error) and have opposite fixes. The second is
 * always a naming or a NULL-geometry problem: a misspelled `hexColumn`, a
 * `valueColumn` that is not on the result set, or a live routing call that
 * returned NULL geometry because its profile was wrong.
 *
 * Deliberately counts the SAME predicate each compile branch filters on, so the
 * number describes what deck.gl was handed rather than an independent opinion
 * about it.
 */
export declare function drawnCount(spec: LayerSpec, rows: Row[]): number;
/** Column names `spec` reads to place a feature: see `encodingColumns` in the SA
 *  app's lib/map/inline-legend.ts. It was here, but it needs nothing from this
 *  module and nothing here can be imported under tsx (deck.gl dies in
 *  @luma.gl/shadertools), so its only caller reached it across a package
 *  boundary and no test could cover it. `drawnCount` stays because it needs
 *  pathData / geoFeatures. */
export declare function compileLayerWithFit(spec: LayerSpec, rows: Row[], viewState: Record<string, unknown>, index: number, hovered?: {
    layerId: string;
    value: unknown;
} | null): {
    layer: Layer | null;
    fitCoords: [number, number][];
    drawn: number;
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