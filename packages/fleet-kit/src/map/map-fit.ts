// Camera-fit + coordinate-extraction helpers for the Map area.
// Ported verbatim from the control app (src/shared/mapFit.ts). Pure module:
// only deps are @deck.gl/core (WebMercatorViewport) and h3-js.

import { WebMercatorViewport } from '@deck.gl/core';
// Geometry reading and the padding clamp live in geo-coords (no deck.gl), and are
// re-exported below so every existing importer of './map-fit' is unaffected.
import {
  boundsOf,
  clampFitPadding,
  isFiniteNum,
  DEFAULT_PADDING,
  type Bounds,
  type LngLat,
  type Padding,
} from './geo-coords';
// Re-exported so every existing importer of './map-fit' keeps working unchanged
// (`export *` alone re-exports without binding the names locally, hence the
// explicit import above).
export * from './geo-coords';

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch?: number;
  bearing?: number;
}

export const DEFAULT_MIN_ZOOM = 2;
export const DEFAULT_MAX_ZOOM = 16;
export const SINGLE_POINT_ZOOM = 14;


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

function clampZoom(z: number, minZoom: number, maxZoom: number): number {
  if (!isFiniteNum(z)) return minZoom;
  return Math.max(minZoom, Math.min(maxZoom, z));
}

function normalizePadding(p: Padding | number | undefined): Padding {
  if (p == null) return DEFAULT_PADDING;
  if (typeof p === 'number') return { top: p, bottom: p, left: p, right: p };
  return p;
}

export function fitBoundsToData(opts: FitOptions): ViewState | null {
  const {
    width,
    height,
    coords,
    bounds: providedBounds,
    fallback = null,
    minZoom = DEFAULT_MIN_ZOOM,
    maxZoom = DEFAULT_MAX_ZOOM,
  } = opts;
  if (!isFiniteNum(width) || !isFiniteNum(height) || width <= 0 || height <= 0) {
    return fallback;
  }

  const padding = clampFitPadding(normalizePadding(opts.padding), width, height);

  const bounds = providedBounds ?? boundsOf(coords ?? []);
  if (!bounds) return fallback;

  const [[minLng, minLat], [maxLng, maxLat]] = bounds;
  const dLng = Math.abs(maxLng - minLng);
  const dLat = Math.abs(maxLat - minLat);

  if (dLng < 1e-9 && dLat < 1e-9) {
    return {
      longitude: minLng,
      latitude: minLat,
      zoom: clampZoom(SINGLE_POINT_ZOOM, minZoom, maxZoom),
      pitch: fallback?.pitch ?? 0,
      bearing: fallback?.bearing ?? 0,
    };
  }

  try {
    const vp = new WebMercatorViewport({ width, height });
    const fitted = vp.fitBounds(bounds as any, { padding: padding as any });
    return {
      longitude: fitted.longitude,
      latitude: fitted.latitude,
      zoom: clampZoom(fitted.zoom, minZoom, maxZoom),
      pitch: fallback?.pitch ?? 0,
      bearing: fallback?.bearing ?? 0,
    };
  } catch {
    return fallback;
  }
}


/** True when every coord's bounding box lies inside the current viewport. */
export function coordsWithinView(
  coords: LngLat[] | null | undefined,
  view: ViewState,
  width: number,
  height: number,
): boolean {
  const dataBounds = boundsOf(coords ?? []);
  if (!dataBounds) return true;
  if (!isFiniteNum(width) || !isFiniteNum(height) || width <= 0 || height <= 0) return true;
  if (!isFiniteNum(view.longitude) || !isFiniteNum(view.latitude) || !isFiniteNum(view.zoom)) return false;

  try {
    const vp = new WebMercatorViewport({
      width,
      height,
      longitude: view.longitude,
      latitude: view.latitude,
      zoom: view.zoom,
      pitch: view.pitch ?? 0,
      bearing: view.bearing ?? 0,
    });
    const viewBounds = vp.getBounds();
    if (!viewBounds) return false;
    const [viewMinLng, viewMinLat, viewMaxLng, viewMaxLat] = viewBounds as [number, number, number, number];
    const [[minLng, minLat], [maxLng, maxLat]] = dataBounds;
    return (
      minLng >= viewMinLng &&
      minLat >= viewMinLat &&
      maxLng <= viewMaxLng &&
      maxLat <= viewMaxLat
    );
  } catch {
    return false;
  }
}
