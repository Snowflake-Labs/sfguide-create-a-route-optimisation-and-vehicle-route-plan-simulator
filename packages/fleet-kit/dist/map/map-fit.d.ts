export type LngLat = [number, number];
export type Bounds = [[number, number], [number, number]];
export interface ViewState {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch?: number;
    bearing?: number;
}
export interface Padding {
    top: number;
    bottom: number;
    left: number;
    right: number;
}
export declare const DEFAULT_PADDING: Padding;
export declare const DEFAULT_MIN_ZOOM = 2;
export declare const DEFAULT_MAX_ZOOM = 16;
export declare const SINGLE_POINT_ZOOM = 14;
export declare function coordsFromPoints<T>(rows: T[] | null | undefined, getXY: (row: T) => [number, number] | {
    lng?: number;
    lat?: number;
    longitude?: number;
    latitude?: number;
} | null | undefined): LngLat[];
export declare function coordsFromH3Cells<T>(rows: T[] | null | undefined, getCell: (row: T) => string | null | undefined, opts?: {
    sample?: number;
}): LngLat[];
export declare function coordsFromPaths(paths: any): LngLat[];
export declare function coordsFromGeoJSON(input: any): LngLat[];
export declare function boundsOf(coords: LngLat[] | null | undefined): Bounds | null;
export interface FitOptions {
    width: number;
    height: number;
    coords?: LngLat[] | null;
    bounds?: Bounds | null;
    padding?: Padding | number;
    minZoom?: number;
    maxZoom?: number;
    fallback?: ViewState;
}
export declare function fitBoundsToData(opts: FitOptions): ViewState | null;
export declare function coordsSignature(coords: LngLat[] | null | undefined): string;
/** True when every coord's bounding box lies inside the current viewport. */
export declare function coordsWithinView(coords: LngLat[] | null | undefined, view: ViewState, width: number, height: number): boolean;
//# sourceMappingURL=map-fit.d.ts.map