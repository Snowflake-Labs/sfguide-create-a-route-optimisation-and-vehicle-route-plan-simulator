'use client';
import { jsx as _jsx } from "react/jsx-runtime";
// CARTO vector basemap, rendered by MapLibre GL JS beneath the deck.gl canvas.
//
// Shared by both apps. This file was duplicated as
// fleet_sa_app/ui/src/components/views/areas/basemap.tsx and
// fleet_admin_app/ui/src/components/shared/basemap.tsx, differing only in one
// word of one comment, so every fix had to be applied twice.
//
// Replaces the previous raster basemap (a TileLayer + BitmapLayer pair fetching
// light_all PNGs through /api/tiles). CARTO now requires an API key for the
// raster endpoint and is retiring it - unkeyed raster tiles come back stamped
// with an "API key required" watermark while still returning HTTP 200, so no
// status-code health check can see the failure. The vector style needs no key.
//
// deck.gl remains the sole camera owner: MapLibre is constructed with
// interactive:false and is driven by mirroring deck's viewState through
// jumpTo(). deck.gl and MapLibre share the same Web Mercator zoom convention
// (world = 512 * 2^zoom px), so the two cameras stay registered with no
// conversion. Keeping ownership on deck.gl means none of the fit/focus logic in
// map-view.tsx / MapView.tsx has to move onto MapLibre's fitBounds().
//
// Attribution (CARTO + OpenStreetMap) is rendered by MapLibre from the style's
// TileJSON, which is a condition of CARTO's free tier. Keep an AttributionControl
// mounted (see the explicit one below), and do not inline the source's `tiles`
// array in place of its `url` - the attribution travels with the TileJSON.
//
// No dark variant. CARTO serves dark-matter-gl-style, but neither app has a
// theme system - no prefers-color-scheme rule, no darkMode config, no theme
// hook - so an isDarkMode prop would be set by nothing, and if it ever were,
// a dark basemap would sit under light chrome. Add the style pair at the point
// a theme exists to drive it, not before.
import { useEffect, useRef } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
// Vector twin of the old light_all raster style. Keyless. Alternatives:
// dark-matter-gl-style, voyager-gl-style, positron-nolabels-gl-style.
const CARTO_VECTOR_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
// CARTO does not require a key for vector today, but says it may in future.
// Setting NEXT_PUBLIC_CARTO_API_KEY is then a service-YAML edit, not a code change.
function styleUrl() {
    const key = process.env.NEXT_PUBLIC_CARTO_API_KEY;
    return key ? `${CARTO_VECTOR_STYLE}?key=${encodeURIComponent(key)}` : CARTO_VECTOR_STYLE;
}
export default function Basemap({ viewState, onError }) {
    const containerRef = useRef(null);
    const mapRef = useRef(null);
    // Holds the newest viewState so the async import cannot construct the map
    // with a camera that went stale while maplibre-gl was still loading.
    const latestRef = useRef(viewState);
    latestRef.current = viewState;
    // Read through a ref so a changing callback does not re-run setup and rebuild
    // the map (which would drop and re-acquire a WebGL context on every render).
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    useEffect(() => {
        let cancelled = false;
        if (!containerRef.current)
            return;
        // Imported inside the effect, not at module scope: maplibre-gl touches
        // `window` on evaluation and would break the Next SSR pass.
        (async () => {
            // Everything here is inside the try deliberately. The dynamic import can
            // reject (chunk load failure), and the Map constructor throws where WebGL
            // is unavailable or a stricter CSP blocks the CARTO hosts. Previously
            // neither was handled at all, so both surfaced as an unhandled promise
            // rejection and the basemap silently vanished - the same invisible
            // degradation as the watermarked raster tiles, which is precisely how
            // those went unnoticed. deck.gl still renders the data on its own canvas.
            try {
                const maplibregl = (await import('maplibre-gl')).default;
                if (cancelled || !containerRef.current)
                    return;
                const vs = latestRef.current;
                const map = new maplibregl.Map({
                    container: containerRef.current,
                    style: styleUrl(),
                    center: [vs.longitude, vs.latitude],
                    zoom: vs.zoom,
                    pitch: vs.pitch ?? 0,
                    bearing: vs.bearing ?? 0,
                    interactive: false,
                    // Suppressed so it can be re-added with explicit options below.
                    attributionControl: false,
                });
                // maplibre-gl's AttributionControl defaults to
                //   { compact: true, customAttribution: '<a ...>MapLibre</a>' }
                // which renders "MapLibre | (c) CARTO, (c) OpenStreetMap contributors"
                // behind an (i) toggle. Its constructor takes those as a DEFAULT PARAMETER
                // rather than merging them, so passing any options object drops the
                // MapLibre self-promo link, and compact:false keeps the credit expanded.
                // The CARTO + OpenStreetMap credit still comes from the style's TileJSON
                // and MUST remain visible - that is CARTO's free-tier condition. MapLibre
                // itself is BSD-3, which requires the notice in source and binary
                // distributions, not on-screen credit.
                map.addControl(new maplibregl.AttributionControl({ compact: false }));
                // A style that 404s or fails to parse arrives here, after construction
                // succeeded, so it needs its own listener to be reported at all.
                map.on('error', (e) => {
                    onErrorRef.current?.(e, { styleUrl: styleUrl() });
                });
                // No await between the constructor and this assignment, so the cancelled
                // check above is still current and cleanup cannot have run in between.
                mapRef.current = map;
            }
            catch (error) {
                onErrorRef.current?.(error, { styleUrl: styleUrl() });
            }
        })();
        return () => {
            cancelled = true;
            // Releases the WebGL context; without this, remounting maps eventually
            // trips the browser's live-context ceiling.
            mapRef.current?.remove();
            mapRef.current = null;
        };
    }, []);
    useEffect(() => {
        const map = mapRef.current;
        if (!map)
            return;
        map.jumpTo({
            center: [viewState.longitude, viewState.latitude],
            zoom: viewState.zoom,
            pitch: viewState.pitch ?? 0,
            bearing: viewState.bearing ?? 0,
        });
    }, [viewState]);
    return _jsx("div", { ref: containerRef, style: { position: 'absolute', inset: 0, zIndex: 0 } });
}
//# sourceMappingURL=basemap.js.map