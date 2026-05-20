import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  fitBoundsToData,
  coordsSignature,
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
}

export interface UseFitMapResult {
  containerRef: React.RefObject<HTMLDivElement>;
  dims: { width: number; height: number } | null;
  viewState: ViewState;
  setViewState: (vs: ViewState) => void;
  onViewStateChange: (e: { viewState: any }) => void;
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
  const { fallback, padding = DEFAULT_PADDING, minZoom, maxZoom, pitch } = options;
  const initial: ViewState = {
    ...DEFAULT_FALLBACK,
    ...sanitizeVS(fallback),
    ...(Number.isFinite(pitch as number) ? { pitch: pitch as number } : {}),
  };

  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [viewState, setViewState] = useState<ViewState>(initial);
  const lastFitSigRef = useRef<string>('');
  const lastDimsKeyRef = useRef<string>('');

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
    const dimsKey = `${dims.width}x${dims.height}`;
    if (lastFitSigRef.current === sig && lastDimsKeyRef.current === dimsKey) return;
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
      lastFitSigRef.current = sig;
      lastDimsKeyRef.current = dimsKey;
      setViewState(prev => ({
        ...prev,
        longitude: next.longitude,
        latitude: next.latitude,
        zoom: next.zoom,
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims, sig]);

  const onViewStateChange = useCallback((e: { viewState: any }) => {
    const vs = e.viewState;
    if (isFiniteVS(vs)) setViewState(vs);
  }, []);

  return { containerRef, dims, viewState, setViewState, onViewStateChange };
}
