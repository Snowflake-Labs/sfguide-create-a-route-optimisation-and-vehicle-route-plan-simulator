import { type Bounds, type LngLat, type Padding } from './geo-coords';
export * from './geo-coords';
export interface ViewState {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch?: number;
    bearing?: number;
}
export declare const DEFAULT_MIN_ZOOM = 2;
export declare const DEFAULT_MAX_ZOOM = 16;
export declare const SINGLE_POINT_ZOOM = 14;
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
/** True when every coord's bounding box lies inside the current viewport. */
export declare function coordsWithinView(coords: LngLat[] | null | undefined, view: ViewState, width: number, height: number): boolean;
//# sourceMappingURL=map-fit.d.ts.map