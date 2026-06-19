import { useState, useCallback, useMemo, useEffect } from 'react';
import type { Layer } from '@deck.gl/core';
import MapView from '../../shared/MapView';
import type { LngLat } from '../../shared/mapFit';
import type { MapArea as MapAreaSpec, LayerSpec } from '../spec-types';
import { useDataSource } from '../useDataSource';
import { compileLayer, layerFitCoords } from '../layer-compiler';
import type { AreaComponentProps } from './types';
import type { BindingScope } from '../spec-runtime';

interface LayerFetcherProps {
  index: number;
  layer: LayerSpec;
  scope: BindingScope;
  defaults: { database?: string; schema?: string };
  onResult: (index: number, layer: Layer | null, fit: LngLat[], template: string | undefined) => void;
}

/**
 * Fetches one layer's data source and lifts the compiled deck.gl Layer plus
 * its fit coordinates to the parent MapArea. Renders nothing. Using a child
 * component per layer keeps hook order stable regardless of layer count.
 */
function LayerFetcher({ index, layer, scope, defaults, onResult }: LayerFetcherProps) {
  const { rows } = useDataSource(layer.data, scope, defaults);
  useEffect(() => {
    const compiled = compileLayer(layer, rows, scope.viewState, index);
    const fit = layerFitCoords(layer, rows) as LngLat[];
    onResult(index, compiled, fit, layer.tooltip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, scope.viewState]);
  return null;
}

/** Fill a `{COLUMN}` template from a picked object's properties. */
function renderTooltip(template: string, object: Record<string, any>): string {
  return template.replace(/\{(\w+)\}/g, (_, col) => {
    const v = object[col];
    return v == null ? '' : String(v);
  });
}

/**
 * Declarative map area: renders the shared MapView with deck.gl layers compiled
 * from the spec's LayerSpec[]. Camera fits to the union of all layers' coords,
 * falling back to the active region center.
 */
export default function MapArea({ area, scope, defaults }: AreaComponentProps) {
  const spec = area as MapAreaSpec;
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

  // Order layers by their spec index so draw order is deterministic.
  const orderedLayers = useMemo<Layer[]>(
    () => spec.layers.map((_, i) => layers[i]).filter((l): l is Layer => !!l),
    [spec.layers, layers],
  );

  const fitCoords = useMemo<LngLat[]>(() => {
    const all: LngLat[] = [];
    for (const i of Object.keys(fits)) all.push(...fits[Number(i)]);
    return all;
  }, [fits]);

  const fallback = useMemo(
    () => ({ longitude: scope.region.center.lng, latitude: scope.region.center.lat, zoom: scope.region.zoom, pitch: 0, bearing: 0 }),
    [scope.region.center.lng, scope.region.center.lat, scope.region.zoom],
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

  const height = spec.height ?? 500;

  return (
    <div className="map-area" style={{ position: 'relative', height: spec.noPad ? '100%' : height, minHeight: 0 }}>
      {spec.layers.map((ls, i) => (
        <LayerFetcher key={i} index={i} layer={ls} scope={scope} defaults={defaults} onResult={onResult} />
      ))}
      <MapView
        layers={orderedLayers}
        fitTo={{ coords: fitCoords, regionKey: scope.region.regionName }}
        fallbackViewState={fallback}
        getTooltip={getTooltip}
      />
    </div>
  );
}
