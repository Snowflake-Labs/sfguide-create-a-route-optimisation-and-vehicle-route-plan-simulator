'use client';

// deck.gl map canvas with a CARTO raster basemap and data-driven camera fit.
// Ported from the control app's shared/MapView.tsx; changes: 'use client' and
// the map-fit import path.

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import type { Layer } from '@deck.gl/core';
import {
  fitBoundsToData,
  coordsSignature,
  coordsWithinView,
  DEFAULT_PADDING,
  type LngLat,
  type Padding,
  type ViewState,
} from '@/lib/map/map-fit';

interface FitToOptions {
  coords?: LngLat[] | null;
  padding?: Padding | number;
  minZoom?: number;
  maxZoom?: number;
  regionKey?: string;
  // When this changes to a non-empty value, force a one-shot fit to the current
  // coords - even if the user has panned/zoomed or the coords are already in
  // view. Used to focus the camera on a freshly selected object (trip, driver,
  // offer, computed result). Clearing the selection (empty focusKey) does NOT
  // move the camera. The forced fit waits for the coords signature to actually
  // change so it lands on the new (narrowed) coords, not the stale set still
  // showing during an in-flight refetch.
  focusKey?: string;
}

interface MapViewProps {
  layers?: Layer[];
  initialViewState?: ViewState;
  fitTo?: FitToOptions;
  fallbackViewState?: ViewState;
  onClick?: (info: any) => void;
  onViewStateChange?: (viewState: any) => void;
  getTooltip?: (info: any) => any;
  onHover?: (info: any) => void;
  onRecenterReady?: (recenter: () => void) => void;
  children?: React.ReactNode;
}

const DEFAULT_VIEW: ViewState = { longitude: 0, latitude: 30, zoom: 2, pitch: 0, bearing: 0 };
const CARTO_TILES = '/api/tiles/{z}/{x}/{y}';

function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap',
    data: CARTO_TILES,
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, {
        data: undefined,
        image: props.data,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
      });
    },
  });
}

function isValidViewState(vs: any): boolean {
  return vs &&
    Number.isFinite(vs.longitude) &&
    Number.isFinite(vs.latitude) &&
    Number.isFinite(vs.zoom);
}

export default function MapView({
  layers = [],
  initialViewState,
  fitTo,
  fallbackViewState,
  onClick,
  onViewStateChange,
  getTooltip,
  onHover,
  onRecenterReady,
  children,
}: MapViewProps) {
  const [viewState, setViewState] = useState<ViewState>({
    ...DEFAULT_VIEW,
    ...(fallbackViewState || {}),
    ...(initialViewState || {}),
  });
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [recenterTick, setRecenterTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevInitRef = useRef(initialViewState);
  const hasFittedRef = useRef(false);
  const lastRegionRef = useRef<string | undefined>(fitTo?.regionKey);
  const forceFitRef = useRef(false);
  const userMovedRef = useRef(false);
  const lastFocusRef = useRef<string | undefined>(fitTo?.focusKey);
  const focusPendingRef = useRef(false);
  const focusBaselineSigRef = useRef<string>('');
  const basemap = useMemo(() => cartoBasemap(), []);

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
    const fallbackTimer = setTimeout(() => {
      setDims(prev => {
        if (prev) return prev;
        const w = el.clientWidth || window.innerWidth;
        const h = el.clientHeight || (window.innerHeight - el.getBoundingClientRect().top);
        return (w > 0 && h > 0) ? { width: Math.round(w), height: Math.round(h) } : null;
      });
    }, 500);
    return () => { ro.disconnect(); clearTimeout(fallbackTimer); };
  }, []);

  const fitCoords = fitTo?.coords;
  const fitPadding = fitTo?.padding;
  const fitMinZoom = fitTo?.minZoom;
  const fitMaxZoom = fitTo?.maxZoom;
  const fitRegionKey = fitTo?.regionKey;
  const fitFocusKey = fitTo?.focusKey;
  const fitSig = useMemo(() => coordsSignature(fitCoords ?? null), [fitCoords]);

  if (lastRegionRef.current !== fitRegionKey) {
    lastRegionRef.current = fitRegionKey;
    hasFittedRef.current = false;
    userMovedRef.current = false;
  }

  // A selection became active or changed: mark a pending forced fit and capture
  // the current coords signature as a baseline. The fit fires only once the
  // signature changes (fresh narrowed coords arrived), so it lands on the
  // selected object instead of the stale full set. Clearing the selection
  // (empty focusKey) records the change but does NOT pend a fit - camera stays.
  if (lastFocusRef.current !== fitFocusKey) {
    lastFocusRef.current = fitFocusKey;
    if (fitFocusKey) {
      focusPendingRef.current = true;
      focusBaselineSigRef.current = fitSig;
      userMovedRef.current = false;
    }
  }

  useEffect(() => {
    if (!dims) return;
    if (!fitTo || !fitCoords || fitCoords.length === 0) return;
    const forcedByFocus = focusPendingRef.current && fitSig !== focusBaselineSigRef.current;
    const firstFit = !hasFittedRef.current || forceFitRef.current || forcedByFocus;
    if (!firstFit) {
      if (userMovedRef.current) return;
      if (coordsWithinView(fitCoords, viewStateRef.current, dims.width, dims.height)) return;
    }

    const next = fitBoundsToData({
      width: dims.width,
      height: dims.height,
      coords: fitCoords,
      padding: fitPadding ?? DEFAULT_PADDING,
      minZoom: fitMinZoom,
      maxZoom: fitMaxZoom,
      fallback: fallbackViewState,
    });
    if (next && isValidViewState(next)) {
      hasFittedRef.current = true;
      forceFitRef.current = false;
      if (forcedByFocus) focusPendingRef.current = false;
      setViewState(prev => ({ ...prev, ...next }));
    }
  }, [dims, fitSig, fitCoords, fitPadding, fitMinZoom, fitMaxZoom, fitRegionKey, fitFocusKey, fallbackViewState, fitTo, recenterTick]);

  if (initialViewState && initialViewState !== prevInitRef.current) {
    const changed = !prevInitRef.current ||
      initialViewState.longitude !== prevInitRef.current.longitude ||
      initialViewState.latitude !== prevInitRef.current.latitude ||
      initialViewState.zoom !== prevInitRef.current.zoom;
    if (changed) {
      prevInitRef.current = initialViewState;
      setViewState(prev => ({ ...prev, ...initialViewState }));
    }
  }

  const handleViewStateChange = useCallback(({ viewState: vs, interactionState }: any) => {
    if (!isValidViewState(vs)) return;
    if (interactionState && (interactionState.isDragging || interactionState.isPanning ||
        interactionState.isZooming || interactionState.isRotating)) {
      userMovedRef.current = true;
    }
    setViewState(vs);
    onViewStateChange?.(vs);
  }, [onViewStateChange]);

  const recenter = useCallback(() => {
    forceFitRef.current = true;
    hasFittedRef.current = false;
    userMovedRef.current = false;
    setRecenterTick(t => t + 1);
  }, []);

  useEffect(() => {
    if (onRecenterReady) onRecenterReady(recenter);
  }, [onRecenterReady, recenter]);

  const allLayers = useMemo(() => [basemap, ...layers], [basemap, layers]);

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      {dims && (
        <DeckGL
          width={dims.width}
          height={dims.height}
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          layers={allLayers}
          controller={true}
          onClick={onClick}
          onHover={onHover}
          getTooltip={getTooltip}
          style={{ position: 'absolute', top: '0', left: '0', width: `${dims.width}px`, height: `${dims.height}px` }}
        />
      )}
      {children}
    </div>
  );
}
