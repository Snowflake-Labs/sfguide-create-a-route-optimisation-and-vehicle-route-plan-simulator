import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { FlyToInterpolator } from '@deck.gl/core';
import {
  fitBoundsToData,
  coordsSignature,
  coordsWithinView,
  DEFAULT_PADDING,
  type LngLat,
  type Padding,
  type ViewState,
} from './mapFit';

export interface UseFitMapOptions {
  fallback?: ViewState;
  padding?: Padding | number;
  minZoom?: number;
  maxZoom?: number;
  pitch?: number;
  /**
   * Identifier for the active region/area. The map auto-fits on the first
   * non-empty data load and re-fits when this key changes (e.g. region switch).
   * Subsequent data updates re-fit only when the new objects fall outside the
   * current viewport.
   */
  regionKey?: string;
}

export interface UseFitMapResult {
  containerRef: React.RefObject<HTMLDivElement>;
  dims: { width: number; height: number } | null;
  viewState: ViewState;
  setViewState: (vs: ViewState) => void;
  onViewStateChange: (e: { viewState: any }) => void;
  /** Manually re-fit the camera to the current coords. */
  recenter: () => void;
}

const DEFAULT_FALLBACK: ViewState = { longitude: 0, latitude: 30, zoom: 2, pitch: 0, bearing: 0 };

export function isFiniteVS(vs: any): boolean {
  return vs && Number.isFinite(vs.longitude) && Number.isFinite(vs.latitude) && Number.isFinite(vs.zoom);
}

function sanitizeVS(vs: Partial<ViewState> | undefined | null): Partial<ViewState> {
  if (!vs) return {};
  const out: Partial<ViewState> = {};
  if (Number.isFinite(vs.longitude)) out.longitude = vs.longitude as number;
  if (Number.isFinite(vs.latitude)) out.latitude = vs.latitude as number;
  if (Number.isFinite(vs.zoom)) out.zoom = vs.zoom as number;
  if (Number.isFinite(vs.pitch)) out.pitch = vs.pitch as number;
  if (Number.isFinite(vs.bearing)) out.bearing = vs.bearing as number;
  return out;
}

export function useFitMap(
  coords: LngLat[] | null | undefined,
  options: UseFitMapOptions = {}
): UseFitMapResult {
  const { fallback, padding = DEFAULT_PADDING, minZoom, maxZoom, pitch, regionKey } = options;
  const initial: ViewState = {
    ...DEFAULT_FALLBACK,
    ...sanitizeVS(fallback),
    ...(Number.isFinite(pitch as number) ? { pitch: pitch as number } : {}),
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [viewState, setViewState] = useState<ViewState>(initial);
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const [recenterTick, setRecenterTick] = useState(0);
  const hasFittedRef = useRef(false);
  const lastRegionRef = useRef<string | undefined>(regionKey);
  const forceFitRef = useRef(false);
  const echoGuardRef = useRef(0);
  const coordsRef = useRef(coords);
  coordsRef.current = coords;
  const dimsRef = useRef(dims);
  dimsRef.current = dims;

  // Reset the fit-once gate when the active region changes.
  if (lastRegionRef.current !== regionKey) {
    lastRegionRef.current = regionKey;
    hasFittedRef.current = false;
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setDims({ width: Math.round(width), height: Math.round(height) });
      }
    });
    ro.observe(el);
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      setDims({ width: el.clientWidth, height: el.clientHeight });
    }
    return () => ro.disconnect();
  }, []);

  const sig = useMemo(() => coordsSignature(coords ?? null), [coords]);

  useEffect(() => {
    if (!dims) return;
    if (!coords || coords.length === 0) return;
    const firstFit = !hasFittedRef.current || forceFitRef.current;
    if (!firstFit && coordsWithinView(coords, viewStateRef.current, dims.width, dims.height)) return;
    const next = fitBoundsToData({
      width: dims.width,
      height: dims.height,
      coords,
      padding,
      minZoom,
      maxZoom,
      fallback: initial,
    });
    if (next && isFiniteVS(next)) {
      hasFittedRef.current = true;
      forceFitRef.current = false;
      echoGuardRef.current = 2;
      setViewState(prev => ({
        ...prev,
        longitude: next.longitude,
        latitude: next.latitude,
        zoom: next.zoom,
        transitionDuration: 600,
        transitionInterpolator: new FlyToInterpolator(),
      } as ViewState));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims, sig, regionKey, recenterTick]);

  const onViewStateChange = useCallback((e: { viewState: any }) => {
    if (echoGuardRef.current > 0) {
      echoGuardRef.current -= 1;
      return;
    }
    const vs = e.viewState;
    if (isFiniteVS(vs)) setViewState(vs);
  }, []);

  const recenter = useCallback(() => {
    forceFitRef.current = true;
    hasFittedRef.current = false;
    setRecenterTick(t => t + 1);
  }, []);

  return { containerRef, dims, viewState, setViewState, onViewStateChange, recenter };
}
