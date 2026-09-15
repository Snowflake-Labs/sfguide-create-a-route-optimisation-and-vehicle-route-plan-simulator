'use client';

// Inline chat map for the `render_map` verb.
//
// Unlike RouteMapInline (which scavenges GeoJSON out of a routing tool's response
// payload and draws it with one hardcoded GeoJsonLayer), this component takes a
// declarative LayerSpec[] and runs each layer's SQL itself, then compiles it with
// the SAME shared compiler the dashboard's authored map areas use
// (@fleet-kit/core/map). That is deliberate: a second, divergent renderer is how
// the inline map ended up without the colour DSL, tooltip templating or
// decimation that every authored map has.
//
// Two boundaries are load-bearing:
//   1. Every query runs with forceDynamic, i.e. through /api/query's
//      owner's-rights FLEET_APP_DYNAMIC_READER + FLEET_APP/SNOWFLAKE allowlist.
//      The chat panel renders beside the user's own dashboard, so the active view
//      id says "trusted" and would otherwise run agent SQL with full privileges.
//   2. Rows are capped and the cap is SHOWN. An oversized geometry payload
//      renders a blank map with no error, so a silent cap would just move the
//      failure rather than remove it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Layer } from '@deck.gl/core';
import MapView from '../views/areas/map-view';
import type { LngLat } from '@/lib/map/map-fit';
import type { LayerSpec, LegendItem } from '@/lib/map/layer-spec';
import { compileLayerWithFit } from '@/lib/map/layer-compiler';
import { parseMapSpec, type InlineMapSpec } from '@/lib/map-spec-schema';
import {
  deriveInlineLegend, synthesizeTooltip, encodingColumns,
  type LayerFacts, type ValueDomain,
} from '@/lib/map/inline-legend';
import { unwrapVerbResult } from '@/lib/tool-names';
import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';
import { escapeHtml } from '@/lib/html';
import { formatCellValue } from '@/lib/format-number';

/** Rows kept per layer before the map is drawn from a truncated set. Bounds the
 *  GPU buffer and the parse cost; the overflow is reported on screen. */
const MAX_INLINE_ROWS = 2000;

interface LayerResult {
  layer: Layer | null;
  fitCoords: LngLat[];
  count: number;
  total: number;
  /** Rows that carried every column the layer needs to place a feature.
   *  `count > 0 && drawn === 0` is the signature of a naming error, and it is
   *  the one blank-map state that used to be completely silent - see the notice
   *  in MapBody. */
  drawn: number;
  tooltip?: string;
  error?: string;
  /** Range of the layer's valueColumn over the rows it was DRAWN from, so a
   *  gradient legend labels the ramp the user is looking at rather than the
   *  unclipped result set. */
  domain?: ValueDomain;
  /** Column names on the returned rows, for tooltip synthesis. */
  columns?: string[];
}

/** Min/max of `column` over `rows`. Mirrors the compiler's h3 branch, which
 *  derives the lerp bounds the same way - the legend has to describe that exact
 *  ramp, so the two must agree on which values count. */
function valueDomain(rows: Record<string, unknown>[], column: string | undefined): ValueDomain | undefined {
  if (!column) return undefined;
  let min = 0;
  let max = 0;
  let seen = false;
  for (const r of rows) {
    const v = Number(r[column] ?? r[column.toUpperCase()] ?? r[column.toLowerCase()]);
    if (!Number.isFinite(v)) continue;
    if (!seen) {
      min = v;
      max = v;
      seen = true;
    } else {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return seen ? { min, max } : undefined;
}

/** Fill a `{COLUMN}` template from a picked feature. Case-insensitive so a
 *  template works whether the query returned lower- or UPPER-cased columns.
 *  Escaped because the result is handed to deck.gl as tooltip `html`. */
function renderTooltip(template: string, object: Record<string, unknown>): string {
  let lower: Record<string, unknown> | null = null;
  return template.replace(/\{(\w+)\}/g, (_m, col: string) => {
    let v = object[col];
    if (v == null) {
      if (!lower) {
        lower = {};
        for (const k of Object.keys(object)) lower[k.toLowerCase()] = object[k];
      }
      v = lower[col.toLowerCase()];
    }
    // Formatted before escaping, identical to view-map.tsx's renderTooltip so the
    // two cannot drift: this was a verbatim copy of the same raw-stringify defect,
    // on the render_map path that draws INSIDE a chat answer. The token name is
    // the column, so {LATITUDE} keeps its 5dp exemption.
    if (v == null) return '';
    return escapeHtml(formatCellValue(v, { column: String(col), grouping: true, empty: '' }));
  });
}

/**
 * Runs one layer's query and lifts the compiled layer + fit coords to the parent.
 * Renders nothing. One child per layer keeps hook order stable across renders,
 * matching the LayerFetcher pattern in view-map.tsx.
 */
function InlineLayerFetcher({
  index,
  layer,
  context,
  onResult,
}: {
  index: number;
  layer: LayerSpec;
  context: Record<string, unknown>;
  onResult: (index: number, result: LayerResult) => void;
}) {
  const { data, error } = useViewData(layer.data.query, layer.data.params, { forceDynamic: true });

  const result = useMemo<LayerResult>(() => {
    if (error) return { layer: null, fitCoords: [], count: 0, total: 0, drawn: 0, error };
    const all = (data?.rows ?? []) as Record<string, unknown>[];
    const total = data?.totalRows ?? all.length;
    const rows = all.length > MAX_INLINE_ROWS ? all.slice(0, MAX_INLINE_ROWS) : all;
    const { layer: compiled, fitCoords, drawn } = compileLayerWithFit(layer, rows, context, index, null);
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return {
      layer: compiled,
      fitCoords: fitCoords as LngLat[],
      count: rows.length,
      total: Math.max(total, all.length),
      drawn,
      // A layer with no template still gets one: forcing `pickable` alone leaves
      // getTooltip returning null, so the map stays hover-dead for exactly the
      // specs the agent actually emits.
      tooltip: layer.tooltip ?? synthesizeTooltip(layer, columns),
      domain: valueDomain(rows, layer.type === 'h3' ? layer.valueColumn : undefined),
      columns,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, error, index, layer, context]);

  // Report whenever the compiled layer or the counts change.
  useEffect(() => {
    onResult(index, result);
  }, [index, result, onResult]);

  return null;
}

/** Compact legend row rendered under the map. Deliberately simpler than the
 *  dashboard's collapsible overlay card: a chat message is short-lived and has
 *  no room for a floating panel.
 *
 *  Renders BOTH swatch kinds. The gradient branch is not cosmetic: validateLegend
 *  accepts a gradient-only item (it has no `color` by design), and without this
 *  branch `rgba(undefined)` returned 'transparent', so a continuous legend drew a
 *  label beside an invisible box - the same silent-failure class as the rest of
 *  the map. */
function InlineLegend({ items }: { items: LegendItem[] }) {
  const rgba = (c: LegendItem['color']) =>
    c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] ?? 255) / 255})` : 'transparent';
  return (
    <div
      style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '10px', padding: '6px 8px',
        fontSize: '11px', color: 'var(--text-secondary, #6b7280)',
      }}
    >
      {items.map((it, i) =>
        it.gradient?.length ? (
          <span key={i} style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px' }}>
            <span>{it.label}</span>
            <span
              style={{
                width: '110px', height: '9px', borderRadius: '3px',
                border: '1px solid rgba(15,23,42,0.15)',
                background: `linear-gradient(to right, ${it.gradient.map((c) => rgba(c)).join(', ')})`,
              }}
            />
            {it.minLabel || it.maxLabel ? (
              <span style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', opacity: 0.85 }}>
                <span>{it.minLabel ?? ''}</span>
                <span>{it.maxLabel ?? ''}</span>
              </span>
            ) : null}
          </span>
        ) : (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span
              style={{
                width: it.shape === 'line' ? '14px' : '9px',
                height: it.shape === 'line' ? '3px' : '9px',
                borderRadius: it.shape === 'line' ? '2px' : '50%',
                background: rgba(it.color),
                flex: '0 0 auto',
              }}
            />
            {it.label}
          </span>
        ),
      )}
    </div>
  );
}

function Notice({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div
      style={{
        padding: '10px 12px', borderRadius: '8px', fontSize: '12px',
        backgroundColor: 'var(--surface-secondary, #f9fafb)',
        border: '1px solid var(--border-default, #e5e7eb)',
        color: 'var(--text-secondary, #6b7280)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: lines.length ? '4px' : 0, color: 'var(--text-primary, #111827)' }}>
        {title}
      </div>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

function MapBody({ spec }: { spec: InlineMapSpec }) {
  const context = useAppStore((s) => s.context) as unknown as Record<string, unknown>;
  const [results, setResults] = useState<Record<number, LayerResult>>({});

  const onResult = useCallback((index: number, result: LayerResult) => {
    setResults((prev) => (prev[index] === result ? prev : { ...prev, [index]: result }));
  }, []);

  const layers = useMemo<Layer[]>(
    () => spec.layers.map((_, i) => results[i]?.layer).filter((l): l is Layer => !!l),
    [spec.layers, results],
  );

  // Union every layer's coords into a single bounding box (2 corner points). No
  // region clip is needed here (unlike view-map): an inline map is built once
  // from one spec and never survives a region change, so there are no stale
  // foreign coords to discard. Spreading is avoided for the same reason as
  // view-map - spreading data-sized arrays into push() overflows the stack.
  const fitCoords = useMemo<LngLat[]>(() => {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    let seen = false;
    for (const key of Object.keys(results)) {
      const arr = results[Number(key)]?.fitCoords;
      if (!arr) continue;
      for (const c of arr) {
        const lng = c[0], lat = c[1];
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        seen = true;
      }
    }
    return seen ? [[minLng, minLat], [maxLng, maxLat]] : [];
  }, [results]);

  const templates = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    spec.layers.forEach((ls, i) => {
      const tpl = results[i]?.tooltip;
      if (tpl) out[ls.id ?? `spec-layer-${i}`] = tpl;
    });
    return out;
  }, [spec.layers, results]);

  const getTooltip = useCallback(
    ({ object, layer }: { object?: Record<string, unknown>; layer?: { id: string } }) => {
      if (!object || !layer) return null;
      const tpl = templates[layer.id];
      if (!tpl) return null;
      // A GeoJsonLayer pick returns a Feature, whose source columns sit under
      // `properties`; scatterplot/path/arc picks carry them on the object.
      const props = object.properties;
      const src = props && typeof props === 'object' ? { ...object, ...(props as Record<string, unknown>) } : object;
      return {
        html: renderTooltip(tpl, src),
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    },
    [templates],
  );

  const reported = Object.keys(results).length;
  const allReported = reported >= spec.layers.length;
  // "Nothing drawn" is measured on FEATURES, not on rows. Basing it on rows made
  // the worst failure mode invisible: a layer whose encoding column did not match
  // the result set returned plenty of rows, drew nothing, produced no camera-fit
  // coords (so the map sat at world zoom) and reported no error - while the
  // legend still showed the real value domain, because that lookup happens to be
  // case-insensitive. The map read as broken rendering rather than a wrong name.
  const isEmpty = allReported && spec.layers.every((_, i) => (results[i]?.drawn ?? 0) === 0);
  const noRows = allReported && spec.layers.every((_, i) => (results[i]?.count ?? 0) === 0);
  // Layers that returned data nobody could place. Named per layer with the
  // columns it read, because that IS the fix - the column is misspelled, is not
  // on the result set, or came back NULL (a live routing call with a profile the
  // region does not have returns NULL geometry and no error).
  const undrawable = spec.layers
    .map((ls, i) => ({ ls, i, r: results[i] }))
    .filter(({ r }) => !!r && !r.error && r.count > 0 && r.drawn === 0)
    .map(({ ls, i, r }) =>
      `layer ${i}${ls.id ? ` (${ls.id})` : ''}: ${r!.count} rows returned, none could be drawn - ` +
      `no usable value in ${encodingColumns(ls).join(', ') || 'its encoding columns'}. ` +
      `Columns present: ${(r!.columns ?? []).join(', ') || 'none'}.`,
    );
  // Drew features but produced no coordinates to frame: the values were present
  // and unusable (e.g. a malformed H3 index), which leaves the camera at world
  // zoom over a map that does have layers on it.
  const unfittable = spec.layers
    .map((ls, i) => ({ ls, i, r: results[i] }))
    .filter(({ r }) => !!r && !r.error && r.drawn > 0 && r.fitCoords.length === 0)
    .map(({ ls, i }) =>
      `layer ${i}${ls.id ? ` (${ls.id})` : ''}: no valid coordinates to frame - ` +
      `check the values in ${encodingColumns(ls).join(', ')}.`,
    );
  const errors = spec.layers
    .map((_, i) => results[i]?.error)
    .filter((e): e is string => !!e);
  const truncated = spec.layers
    .map((_, i) => results[i])
    .filter((r): r is LayerResult => !!r && r.total > r.count);

  // The legend DESCRIBES the encoding, so it is derived from the layers plus what
  // they actually drew - never taken from the spec's colours. An agent cannot know
  // the compiler's default ramp or the data's range, which is how a blue hex map
  // came to sit under a yellow-to-red "Low / Medium / High" key with no numbers.
  // The authored legend survives as a source of TEXT only (see deriveInlineLegend),
  // and is rendered verbatim only until the layers report.
  const facts = useMemo<Record<number, LayerFacts | undefined>>(() => {
    const out: Record<number, LayerFacts | undefined> = {};
    spec.layers.forEach((_, i) => {
      const r = results[i];
      if (r) out[i] = { domain: r.domain, columns: r.columns };
    });
    return out;
  }, [spec.layers, results]);

  const legend = useMemo<LegendItem[]>(
    () => (allReported ? deriveInlineLegend(spec.layers, facts, spec.legend) : (spec.legend ?? [])),
    [allReported, spec.layers, spec.legend, facts],
  );

  // A stable token for this geometry so the camera fits once it arrives. The
  // fit is then LOCKED: a chat message must not re-frame itself later when the
  // user changes region on the dashboard beside it.
  const focusKey = fitCoords.length === 2
    ? `${fitCoords[0][0]},${fitCoords[0][1]},${fitCoords[1][0]},${fitCoords[1][1]}`
    : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {spec.title ? (
        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary, #111827)' }}>{spec.title}</div>
      ) : null}
      {spec.layers.map((ls, i) => (
        <InlineLayerFetcher key={i} index={i} layer={ls} context={context} onResult={onResult} />
      ))}
      <div
        style={{
          position: 'relative', width: '100%', height: spec.height,
          borderRadius: '8px', overflow: 'hidden',
          border: '1px solid var(--border-default, #e5e7eb)',
        }}
      >
        <MapView
          layers={layers}
          fitTo={{ coords: fitCoords, focusKey, lockAfterFirstFit: true }}
          fallbackViewState={spec.fallback}
          getTooltip={getTooltip}
        />
        {isEmpty && errors.length === 0 && undrawable.length === 0 ? (
          <div
            style={{
              position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              zIndex: 4, maxWidth: '300px', textAlign: 'center', padding: '8px 12px',
              borderRadius: '8px', fontSize: '12px', lineHeight: 1.45, pointerEvents: 'none',
              backgroundColor: 'var(--surface-primary, #fff)',
              border: '1px solid var(--border-default, #e5e7eb)',
              color: 'var(--text-secondary, #6b7280)',
            }}
          >
            {noRows
              ? spec.emptyMessage ?? 'No features matched this query.'
              : 'This map returned data that could not be drawn - see the note below.'}
          </div>
        ) : null}
      </div>
      {legend.length ? <InlineLegend items={legend} /> : null}
      {spec.categoryLegend?.length ? <InlineLegend items={spec.categoryLegend} /> : null}
      {truncated.length ? (
        <div style={{ fontSize: '11px', color: 'var(--text-secondary, #6b7280)' }}>
          {truncated.map((r) => `showing ${r.count} of ${r.total} features`).join('; ')}
        </div>
      ) : null}
      {errors.length ? <Notice title="Some layers could not be drawn" lines={errors} /> : null}
      {undrawable.length ? (
        <Notice title="This map returned rows but drew nothing" lines={undrawable} />
      ) : null}
      {unfittable.length ? (
        <Notice title="This map could not frame its data" lines={unfittable} />
      ) : null}
    </div>
  );
}

export function RenderMapInline(props: Record<string, unknown>) {
  // The verb returns { result: <spec> }, but it reaches the client DOUBLE-wrapped
  // (the inner envelope arrives as a pretty-printed JSON string), so peel rather
  // than reading `.result` once. A bare spec still works - unwrapVerbResult stops
  // as soon as it sees `layers`.
  const parsed = useMemo(() => parseMapSpec(unwrapVerbResult(props)), [props]);

  if (!parsed.ok) {
    // Named reasons, never a blank card: every other failure mode of a map is
    // already silent, so a rejected spec has to say what was wrong with it.
    return <Notice title="This map spec was rejected" lines={parsed.errors} />;
  }
  return <MapBody spec={parsed.spec} />;
}
