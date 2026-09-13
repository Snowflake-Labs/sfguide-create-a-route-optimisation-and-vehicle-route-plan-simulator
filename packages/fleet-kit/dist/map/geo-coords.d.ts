export type LngLat = [number, number];
export type Bounds = [[number, number], [number, number]];
/**
 * Ceiling on a fit inset, as a share of the smaller viewport dimension. Lives
 * here with clampFitPadding so both are testable without a viewport.
 *
 * DEFAULT_PADDING is a flat 40px on each side because chrome drawn over the
 * canvas is a fixed size - a card border does not grow with the card. But on a
 * short canvas two 40px insets exceed the viewport, and measured against
 * deck.gl 9.2 that is not a cosmetic problem:
 *
 *   600x60,  pad 40 -> fitBounds THROWS (@math.gl/web-mercator assertion)
 *   600x90,  pad 40 -> zoom 1.145 for a 2-degree box (near-world)
 *   600x90,  pad 18 -> zoom 3.578
 *
 * The throw matters most. fitBoundsToData catches it and returns `fallback`, and
 * MapView deliberately passes no fallback (see map-view.tsx:229), so the camera
 * silently never fits - the same class of failure that comment is about. Inline
 * chat maps are the realistic case: they render into a far shorter box than a
 * dashboard area.
 */
export declare const MAX_PADDING_FRACTION = 0.2;
export interface Padding {
    top: number;
    bottom: number;
    left: number;
    right: number;
}
export declare const DEFAULT_PADDING: Padding;
/**
 * Holds each inset under MAX_PADDING_FRACTION of the smaller dimension, so a
 * short canvas still fits its data instead of squeezing it into a band, or
 * failing to fit at all.
 */
export declare function clampFitPadding(p: Padding, width: number, height: number): Padding;
/** Exported for map-fit, which shares the same notion of a usable number. */
export declare function isFiniteNum(n: any): n is number;
export declare function coordsFromPoints<T>(rows: T[] | null | undefined, getXY: (row: T) => [number, number] | {
    lng?: number;
    lat?: number;
    longitude?: number;
    latitude?: number;
} | null | undefined): LngLat[];
/**
 * Vertices of one H3 cell as [lng, lat] pairs, or empty when the cell is not a
 * usable index.
 *
 * Validated with isValidCell rather than the previous `length < 15` heuristic.
 * That heuristic was not wrong so much as vacuous: every valid H3 index is 15
 * hex characters at every resolution (measured res 0, 1, 5, 9, 15), so it
 * rejected no valid cell and admitted any malformed 15-character string. Those
 * then reached cellToBoundary, which does throw for them, so the per-row
 * try/catch swallowed one exception per bad cell - correct output by way of
 * exception-driven control flow, at 9ms per 2000 bad cells versus 0ms for the
 * check. Validating says what is meant and keeps the catch for genuine surprises.
 *
 * The boundary is used rather than the centre so a single-cell map has real
 * span: a centre gives zero span, which the degenerate-bounds path then frames
 * at SINGLE_POINT_ZOOM, showing a fraction of a low-resolution hexagon.
 */
export declare function coordsFromH3Cell(cell: unknown): LngLat[];
/**
 * Recursively pushes every [lng, lat] pair out of a nested GeoJSON coordinate
 * array. Every GeoJSON coordinate container bottoms out in coordinate pairs, so
 * recursing until a pair of numbers appears covers Point through MultiPolygon
 * uniformly - no per-geometry-type switch, and nothing to miss when a new type
 * turns up.
 *
 * Exported because the layer compiler needs the identical walk for its
 * already-parsed features: two independently written walkers is how the fit path
 * and the compile path drift apart on which coordinates count.
 */
export declare function pushCoordPairs(c: any, out: LngLat[]): void;
export declare function coordsFromH3Cells<T>(rows: T[] | null | undefined, getCell: (row: T) => string | null | undefined, opts?: {
    sample?: number;
}): LngLat[];
export declare function coordsFromPaths(paths: any): LngLat[];
export declare function coordsFromGeoJSON(input: any): LngLat[];
export declare function boundsOf(coords: LngLat[] | null | undefined): Bounds | null;
export declare function coordsSignature(coords: LngLat[] | null | undefined): string;
//# sourceMappingURL=geo-coords.d.ts.map