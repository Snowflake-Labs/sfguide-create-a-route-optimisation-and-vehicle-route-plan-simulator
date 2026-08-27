'use client';

// CARTO vector basemap, rendered by MapLibre GL JS beneath the deck.gl canvas.
//
// Replaces the previous raster basemap (a TileLayer + BitmapLayer pair fetching
// light_all PNGs through /api/tiles). CARTO now requires an API key for the
// raster endpoint and is retiring it - unkeyed raster tiles come back stamped
// with an "API key required" watermark. The vector style needs no key.
//
// deck.gl remains the sole camera owner: MapLibre is constructed with
// interactive:false and is driven by mirroring deck's viewState through
// jumpTo(). deck.gl and MapLibre share the same Web Mercator zoom convention
// (world = 512 * 2^zoom px), so the two cameras stay registered with no
// conversion. Keeping ownership on deck.gl means none of the fit/focus logic in
// MapView.tsx has to move onto MapLibre's fitBounds().
//
// Attribution (CARTO + OpenStreetMap) is rendered by MapLibre from the style's
// TileJSON, which is a condition of CARTO's free tier. Do not remove the
// default AttributionControl, and do not inline the source's `tiles` array in
// place of its `url` - the attribution travels with the TileJSON.

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

// Vector twin of the old light_all raster style. Keyless. Alternatives:
// dark-matter-gl-style, voyager-gl-style, positron-nolabels-gl-style.
const CARTO_VECTOR_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

// CARTO does not require a key for vector today, but says it may in future.
// Setting NEXT_PUBLIC_CARTO_API_KEY is then a service-YAML edit, not a code change.
function styleUrl(): string {
  const key = process.env.NEXT_PUBLIC_CARTO_API_KEY;
  return key ? `${CARTO_VECTOR_STYLE}?key=${encodeURIComponent(key)}` : CARTO_VECTOR_STYLE;
}

interface BasemapViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

export default function Basemap({ viewState }: { viewState: BasemapViewState }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // Holds the newest viewState so the async import cannot construct the map
  // with a camera that went stale while maplibre-gl was still loading.
  const latestRef = useRef(viewState);
  latestRef.current = viewState;

  useEffect(() => {
    let cancelled = false;
    if (!containerRef.current) return;

    // Imported inside the effect, not at module scope: maplibre-gl touches
    // `window` on evaluation and would break the Next SSR pass.
    (async () => {
      const maplibregl = (await import('maplibre-gl')).default;
      if (cancelled || !containerRef.current) return;
      const vs = latestRef.current;
      mapRef.current = new maplibregl.Map({
        container: containerRef.current,
        style: styleUrl(),
        center: [vs.longitude, vs.latitude],
        zoom: vs.zoom,
        pitch: vs.pitch ?? 0,
        bearing: vs.bearing ?? 0,
        interactive: false,
      });
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
    if (!map) return;
    map.jumpTo({
      center: [viewState.longitude, viewState.latitude],
      zoom: viewState.zoom,
      pitch: viewState.pitch ?? 0,
      bearing: viewState.bearing ?? 0,
    });
  }, [viewState]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0, zIndex: 0 }} />;
}
