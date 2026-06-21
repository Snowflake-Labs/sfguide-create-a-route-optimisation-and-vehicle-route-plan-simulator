'use client';

// SA Map area: renders deck.gl layers compiled from a view YAML's
// config.layers (LayerSpec[]). Each layer fetches its own data via SA's
// useViewData (so :params resolve from store context/viewState and auto-refetch
// on region/vehicle change). Register as `Map` in view-renderer AREA_COMPONENTS.

import { useState, useCallback, useMemo, useEffect } from 'react';
import type { Layer } from '@deck.gl/core';
import MapView from './map-view';
import type { LngLat } from '@/lib/map/map-fit';
import type { LayerSpec, MapAreaConfig } from '@/lib/map/layer-spec';
import { compileLayer, layerFitCoords } from '@/lib/map/layer-compiler';
import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';

interface ViewMapAreaProps {
  areaConfig: {
    config: MapAreaConfig;
  };
}

interface LayerFetcherProps {
  index: number;
  layer: LayerSpec;
  viewState: Record<string, unknown>;
  onResult: (index: number, layer: Layer | null, fit: LngLat[], template: string | undefined) => void;
}

/**
 * Fetches one layer's data and lifts the compiled deck.gl Layer + fit coords to
 * the parent. Renders nothing. One child per layer keeps hook order stable.
 */
function LayerFetcher({ index, layer, viewState, onResult }: LayerFetcherProps) {
  const { data } = useViewData(layer.data.query, layer.data.params);
  const rows = useMemo(() => (data?.rows ?? []) as Record<string, any>[], [data]);
  useEffect(() => {
    const compiled = compileLayer(layer, rows, viewState, index);
    const fit = layerFitCoords(layer, rows) as LngLat[];
    onResult(index, compiled, fit, layer.tooltip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, viewState]);
  return null;
}

/** Fill a `{COLUMN}` template from a picked object's properties. */
function renderTooltip(template: string, object: Record<string, any>): string {
  return template.replace(/\{(\w+)\}/g, (_, col) => {
    const v = object[col];
    return v == null ? '' : String(v);
  });
}

const WORLD_FALLBACK = { longitude: 0, latitude: 30, zoom: 2, pitch: 0, bearing: 0 };

export function ViewMapArea({ areaConfig }: ViewMapAreaProps) {
  const config = areaConfig.config;
  const specs = config.layers ?? [];

  const panelViewState = useAppStore((s) => s.panel.viewState);
  const context = useAppStore((s) => s.context);
  // Merge context (region/vehicle) and viewState so conditional colors
  // (whenViewStateEquals) and clickable-table selections both resolve.
  const viewState = useMemo(
    () => ({ ...context, ...panelViewState }) as Record<string, unknown>,
    [context, panelViewState],
  );

  const [layers, setLayers] = useState<Record<number, Layer | null>>({});
  const [fits, setFits] = useState<Record<number, LngLat[]>>({});
  const [templates, setTemplates] = useState<Record<string, string>>({});

  const onResult = useCallback(
    (index: number, layer: Layer | null, fit: LngLat[], template: string | undefined) => {
      setLayers((prev) => ({ ...prev, [index]: layer }));
      setFits((prev) => ({ ...prev, [index]: fit }));
      if (template) {
        const id = layer?.id ?? `spec-layer-${index}`;
        setTemplates((prev) => ({ ...prev, [id]: template }));
      }
    },
    [],
  );

  const orderedLayers = useMemo<Layer[]>(
    () => specs.map((_, i) => layers[i]).filter((l): l is Layer => !!l),
    [specs, layers],
  );

  const fitCoords = useMemo<LngLat[]>(() => {
    const all: LngLat[] = [];
    for (const i of Object.keys(fits)) all.push(...fits[Number(i)]);
    return all;
  }, [fits]);

  const fallback = useMemo(
    () => config.fallback ?? WORLD_FALLBACK,
    [config.fallback],
  );

  const getTooltip = useCallback(({ object, layer }: any) => {
    if (!object || !layer) return null;
    const tpl = templates[layer.id];
    if (!tpl) return null;
    return {
      html: renderTooltip(tpl, object),
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, [templates]);

  const regionKey = String(context.region ?? '');

  return (
    <div style={{ position: 'relative', width: '100%', height: config.noPad ? '100%' : (config.height ?? 500), minHeight: 0 }}>
      {specs.map((ls, i) => (
        <LayerFetcher key={i} index={i} layer={ls} viewState={viewState} onResult={onResult} />
      ))}
      <MapView
        layers={orderedLayers}
        fitTo={{ coords: fitCoords, regionKey }}
        fallbackViewState={fallback}
        getTooltip={getTooltip}
      />
    </div>
  );
}
