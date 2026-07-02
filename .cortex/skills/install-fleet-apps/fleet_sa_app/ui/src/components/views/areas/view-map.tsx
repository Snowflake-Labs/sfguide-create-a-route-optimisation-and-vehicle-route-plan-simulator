'use client';

// SA Map area: renders deck.gl layers compiled from a view YAML's
// config.layers (LayerSpec[]). Each layer fetches its own data via SA's
// useViewData (so :params resolve from store context/viewState and auto-refetch
// on region/vehicle change). Register as `Map` in view-renderer AREA_COMPONENTS.

import { useState, useCallback, useMemo, useEffect } from 'react';
import type { Layer } from '@deck.gl/core';
import MapView from './map-view';
import type { LngLat } from '@/lib/map/map-fit';
import type { LayerSpec, MapAreaConfig, LegendItem } from '@/lib/map/layer-spec';
import { compileLayer, layerFitCoords } from '@/lib/map/layer-compiler';
import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';

interface ViewMapAreaProps {
  areaConfig: {
    config: MapAreaConfig;
  };
  // viewState keys that represent a user selection (from ViewRenderer). When one
  // is active, the camera focuses on the selected object's coords only.
  selectionKeys?: string[];
}

interface LayerFetcherProps {
  index: number;
  layer: LayerSpec;
  viewState: Record<string, unknown>;
  selectionKeys: string[];
  hovered: { layerId: string; value: unknown } | null;
  onResult: (
    index: number,
    layer: Layer | null,
    fitFull: LngLat[],
    fitSel: LngLat[],
    template: string | undefined,
  ) => void;
}

/**
 * Coords for the camera to focus on when a selection is active. A layer is
 * "selection-bound" if its query is parametrized by a selection key, or its
 * conditional fillColor highlights by a selection key. Context layers (neither)
 * contribute no focus coords. Returns [] when no selection is active so the
 * caller falls back to framing the full set.
 */
function selectionFitCoords(
  layer: LayerSpec,
  rows: Record<string, any>[],
  viewState: Record<string, unknown>,
  selectionKeys: string[],
): LngLat[] {
  if (!rows.length || selectionKeys.length === 0) return [];
  // Wide context layers opt out of selection framing (e.g. a full ZIP
  // choropleth), so focusing a candidate frames the candidate + its ring only.
  if ((layer as { noFit?: boolean }).noFit) return [];
  const isSel = (k: string) => selectionKeys.includes(k);
  const active = (k: string) => viewState[k] != null && viewState[k] !== '';

  // Query-bound: a param maps to viewState.<selectionKey> and that key is set.
  const params = (layer.data.params ?? {}) as Record<string, string>;
  const queryBoundActive = Object.values(params).some((ref) => {
    const m = /^viewState\.(.+)$/.exec(ref);
    return m != null && isSel(m[1]) && active(m[1]);
  });
  if (queryBoundActive) {
    // Rows are already narrowed by the SQL filter.
    return layerFitCoords(layer, rows) as LngLat[];
  }

  // Color-bound: conditional fillColor highlights rows matching the selection.
  const fc = (layer as any).fillColor;
  if (fc && typeof fc === 'object' && typeof fc.whenViewStateEquals === 'string'
      && isSel(fc.whenViewStateEquals) && active(fc.whenViewStateEquals)) {
    const sel = String(viewState[fc.whenViewStateEquals]);
    const matchCol = fc.matchColumn as string;
    const matched = rows.filter((r) => String(r[matchCol]) === sel);
    return layerFitCoords(layer, matched) as LngLat[];
  }

  return [];
}

/**
 * Fetches one layer's data and lifts the compiled deck.gl Layer + fit coords to
 * the parent. Renders nothing. One child per layer keeps hook order stable.
 */
function LayerFetcher({ index, layer, viewState, selectionKeys, hovered, onResult }: LayerFetcherProps) {
  const { data } = useViewData(layer.data.query, layer.data.params);
  const rows = useMemo(() => (data?.rows ?? []) as Record<string, any>[], [data]);
  useEffect(() => {
    const compiled = compileLayer(layer, rows, viewState, index, hovered);
    const fitFull = layerFitCoords(layer, rows) as LngLat[];
    const fitSel = selectionFitCoords(layer, rows, viewState, selectionKeys);
    onResult(index, compiled, fitFull, fitSel, layer.tooltip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, viewState, selectionKeys, hovered]);
  return null;
}

/** Fill a `{COLUMN}` template from a picked object's properties. Token lookup is
 *  case-insensitive so templates work whether the source columns came back
 *  lower- or UPPER-cased. */
function renderTooltip(template: string, object: Record<string, any>): string {
  let lower: Record<string, any> | null = null;
  return template.replace(/\{(\w+)\}/g, (_, col) => {
    let v = object[col];
    if (v == null) {
      if (!lower) {
        lower = {};
        for (const k of Object.keys(object)) lower[k.toLowerCase()] = object[k];
      }
      v = lower[String(col).toLowerCase()];
    }
    return v == null ? '' : String(v);
  });
}

const WORLD_FALLBACK = { longitude: 0, latitude: 30, zoom: 2, pitch: 0, bearing: 0 };

/** Absolutely-positioned legend card overlay, driven by config.legend. */
function MapLegend({ items }: { items: LegendItem[] }) {
  const rgba = (c: LegendItem['color']) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] ?? 255) / 255})`;
  return (
    <div
      style={{
        position: 'absolute', bottom: 12, left: 12, zIndex: 2,
        background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)',
        border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '8px',
        boxShadow: '0 1px 4px rgba(15,23,42,0.12)', padding: '8px 10px',
        fontSize: '11px', color: 'var(--text-secondary, #4b5563)', pointerEvents: 'none',
      }}
    >
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '2px 0' }}>
          {it.shape === 'line' ? (
            <span style={{ width: '16px', height: '3px', borderRadius: '2px', background: rgba(it.color), flex: '0 0 auto' }} />
          ) : (
            <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: rgba(it.color), flex: '0 0 auto' }} />
          )}
          <span>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

export function ViewMapArea({ areaConfig, selectionKeys = [] }: ViewMapAreaProps) {
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
  const [fitsFull, setFitsFull] = useState<Record<number, LngLat[]>>({});
  const [fitsSel, setFitsSel] = useState<Record<number, LngLat[]>>({});
  const [templates, setTemplates] = useState<Record<string, string>>({});
  // Path hovered in the map -> widen the matching journey (see compileLayer).
  const [hovered, setHovered] = useState<{ layerId: string; value: unknown } | null>(null);

  const onHover = useCallback((info: any) => {
    if (info?.layer && info.object) {
      const value = info.object.journey_id ?? info.object.JOURNEY_ID ?? null;
      const layerId = info.layer.id as string;
      setHovered((prev) =>
        prev && prev.layerId === layerId && String(prev.value) === String(value)
          ? prev
          : { layerId, value },
      );
    } else {
      setHovered((prev) => (prev === null ? prev : null));
    }
  }, []);

  const onResult = useCallback(
    (index: number, layer: Layer | null, fitFull: LngLat[], fitSel: LngLat[], template: string | undefined) => {
      setLayers((prev) => ({ ...prev, [index]: layer }));
      setFitsFull((prev) => ({ ...prev, [index]: fitFull }));
      setFitsSel((prev) => ({ ...prev, [index]: fitSel }));
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

  // When a selection is active, focus on the selected object's coords only
  // (excluding context layers); otherwise frame the full set of all layers.
  const fitCoords = useMemo<LngLat[]>(() => {
    // Collapse every layer's coords into a single bounding box (2 corner
    // points) without spreading large arrays into push() — spreading
    // data-sized arrays overflows the call stack. Downstream fit helpers
    // only ever derive a bounding box from coords, so 2 corners is equivalent.
    const boxFrom = (source: Record<number, LngLat[]>): LngLat[] => {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      let seen = false;
      for (const key of Object.keys(source)) {
        const arr = source[Number(key)];
        if (!arr) continue;
        for (const c of arr) {
          const lng = c[0];
          const lat = c[1];
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          seen = true;
        }
      }
      if (!seen) return [];
      return [[minLng, minLat], [maxLng, maxLat]];
    };
    const sel = boxFrom(fitsSel);
    if (sel.length) return sel;
    return boxFrom(fitsFull);
  }, [fitsSel, fitsFull]);

  // Changes whenever a tracked selection value changes; drives MapView's
  // one-shot focus fit. Empty when nothing is selected (camera stays on clear).
  const focusKey = useMemo(
    () => selectionKeys.map((k) => String(panelViewState[k] ?? '')).filter(Boolean).join('|'),
    [selectionKeys, panelViewState],
  );

  const fallback = useMemo(
    () => config.fallback ?? WORLD_FALLBACK,
    [config.fallback],
  );

  const getTooltip = useCallback(({ object, layer }: any) => {
    if (!object || !layer) return null;
    const tpl = templates[layer.id];
    if (!tpl) return null;
    // GeoJsonLayer picks return a Feature; the source row columns live under
    // `object.properties`, so resolve tokens against properties first, then the
    // object itself (scatterplot/path picks carry columns on the object).
    const src = object.properties && typeof object.properties === 'object'
      ? { ...object, ...object.properties }
      : object;
    return {
      html: renderTooltip(tpl, src),
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, [templates]);

  const regionKey = String(context.region ?? '');

  return (
    <div style={{ position: 'relative', width: '100%', height: config.noPad ? '100%' : (config.height ?? 500), minHeight: 0 }}>
      {specs.map((ls, i) => (
        <LayerFetcher key={i} index={i} layer={ls} viewState={viewState} selectionKeys={selectionKeys} hovered={hovered} onResult={onResult} />
      ))}
      <MapView
        layers={orderedLayers}
        fitTo={{ coords: fitCoords, regionKey, focusKey }}
        fallbackViewState={fallback}
        getTooltip={getTooltip}
        onHover={onHover}
      />
      {config.legend?.length ? <MapLegend items={config.legend} /> : null}
    </div>
  );
}
