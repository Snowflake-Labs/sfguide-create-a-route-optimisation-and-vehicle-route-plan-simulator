import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import type { Layer } from '@deck.gl/core';
import {
  fitBoundsToData,
  coordsSignature,
  DEFAULT_PADDING,
  type LngLat,
  type Padding,
  type ViewState,
} from './mapFit';

interface FitToOptions {
  coords?: LngLat[] | null;
  padding?: Padding | number;
  minZoom?: number;
  maxZoom?: number;
}

interface MapViewProps {
  layers?: Layer[];
  initialViewState?: ViewState;
  fitTo?: FitToOptions;
  fallbackViewState?: ViewState;
  onClick?: (info: any) => void;
  onViewStateChange?: (viewState: any) => void;
  getTooltip?: (info: any) => any;
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
  children,
}: MapViewProps) {
  const [viewState, setViewState] = useState<ViewState>({
    ...DEFAULT_VIEW,
    ...(fallbackViewState || {}),
    ...(initialViewState || {}),
  });
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevInitRef = useRef(initialViewState);
  const lastFitSigRef = useRef<string>('');
  const lastDimsRef = useRef<string>('');
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
  const fitSig = useMemo(() => coordsSignature(fitCoords ?? null), [fitCoords]);

  useEffect(() => {
    if (!dims) return;
    if (!fitTo || !fitCoords || fitCoords.length === 0) return;
    const dimsKey = `${dims.width}x${dims.height}`;
    if (lastFitSigRef.current === fitSig && lastDimsRef.current === dimsKey) return;

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
      lastFitSigRef.current = fitSig;
      lastDimsRef.current = dimsKey;
      setViewState(prev => ({ ...prev, ...next }));
    }
  }, [dims, fitSig, fitCoords, fitPadding, fitMinZoom, fitMaxZoom, fallbackViewState, fitTo]);

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

  const handleViewStateChange = useCallback(({ viewState: vs }: any) => {
    if (!isValidViewState(vs)) return;
    setViewState(vs);
    onViewStateChange?.(vs);
  }, [onViewStateChange]);

  const allLayers = useMemo(() => [basemap, ...layers], [basemap, layers]);

  return (
    <div className="map-view" ref={containerRef}>
      {dims && (
        <DeckGL
          width={dims.width}
          height={dims.height}
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          layers={allLayers}
          controller={true}
          onClick={onClick}
          getTooltip={getTooltip}
          style={{ position: 'absolute', top: '0', left: '0', width: `${dims.width}px`, height: `${dims.height}px` }}
        />
      )}
      {children}
    </div>
  );
}
