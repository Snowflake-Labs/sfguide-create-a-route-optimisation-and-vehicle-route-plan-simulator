'use client';

// SA Map area: renders deck.gl layers compiled from a view YAML's
// config.layers (LayerSpec[]). Each layer fetches its own data via SA's
// useViewData (so :params resolve from store context/viewState and auto-refetch
// on region/vehicle change). Register as `Map` in view-renderer AREA_COMPONENTS.

import { useState, useCallback, useMemo, useEffect, useRef, startTransition, type ReactNode } from 'react';
import type { Layer } from '@deck.gl/core';
import MapView from './map-view';
import type { LngLat } from '@/lib/map/map-fit';
import type { LayerSpec, MapAreaConfig, LegendItem, MapToggleItem, MapClickEmits } from '@/lib/map/layer-spec';
import { compileLayerWithFit, layerFitCoords } from '@/lib/map/layer-compiler';
import { useViewData } from '@/hooks/use-view-data';
import { useRegionCamera } from '@/hooks/use-region-camera';
import { useAppStore } from '@/lib/store';
import { escapeHtml } from '@/lib/html';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';
import type { SuspendedInfo } from '@/lib/routing-suspend';
import type { MapStateDescriptor, MapLayerDescriptor } from '@/lib/types';

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
  // Whether this layer is currently toggled on (config.visibleWhen). When false
  // the layer skips its data fetch and reports no compiled layer / fit coords.
  visible: boolean;
  onResult: (
    index: number,
    layer: Layer | null,
    fitFull: LngLat[],
    fitSel: LngLat[],
    template: string | undefined,
    count: number,
  ) => void;
  // Report a suspended routing engine (or null when clear) so the parent can
  // overlay a single friendly notice for the whole map.
  onSuspended: (index: number, info: SuspendedInfo | null, retry: () => void) => void;
}

/**
 * Coords for the camera to focus on when a selection is active. A layer is
 * "selection-bound" if its query is parametrized by a selection key, or its
 * conditional fillColor highlights by a selection key. Context layers (neither)
 * contribute no focus coords. Returns [] when no selection is active so the
 * caller falls back to framing the full set.
 *
 * `fitFull` is the layer's already-parsed full fit coords (from
 * compileLayerWithFit), reused for the query-bound case so no re-parse happens;
 * only the color-bound branch re-derives fit from the matched subset.
 */
function selectionFit(
  layer: LayerSpec,
  rows: Record<string, any>[],
  viewState: Record<string, unknown>,
  selectionKeys: string[],
  fitFull: LngLat[],
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
  // Rows are already narrowed by the SQL filter, so the full fit == selection fit.
  if (queryBoundActive) return fitFull;

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
 *
 * The heavy compile (GeoJSON parse + decimation) is deferred to an idle frame so
 * the basemap paints first, and its result is committed inside startTransition
 * so it is a non-urgent update. This keeps the basemap and UI responsive even
 * when a layer carries multi-MB route geometry.
 */
function LayerFetcher({ index, layer, viewState, selectionKeys, hovered, visible, onResult, onSuspended }: LayerFetcherProps) {
  // Skip the fetch entirely when the layer is toggled off (undefined query
  // short-circuits useViewData) - avoids wasted (and sometimes expensive, e.g.
  // live-ORS) queries for hidden layers.
  const { data, suspended, refetch } = useViewData(visible ? layer.data.query : undefined, layer.data.params);
  const rows = useMemo(() => (data?.rows ?? []) as Record<string, any>[], [data]);
  // A suspended region (live-ORS layer) no longer fails silently: report it up
  // so the map shows the shared resume notice instead of an empty basemap.
  useEffect(() => {
    onSuspended(index, visible ? suspended : null, refetch);
  }, [index, visible, suspended, refetch, onSuspended]);
  useEffect(() => {
    if (!visible) {
      onResult(index, null, [], [], undefined, 0);
      return;
    }
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      // Single parse: layer data + full fit coords derived from one pass.
      const { layer: compiled, fitCoords } = compileLayerWithFit(layer, rows, viewState, index, hovered);
      const fitFull = fitCoords as LngLat[];
      const fitSel = selectionFit(layer, rows, viewState, selectionKeys, fitFull);
      startTransition(() => {
        if (!cancelled) onResult(index, compiled, fitFull, fitSel, layer.tooltip, rows.length);
      });
    };
    const ric = (typeof window !== 'undefined'
      ? (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
      : undefined);
    let idleId: number | undefined;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    if (ric) idleId = ric(run, { timeout: 300 });
    else timerId = setTimeout(run, 0);
    return () => {
      cancelled = true;
      const cic = typeof window !== 'undefined'
        ? (window as unknown as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback
        : undefined;
      if (idleId != null && cic) cic(idleId);
      if (timerId != null) clearTimeout(timerId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, viewState, selectionKeys, hovered, visible]);
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
    // Escaped: this string is returned in a deck.gl tooltip `html` field
    // (rendered via innerHTML), and column values can be arbitrary free text.
    return v == null ? '' : escapeHtml(v);
  });
}

const WORLD_FALLBACK = { longitude: 0, latitude: 30, zoom: 2, pitch: 0, bearing: 0 };

/** Column a layer colors features by, when it encodes color from data (used only
 *  for the agent's map summary). Returns undefined for static-color layers. */
function colorFieldOf(spec: LayerSpec): string | undefined {
  const s = spec as Record<string, any>;
  const fc = s.fillColor;
  if (fc && typeof fc === 'object') {
    if (typeof fc.column === 'string') return fc.column;          // categorical
    if (typeof fc.baseColumn === 'string') return fc.baseColumn;  // conditional + palette
  }
  if (typeof s.colorColumn === 'string') return s.colorColumn;    // geojson
  if (typeof s.valueColumn === 'string') return s.valueColumn;    // h3
  return undefined;
}
/** Bounded, scalar-only snapshot of a clicked feature's columns for the agent's
 *  map summary. Keeps only string/number/boolean values (drops nulls, empties,
 *  nested objects/arrays), truncates long strings, and caps the key count so the
 *  chat context stays cheap - never a full per-feature row dump. */
function sanitizeAttrs(src: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(src)) {
    if (n >= 20) break;
    if (v == null) continue;
    const t = typeof v;
    if (t === 'number' || t === 'boolean') {
      out[k] = v as number | boolean;
      n++;
    } else if (t === 'string') {
      const str = v as string;
      if (str === '') continue;
      out[k] = str.length > 80 ? str.slice(0, 80) + '...' : str;
      n++;
    }
    // objects / arrays / functions are intentionally skipped
  }
  return out;
}
/** Shared card chrome for the map overlays (legend + toggles). Collapsible via a
 *  clickable header with a chevron. `corner` positions the card. */
function OverlayCard({
  title, corner, children,
}: { title: string; corner: 'bottom-left' | 'top-right' | 'bottom-right'; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const pos =
    corner === 'bottom-left'
      ? { bottom: 12, left: 12 }
      : corner === 'bottom-right'
        ? { bottom: 12, right: 12 }
        : { top: 12, right: 12 };
  return (
    <div
      style={{
        position: 'absolute', zIndex: 2, ...pos,
        background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(4px)',
        border: '1px solid var(--border-default, #e5e7eb)', borderRadius: '8px',
        boxShadow: '0 1px 4px rgba(15,23,42,0.12)',
        fontSize: '11px', color: 'var(--text-secondary, #4b5563)', pointerEvents: 'auto',
        minWidth: '120px',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
          width: '100%', padding: '6px 10px', background: 'transparent', border: 'none',
          cursor: 'pointer', font: 'inherit', color: 'var(--text-primary, #111827)',
          fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', fontSize: '10px',
        }}
      >
        <span>{title}</span>
        <span style={{ fontSize: '10px' }}>{open ? '\u25be' : '\u25b8'}</span>
      </button>
      {open ? <div style={{ padding: '2px 10px 8px' }}>{children}</div> : null}
    </div>
  );
}

/** Legend overlay driven by config.legend. Supports discrete dot/line swatches
 *  and continuous colour-gradient bars (LegendItem.gradient). Collapsible.
 *  Reusable via `title`/`corner` (e.g. a separate category color key). */
function MapLegend({
  items, title = 'Legend', corner = 'bottom-left',
}: { items: LegendItem[]; title?: string; corner?: 'bottom-left' | 'top-right' | 'bottom-right' }) {
  const rgba = (c: LegendItem['color']) =>
    c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] ?? 255) / 255})` : 'transparent';
  return (
    <OverlayCard title={title} corner={corner}>
      {items.map((it, i) =>
        it.gradient?.length ? (
          <div key={i} style={{ padding: '4px 0' }}>
            <div style={{ marginBottom: '3px' }}>{it.label}</div>
            <div
              style={{
                width: '124px', height: '10px', borderRadius: '3px',
                border: '1px solid rgba(15,23,42,0.15)',
                background: `linear-gradient(to right, ${it.gradient.map((c) => rgba(c)).join(', ')})`,
              }}
            />
            {it.minLabel || it.maxLabel ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px', fontSize: '10px', opacity: 0.8 }}>
                <span>{it.minLabel ?? ''}</span>
                <span>{it.maxLabel ?? ''}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '2px 0' }}>
            {it.shape === 'line' ? (
              <span style={{ width: '16px', height: '3px', borderRadius: '2px', background: rgba(it.color), flex: '0 0 auto' }} />
            ) : (
              <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: rgba(it.color), flex: '0 0 auto' }} />
            )}
            <span>{it.label}</span>
          </div>
        ),
      )}
    </OverlayCard>
  );
}

/** Absolutely-positioned interactive layer-toggle overlay (top-right), driven by
 *  config.toggles. Reads/writes the same viewState keys layers gate on via
 *  visibleWhen, so ticking a box shows/hides (and stops fetching) that layer. */
function MapToggles({ toggles }: { toggles: MapToggleItem[] }) {
  const updateViewState = useAppStore((s) => s.updateViewState);
  const viewState = useAppStore((s) => s.panel.viewState);
  // Seed each toggle's default into viewState once so gated layers have a value.
  useEffect(() => {
    const seed: Record<string, unknown> = {};
    for (const t of toggles) {
      if (viewState[t.key] == null) seed[t.key] = t.default ?? true;
    }
    if (Object.keys(seed).length) updateViewState(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <OverlayCard title="Layers" corner="top-right">
      {toggles.map((t) => {
        const v = viewState[t.key];
        const checked = v != null ? v !== false && v !== 'false' : (t.default ?? true);
        return (
          <label key={t.key} style={{ display: 'flex', alignItems: 'center', gap: '7px', padding: '3px 0', cursor: 'pointer', fontSize: '12px' }}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => updateViewState({ [t.key]: e.target.checked })}
              style={{ cursor: 'pointer', width: '14px', height: '14px' }}
            />
            <span>{t.label}</span>
          </label>
        );
      })}
    </OverlayCard>
  );
}

export function ViewMapArea({ areaConfig, selectionKeys = [] }: ViewMapAreaProps) {
  const config = areaConfig.config;
  const specs = config.layers ?? [];

  const panelViewState = useAppStore((s) => s.panel.viewState);
  const context = useAppStore((s) => s.context);
  const updateViewState = useAppStore((s) => s.updateViewState);
  const setMapState = useAppStore((s) => s.setMapState);
  // Merge context (region/vehicle) and viewState so conditional colors
  // (whenViewStateEquals) and clickable-table selections both resolve.
  const viewState = useMemo(
    () => ({ ...context, ...panelViewState }) as Record<string, unknown>,
    [context, panelViewState],
  );

  const [layers, setLayers] = useState<Record<number, Layer | null>>({});
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [fitsFull, setFitsFull] = useState<Record<number, LngLat[]>>({});
  const [fitsSel, setFitsSel] = useState<Record<number, LngLat[]>>({});
  const [templates, setTemplates] = useState<Record<string, string>>({});
  // Per-layer suspended-engine state (any live-ORS layer over a suspended region).
  const [suspendedLayers, setSuspendedLayers] = useState<Record<number, SuspendedInfo>>({});
  const retryRef = useRef<Record<number, () => void>>({});
  // Path hovered in the map -> widen the matching journey (see compileLayer).
  const [hovered, setHovered] = useState<{ layerId: string; value: unknown } | null>(null);
  // Attributes of the last map-picked feature, surfaced to the chat agent so it
  // can answer "the one I selected" questions. Cleared on an empty-map click.
  const [selectedFeature, setSelectedFeature] = useState<
    { key: string; value: unknown; attrs: Record<string, string | number | boolean> } | null
  >(null);

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

  // Click-to-anchor: an object pick emits the picked row's column into viewState;
  // an empty-map click emits the clicked coordinate (and clears the object key),
  // so a live-catchment view can anchor on an existing venue OR a greenfield point.
  const clickEmits: MapClickEmits | undefined = config.clickEmits;
  const onClick = useCallback((info: any) => {
    if (!clickEmits) return;
    const col = clickEmits.objectColumn ?? 'poi_name';
    if (info?.object && clickEmits.object) {
      const src = info.object.properties && typeof info.object.properties === 'object'
        ? { ...info.object, ...info.object.properties } : info.object;
      const val = src[col] ?? src[col.toUpperCase()] ?? src[col.toLowerCase()];
      if (val != null) {
        const patch: Record<string, unknown> = { [clickEmits.object]: val };
        if (clickEmits.lng) patch[clickEmits.lng] = null;
        if (clickEmits.lat) patch[clickEmits.lat] = null;
        updateViewState(patch);
        // Capture the picked row's attributes for the agent's map context.
        setSelectedFeature({ key: clickEmits.object, value: val, attrs: sanitizeAttrs(src) });
      }
      return;
    }
    const coord = info?.coordinate as [number, number] | undefined;
    if (coord && clickEmits.lng && clickEmits.lat) {
      const patch: Record<string, unknown> = { [clickEmits.lng]: coord[0], [clickEmits.lat]: coord[1] };
      if (clickEmits.object) patch[clickEmits.object] = null;
      updateViewState(patch);
      // Greenfield/empty-map click clears any prior picked-feature attributes.
      setSelectedFeature(null);
    }
  }, [clickEmits, updateViewState]);

  const onResult = useCallback(
    (index: number, layer: Layer | null, fitFull: LngLat[], fitSel: LngLat[], template: string | undefined, count: number) => {
      setLayers((prev) => ({ ...prev, [index]: layer }));
      setCounts((prev) => (prev[index] === count ? prev : { ...prev, [index]: count }));
      setFitsFull((prev) => ({ ...prev, [index]: fitFull }));
      setFitsSel((prev) => ({ ...prev, [index]: fitSel }));
      if (template) {
        const id = layer?.id ?? `spec-layer-${index}`;
        setTemplates((prev) => ({ ...prev, [id]: template }));
      }
    },
    [],
  );

  const onSuspended = useCallback(
    (index: number, info: SuspendedInfo | null, retry: () => void) => {
      retryRef.current[index] = retry;
      setSuspendedLayers((prev) => {
        if (!info) {
          if (!(index in prev)) return prev;
          const next = { ...prev };
          delete next[index];
          return next;
        }
        if (prev[index]) return prev;
        return { ...prev, [index]: info };
      });
    },
    [],
  );

  const suspendedInfo = useMemo<SuspendedInfo | null>(() => {
    const vals = Object.values(suspendedLayers);
    return vals.length ? vals[0] : null;
  }, [suspendedLayers]);

  const retryAllLayers = useCallback(() => {
    for (const fn of Object.values(retryRef.current)) {
      try { fn(); } catch { /* ignore */ }
    }
  }, []);

  const orderedLayers = useMemo<Layer[]>(
    () => specs.map((_, i) => layers[i]).filter((l): l is Layer => !!l),
    [specs, layers],
  );

  // When a selection is active, focus on the selected object's coords only
  // (excluding context layers); otherwise frame the full set of all layers.
  const fitCoords = useMemo<LngLat[]>(() => {
    // Collapse every layer's coords into a single bounding box (2 corner
    // points) without spreading large arrays into push() - spreading
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

  // Compact summary of what the map is showing, surfaced to the chat agent so it
  // reasons about visible layers / blank layers instead of guessing. Scalar-only
  // (counts, ids, bbox, selection) - never per-feature rows.
  const mapDescriptor = useMemo<MapStateDescriptor>(() => {
    const layerDescs: MapLayerDescriptor[] = specs.map((ls, i) => {
      const key = (ls as { visibleWhen?: string }).visibleWhen;
      const v = key ? viewState[key] : undefined;
      const visible = !key || (v !== false && v !== 'false');
      const compiled = layers[i];
      const id = compiled?.id ?? (ls as { id?: string }).id ?? `spec-layer-${i}`;
      return {
        id,
        type: (ls as { type?: string }).type ?? 'unknown',
        featureCount: counts[i] ?? 0,
        colorBy: colorFieldOf(ls),
        rendered: !!compiled,
        gated: !visible,
      };
    });
    const emptyLayers = layerDescs.filter((l) => !l.rendered || l.gated).map((l) => l.id);
    const bbox: [number, number, number, number] | undefined =
      fitCoords.length === 2
        ? [fitCoords[0][0], fitCoords[0][1], fitCoords[1][0], fitCoords[1][1]]
        : undefined;
    const selection: Record<string, unknown> = {};
    for (const k of selectionKeys) {
      const val = panelViewState[k];
      if (val != null && val !== '') selection[k] = val;
    }
    const legendItems = config.legend ?? config.categoryLegend;
    const legend = legendItems?.map((l) => l.label).filter(Boolean);
    // Include the picked feature only while it is still the active anchor, so a
    // table-driven selection change or a clear drops the stale map pick.
    const activeSelectedFeature =
      selectedFeature && selection[selectedFeature.key] === selectedFeature.value
        ? selectedFeature
        : undefined;
    return {
      layerCount: layerDescs.length,
      layers: layerDescs,
      emptyLayers,
      bbox,
      selection: Object.keys(selection).length ? selection : undefined,
      selectedFeature: activeSelectedFeature,
      legend: legend && legend.length ? legend : undefined,
    };
  }, [specs, layers, counts, viewState, fitCoords, selectionKeys, panelViewState, selectedFeature, config.legend, config.categoryLegend]);

  // Publish the descriptor only when it actually changes (signature guard avoids
  // a render loop), and clear it on unmount so the next view starts clean.
  const lastSigRef = useRef<string>('');
  useEffect(() => {
    const sig = JSON.stringify(mapDescriptor);
    if (sig !== lastSigRef.current) {
      lastSigRef.current = sig;
      setMapState(mapDescriptor);
    }
  }, [mapDescriptor, setMapState]);
  useEffect(() => () => setMapState(null), [setMapState]);

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
  // Bbox of the active region: frames the map on the region the moment the
  // context dropdown changes, before this view's data for that region arrives
  // (and instead of world zoom when the view has no rows for it).
  const regionCoords = useRegionCamera(regionKey);
  // Views that opt into a locked camera frame once on load and then stay put:
  // no selection focus fit, no refit when a layer toggle or a periodic refetch
  // changes the data extent.
  const lockCamera = !!config.lockCamera;

  // One-shot focus point (config.focusOn): a row click writes lng/lat into
  // viewState and the camera pans/zooms there once. Works while lockCamera is
  // on because it is an explicit gesture, not an automatic re-frame.
  const focusOn = config.focusOn;
  const focusPoint = useMemo(() => {
    if (!focusOn) return null;
    const rawLng = viewState[focusOn.lngKey];
    const rawLat = viewState[focusOn.latKey];
    // Guard null/'' explicitly: Number(null) is 0, which is a finite (and very
    // wrong) coordinate, so a deselect that clears the keys must not focus 0,0.
    if (rawLng == null || rawLng === '' || rawLat == null || rawLat === '') return null;
    const lng = Number(rawLng);
    const lat = Number(rawLat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return { lng, lat, zoom: focusOn.zoom };
  }, [focusOn, viewState]);

  return (
    <div style={{ position: 'relative', width: '100%', height: config.noPad ? '100%' : (config.height ?? 500), minHeight: 0 }}>
      {specs.map((ls, i) => {
        // A layer with config.visibleWhen renders unless its viewState value is
        // explicitly false/'false' (defaults ON before a toggle seeds).
        const key = (ls as { visibleWhen?: string }).visibleWhen;
        const v = key ? viewState[key] : undefined;
        const visible = !key || (v !== false && v !== 'false');
        return (
          <LayerFetcher key={i} index={i} layer={ls} viewState={viewState} selectionKeys={selectionKeys} hovered={hovered} visible={visible} onResult={onResult} onSuspended={onSuspended} />
        );
      })}
      <MapView
        layers={orderedLayers}
        fitTo={{ coords: fitCoords, regionKey, focusKey: lockCamera ? '' : focusKey, lockAfterFirstFit: lockCamera, focusPoint, regionCoords }}
        fallbackViewState={fallback}
        getTooltip={getTooltip}
        onHover={onHover}
        onClick={onClick}
      />
      {suspendedInfo ? (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5 }}>
          <RoutingSuspendedNotice info={suspendedInfo} onRetry={retryAllLayers} />
        </div>
      ) : null}
      {config.legend?.length ? <MapLegend items={config.legend} /> : null}
      {config.categoryLegend?.length ? <MapLegend items={config.categoryLegend} title="Categories" corner="bottom-right" /> : null}
      {config.toggles?.length ? <MapToggles toggles={config.toggles} /> : null}
    </div>
  );
}
