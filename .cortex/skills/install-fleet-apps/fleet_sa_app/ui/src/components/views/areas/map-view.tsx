'use client';

// deck.gl map canvas with a CARTO vector basemap and data-driven camera fit.
// Ported from the control app's shared/MapView.tsx; changes: 'use client' and
// the map-fit import path.

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import type { Layer } from '@deck.gl/core';
import Basemap from './basemap';
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
  // Fit once on load (plus a short settle window while the remaining layers
  // report their coords), then stop auto-fitting entirely: selections, layer
  // toggles and periodic refetches never move the camera. A regionKey change
  // still re-arms the initial fit, and an explicit recenter still works.
  lockAfterFirstFit?: boolean;
  // One-shot camera focus on a single point, independent of the coords fit. When
  // the point changes the camera pans to it (and zooms, when `zoom` is given).
  // Deliberately bypasses lockAfterFirstFit: it is an explicit user gesture (a
  // table row click), not an automatic re-frame, and it does not re-arm the
  // auto-fit machinery.
  focusPoint?: { lng: number; lat: number; zoom?: number } | null;
  // Bounding-box corners of the ACTIVE region (2 coords is enough). Used to frame
  // the region immediately when regionKey changes, before that region's layer
  // data has arrived - and to keep framing it when a view has no rows for the
  // region at all (otherwise the camera would sit on the previous region, or at
  // world zoom on first load). This is a provisional fit: the real data fit is
  // still forced once fresh coords arrive, so the final framing is unchanged.
  regionCoords?: LngLat[] | null;
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

// Grace period after the first fit during which a locked camera still accepts
// fits, so late-arriving layers widen the initial frame before it freezes.
const LOCK_SETTLE_MS = 2000;

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
  // Wall-clock of the first successful fit, used by lockAfterFirstFit to keep
  // accepting fits until the async layer loads have settled (a lock applied on
  // the very first layer's coords would freeze a partial bounding box).
  const firstFitAtRef = useRef<number>(0);
  // A region change (or first mount) is pending a real data fit. Kept armed until
  // coords that differ from the ones showing at the moment of the change arrive,
  // so the forced fit lands on the NEW region's data and not on the stale set
  // still rendered during the refetch.
  const regionPendingRef = useRef(true);
  const regionBaselineSigRef = useRef<string>('');

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
  const fitLocked = fitTo?.lockAfterFirstFit ?? false;
  const focusPoint = fitTo?.focusPoint ?? null;
  const regionCoords = fitTo?.regionCoords ?? null;
  const fitSig = useMemo(() => coordsSignature(fitCoords ?? null), [fitCoords]);

  if (lastRegionRef.current !== fitRegionKey) {
    lastRegionRef.current = fitRegionKey;
    hasFittedRef.current = false;
    userMovedRef.current = false;
    firstFitAtRef.current = 0;
    // Arm the region handling: frame the region bbox right away, and force the
    // next data fit even if the (still stale) coords happen to be in view.
    regionPendingRef.current = true;
    regionBaselineSigRef.current = fitSig;
  }

  // A selection became active or changed: mark a pending forced fit and capture
  // the current coords signature as a baseline. The fit fires only once the
  // signature changes (fresh narrowed coords arrived), so it lands on the
  // selected object instead of the stale full set. Clearing the selection
  // (empty focusKey) records the change but does NOT pend a fit - camera stays.
  if (lastFocusRef.current !== fitFocusKey) {
    lastFocusRef.current = fitFocusKey;
    if (fitFocusKey && !fitLocked) {
      focusPendingRef.current = true;
      focusBaselineSigRef.current = fitSig;
      userMovedRef.current = false;
    }
  }

  useEffect(() => {
    if (!dims) return;
    if (!fitTo || !fitCoords || fitCoords.length === 0) return;
    const explicitRecenter = forceFitRef.current;
    // Locked: only the initial fit (and the settle window right after it) may
    // move the camera; everything later is the user's own view.
    if (
      fitLocked &&
      !explicitRecenter &&
      hasFittedRef.current &&
      Date.now() - firstFitAtRef.current > LOCK_SETTLE_MS
    ) {
      focusPendingRef.current = false;
      return;
    }
    const forcedByFocus = focusPendingRef.current && fitSig !== focusBaselineSigRef.current;
    const forcedByRegion = regionPendingRef.current && fitSig !== regionBaselineSigRef.current;
    const firstFit = !hasFittedRef.current || explicitRecenter || forcedByFocus || forcedByRegion;
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
      if (!hasFittedRef.current) firstFitAtRef.current = Date.now();
      hasFittedRef.current = true;
      forceFitRef.current = false;
      if (forcedByFocus) focusPendingRef.current = false;
      if (forcedByRegion) regionPendingRef.current = false;
      setViewState(prev => ({ ...prev, ...next }));
    }
  }, [dims, fitSig, fitCoords, fitPadding, fitMinZoom, fitMaxZoom, fitRegionKey, fitFocusKey, fitLocked, fallbackViewState, fitTo, recenterTick]);

  // Provisional region framing. Declared AFTER the data fit on purpose: in the
  // commit where the region changed, the data fit above still sees the previous
  // region's coords, so this must run last to win. It intentionally does NOT set
  // hasFittedRef / firstFitAtRef - the forced data fit still follows (and starts
  // the lock settle window), so a locked camera is unaffected. When the view has
  // no data for the region, regionPendingRef stays armed and this stays as the
  // final camera instead of the stale or world-zoom view.
  const lastRegionPrefitRef = useRef<string>('');
  useEffect(() => {
    if (!dims) return;
    if (!regionCoords || regionCoords.length === 0) return;
    if (!regionPendingRef.current) return;
    const sig = `${fitRegionKey ?? ''}|${coordsSignature(regionCoords)}`;
    if (lastRegionPrefitRef.current === sig) return;
    lastRegionPrefitRef.current = sig;
    const next = fitBoundsToData({
      width: dims.width,
      height: dims.height,
      coords: regionCoords,
      padding: fitPadding ?? DEFAULT_PADDING,
      minZoom: fitMinZoom,
      maxZoom: fitMaxZoom,
      fallback: fallbackViewState,
    });
    if (next && isValidViewState(next)) {
      setViewState(prev => ({ ...prev, ...next }));
    }
  }, [dims, regionCoords, fitRegionKey, fitPadding, fitMinZoom, fitMaxZoom, fallbackViewState]);

  // Explicit one-shot focus (row click). Keyed on the point signature so it
  // fires once per new point and never fights the user's own panning after.
  const focusSig = focusPoint
    ? `${focusPoint.lng},${focusPoint.lat},${focusPoint.zoom ?? ''}`
    : '';
  const lastFocusPointRef = useRef<string>(focusSig);
  useEffect(() => {
    if (!focusPoint || !focusSig) return;
    if (lastFocusPointRef.current === focusSig) return;
    lastFocusPointRef.current = focusSig;
    if (!Number.isFinite(focusPoint.lng) || !Number.isFinite(focusPoint.lat)) return;
    // Treat as a user-driven move so the auto-fit does not immediately pull the
    // camera back to the data extent on the next data change.
    userMovedRef.current = true;
    setViewState((prev) => ({
      ...prev,
      longitude: focusPoint.lng,
      latitude: focusPoint.lat,
      ...(focusPoint.zoom != null ? { zoom: focusPoint.zoom } : {}),
    }));
  }, [focusSig, focusPoint]);

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

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
      {dims && (
        <>
          <Basemap viewState={viewState} />
          <DeckGL
            width={dims.width}
            height={dims.height}
            viewState={viewState}
            onViewStateChange={handleViewStateChange}
            layers={layers}
            controller={true}
            onClick={onClick}
            onHover={onHover}
            getTooltip={getTooltip}
            style={{ position: 'absolute', top: '0', left: '0', width: `${dims.width}px`, height: `${dims.height}px` }}
          />
        </>
      )}
      {children}
    </div>
  );
}
