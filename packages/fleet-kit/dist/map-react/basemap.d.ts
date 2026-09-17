import 'maplibre-gl/dist/maplibre-gl.css';
export interface BasemapViewState {
    longitude: number;
    latitude: number;
    zoom: number;
    pitch?: number;
    bearing?: number;
}
export interface BasemapProps {
    viewState: BasemapViewState;
    /**
     * Called when the basemap fails to initialise. Losing the backdrop must never
     * take the data layers with it, so the failure is reported rather than thrown.
     */
    onError?: (error: unknown, context: {
        styleUrl: string;
    }) => void;
}
export default function Basemap({ viewState, onError }: BasemapProps): import("react").JSX.Element;
//# sourceMappingURL=basemap.d.ts.map