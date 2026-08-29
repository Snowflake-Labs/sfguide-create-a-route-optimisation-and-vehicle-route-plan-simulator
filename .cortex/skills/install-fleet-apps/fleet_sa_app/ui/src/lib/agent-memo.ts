'use client';

/**
 * Agent grounding, Channel A: publishing what an area actually renders.
 *
 * The chat agent cannot see the panel. It only sees the string context that
 * `app/api/chat/route.ts` assembles, so any number a user can read on screen has
 * to be republished into `panel.viewState` under a `__memo_<areaName>` key.
 * `route.ts` splits those keys out of the filter entries and emits them as
 * "On-screen values".
 *
 * THE CONTRACT (three rules, each of which has already broken this app once):
 *
 * 1. A memo MUST be a flat, pre-joined STRING. `route.ts` interpolates the value
 *    into a template, so a nested object serializes to "[object Object]".
 * 2. A memo MUST be bounded by its publisher. `route.ts` caps the TOTAL memo text
 *    but cannot make a single 50 KB memo useful, so trim here, at the source, and
 *    say what was trimmed (`(+N more)`) rather than silently truncating - an agent
 *    that thinks it saw every row will state a partial total as fact.
 * 3. A memo MUST be published through a change gate. Writing to viewState
 *    re-renders the publisher, and `view-panel.tsx` hands every custom view a
 *    fresh inline `onStateChange` closure on each render, so an ungated effect
 *    loops forever (React #185, "Maximum update depth exceeded"). `useAgentMemo`
 *    below owns that gate; use it rather than hand-rolling an effect.
 *
 * Keys are namespaced per area because a view may have several areas of the same
 * kind (journey_inspector has two MetricCards areas), and a shared key would mean
 * the last one to render wins.
 */

import { useEffect, useRef } from 'react';
import { useAppStore } from '@/lib/store';
import type { MapLayerDescriptor, MapStateDescriptor } from '@/lib/types';

/**
 * Per-memo budget. Deliberately smaller than the KPI budget (600) because a view
 * has at most a couple of KPI areas but can have several tables and charts, and
 * `route.ts` has to fit all of them into one prompt alongside the map block.
 */
export const MEMO_MAX_LEN = 500;

/** Rows sampled into a table memo. The agent gets a top-of-sort window, not the table. */
export const MEMO_SAMPLE_ROWS = 5;

/** Named categories listed in a chart memo before collapsing to "(+N more)". */
export const MEMO_SAMPLE_CATEGORIES = 5;

/**
 * Join parts up to `maxLen`, then stop and report how many were dropped. Never
 * cuts mid-part, so the agent never reads a half-truncated value as a real one.
 */
export function joinBounded(parts: string[], maxLen = MEMO_MAX_LEN, sep = '; '): string {
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const next = out ? `${out}${sep}${parts[i]}` : parts[i];
    if (next.length > maxLen) {
      return out ? `${out}${sep}(+${parts.length - i} more)` : `(+${parts.length} more)`;
    }
    out = next;
  }
  return out;
}

/** Clamp one scalar for inclusion in a memo. Long free text is the usual bloat source. */
export function memoScalar(value: unknown, maxChars = 60): string {
  if (value === null || value === undefined) return '-';
  const s = typeof value === 'string' ? value : String(value);
  return s.length > maxChars ? `${s.slice(0, maxChars)}...` : s;
}

/**
 * Publish (or clear) this area's memo, gated so it only writes when the string
 * actually changes.
 *
 * Pass an empty memo to clear - a closed detail drawer must not leave a stale
 * record in the agent's context. Deps are the memo string and the key only:
 * NEVER add `viewState`, or an area that also reads a selection key will
 * re-publish on every store write and loop.
 */
export function useAgentMemo(areaName: string | undefined, memo: string, fallbackKey = 'area'): void {
  const updateViewState = useAppStore((s) => s.updateViewState);
  const memoKey = `__memo_${areaName ?? fallbackKey}`;
  const lastMemoRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastMemoRef.current === memo) return;
    // Nothing published yet and nothing to publish: stay out of the store entirely
    // so an empty area does not add a null key to every view's context.
    if (!memo && lastMemoRef.current === null) return;
    lastMemoRef.current = memo;
    updateViewState({ [memoKey]: memo || null });
  }, [memo, memoKey, updateViewState]);

  // Clear on unmount so switching views cannot carry a stale panel into the
  // agent's context. Mirrors view-map.tsx's `setMapState(null)` teardown.
  useEffect(
    () => () => {
      if (lastMemoRef.current) {
        lastMemoRef.current = null;
        updateViewState({ [memoKey]: null });
      }
    },
    [memoKey, updateViewState],
  );
}

interface TableMemoInput {
  columns: Array<{ key: string; label: string }>;
  /** Rows in the order the user sees them (post-sort, post-pin). */
  rows: Record<string, unknown>[];
  /** Server-side total, so the memo can distinguish a slice from the whole set. */
  totalRows?: number;
  sortKey?: string | null;
  sortDir?: 'asc' | 'desc';
  /** Formatter the component uses for cells, so the memo matches the screen. */
  formatCell: (value: unknown) => string;
  /** Label of the currently selected row, when the table drives a selection. */
  selectedLabel?: string | null;
  /** Extra ordering note, e.g. ClickableTable's exception-first pinning. */
  orderNote?: string;
}

/**
 * Summarize a rendered table: how many rows of how many, the ordering, the
 * columns, and a small top-of-order sample.
 *
 * The row count wording is load-bearing. `data.rows` is what came back from the
 * query (already `LIMIT`ed in SQL), `totalRows` is what the server reports, and
 * the sample is smaller still - so the memo names all three rather than letting
 * the agent read "5" as the answer to "how many sites are there".
 */
export function buildTableMemo(input: TableMemoInput): string {
  const { columns, rows, totalRows, sortKey, sortDir, formatCell, selectedLabel, orderNote } = input;
  if (!columns.length || !rows.length) return '';

  const shown = rows.length;
  const head: string[] = [
    totalRows != null && totalRows > shown
      ? `table: ${shown} of ${totalRows.toLocaleString()} rows shown`
      : `table: ${shown} row${shown === 1 ? '' : 's'}`,
  ];
  if (sortKey) head.push(`sorted by ${sortKey} ${sortDir ?? 'desc'}`);
  if (orderNote) head.push(orderNote);
  if (selectedLabel) head.push(`selected: ${memoScalar(selectedLabel)}`);
  head.push(`columns ${columns.map((c) => c.key).join(', ')}`);

  // Sample rows are pipe-delimited inside brackets: compact, and unambiguous when
  // a value itself contains a comma (site names routinely do).
  const sample = rows.slice(0, MEMO_SAMPLE_ROWS).map((r) => {
    const cells = columns.map((c) => memoScalar(formatCell(r[c.key]), 40));
    return `[${cells.join(' | ')}]`;
  });
  const dropped = shown - sample.length;
  const sampleText = sample.join(' ') + (dropped > 0 ? ` (+${dropped} more rows)` : '');

  return joinBounded([...head, `rows: ${sampleText}`], MEMO_MAX_LEN);
}

interface ChartMemoInput {
  /** Chart kind as configured: bar, pie, line, area, scatter. */
  chartType: string;
  xKey: string;
  yKey: string;
  /** Rows already mapped to chart points, in render order. */
  points: Array<Record<string, unknown>>;
  /** Series names when the chart is grouped/stacked. */
  seriesNames?: string[];
  formatValue?: (value: unknown) => string;
}

/**
 * Summarize a rendered chart.
 *
 * Charts are the worst blind spot to leave open: the shape IS the finding ("which
 * site is worst", "is it trending up"), and a chart publishes no numbers to the
 * DOM that any other channel could pick up. Category charts therefore report the
 * total plus the labelled extremes plus a top-N; series charts report the x span
 * and the endpoints, which is what a trend question actually needs.
 */
export function buildChartMemo(input: ChartMemoInput): string {
  const { chartType, xKey, yKey, points, seriesNames, formatValue } = input;
  if (!points.length) return '';
  const fmt = formatValue ?? ((v: unknown) => (typeof v === 'number' ? v.toLocaleString() : String(v ?? '-')));

  const labelOf = (p: Record<string, unknown>) => memoScalar(p[xKey], 30);
  const numeric = points
    .map((p) => ({ label: labelOf(p), value: Number(p[yKey]) }))
    .filter((p) => Number.isFinite(p.value));

  const head: string[] = [`${chartType} chart: ${points.length} point${points.length === 1 ? '' : 's'}, x=${xKey}, y=${yKey}`];
  if (seriesNames?.length) head.push(`series ${seriesNames.slice(0, 6).join(', ')}${seriesNames.length > 6 ? ` (+${seriesNames.length - 6})` : ''}`);

  if (numeric.length) {
    const total = numeric.reduce((s, p) => s + p.value, 0);
    const min = numeric.reduce((a, b) => (b.value < a.value ? b : a));
    const max = numeric.reduce((a, b) => (b.value > a.value ? b : a));
    head.push(`total ${fmt(total)}`);
    head.push(`min ${fmt(min.value)} (${min.label})`);
    head.push(`max ${fmt(max.value)} (${max.label})`);
  }

  // Category charts: the ranked head is the finding. Series charts: the endpoints
  // are, because the x axis is ordered and "first vs last" is the trend.
  const isSeries = chartType === 'line' || chartType === 'area' || chartType === 'scatter';
  if (isSeries) {
    const first = points[0];
    const last = points[points.length - 1];
    head.push(`x range ${labelOf(first)}..${labelOf(last)}`);
    head.push(`first ${fmt(first[yKey])}, last ${fmt(last[yKey])}`);
  } else if (numeric.length) {
    const top = [...numeric]
      .sort((a, b) => b.value - a.value)
      .slice(0, MEMO_SAMPLE_CATEGORIES)
      .map((p) => `${p.label} ${fmt(p.value)}`);
    const dropped = numeric.length - top.length;
    head.push(`top ${top.join(', ')}${dropped > 0 ? ` (+${dropped} more)` : ''}`);
  }

  return joinBounded(head, MEMO_MAX_LEN);
}

/**
 * Summarize a single rendered record (detail panel / entity page) as bounded
 * key=value pairs. Wide records are the bloat risk here, so cap the key count and
 * clamp each value, mirroring `sanitizeAttrs` in view-map.tsx.
 */
export function buildRecordMemo(
  row: Record<string, unknown> | undefined,
  opts: { label?: string; maxKeys?: number } = {},
): string {
  if (!row) return '';
  const { label = 'record', maxKeys = 15 } = opts;
  const pairs = Object.entries(row)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, maxKeys)
    .map(([k, v]) => `${k}=${memoScalar(v, 80)}`);
  if (!pairs.length) return '';
  return joinBounded([`${label}:`, ...pairs], MEMO_MAX_LEN);
}

/**
 * Channel B for hand-built maps.
 *
 * The config-driven Map area builds its `MapStateDescriptor` from layer specs it
 * already has metadata for. A custom page instead constructs deck.gl layers
 * directly, so derive the descriptor from the compiled layer objects: the id and
 * the row count are both readable from the layer props, and the deck class name is
 * a good enough layer kind. Doing it generically means a page that adds a layer
 * later cannot forget to describe it, which is exactly how the hand-listed
 * descriptor in emergency-response.tsx can drift.
 *
 * Pass `ready: false` while the page is still loading or solving, to publish null
 * rather than a snapshot of all-empty layers - an agent told "0 features" reports
 * an empty map as a finding instead of as a pending fetch.
 */
export function describeDeckLayers(
  layers: Array<unknown>,
  opts: { selection?: Record<string, unknown>; legend?: string[]; ready?: boolean } = {},
): MapStateDescriptor | null {
  if (opts.ready === false) return null;
  const descs: MapLayerDescriptor[] = layers.map((raw, i) => {
    const l = raw as { id?: string; props?: { data?: unknown; visible?: boolean } };
    const data = l?.props?.data;
    const featureCount = Array.isArray(data) ? data.length : data ? 1 : 0;
    return {
      id: l?.id ?? `layer-${i}`,
      type: (raw as { constructor?: { name?: string } })?.constructor?.name?.replace(/Layer$/, '').toLowerCase() ?? 'unknown',
      featureCount,
      rendered: featureCount > 0 && l?.props?.visible !== false,
      gated: l?.props?.visible === false,
    };
  });
  const selection = opts.selection
    ? Object.fromEntries(Object.entries(opts.selection).filter(([, v]) => v != null && v !== ''))
    : undefined;
  return {
    layerCount: descs.length,
    layers: descs,
    emptyLayers: descs.filter((l) => !l.rendered).map((l) => l.id),
    selection: selection && Object.keys(selection).length ? selection : undefined,
    legend: opts.legend?.length ? opts.legend : undefined,
  };
}

/**
 * Signature-gated `setMapState` publish plus unmount clear, for custom pages.
 * Same hazard and same shape as the gate in view-map.tsx.
 */
export function usePublishMapState(descriptor: MapStateDescriptor | null): void {
  const setMapState = useAppStore((s) => s.setMapState);
  const lastSigRef = useRef<string>('');
  useEffect(() => {
    const sig = descriptor ? JSON.stringify(descriptor) : '';
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    setMapState(descriptor);
  }, [descriptor, setMapState]);
  useEffect(() => () => setMapState(null), [setMapState]);
}
