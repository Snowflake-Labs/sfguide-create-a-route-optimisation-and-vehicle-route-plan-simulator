import type { Layer } from '@deck.gl/core';
import type { LayerSpec } from './layer-spec';
type Row = Record<string, any>;
/**
 * Compile one LayerSpec + its fetched rows into a deck.gl Layer.
 * `index` provides a stable fallback id. Returns null when there is no data.
 */
export declare function compileLayer(spec: LayerSpec, rows: Row[], viewState: Record<string, unknown>, index: number): Layer | null;
/** Collect [lng,lat] coordinates from a layer's rows for camera fitting. */
export declare function layerFitCoords(spec: LayerSpec, rows: Row[]): [number, number][];
export {};
//# sourceMappingURL=layer-compiler.d.ts.map