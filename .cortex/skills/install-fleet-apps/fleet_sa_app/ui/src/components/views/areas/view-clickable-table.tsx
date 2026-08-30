'use client';

// Clickable-table area (parity widget #2): a data table whose row click writes
// configured values into viewState via updateViewState. Drives map highlight
// (LayerSpec conditional color whenViewStateEquals) and any
// viewState.<key>-parametrized query. Reproduces the control app's FleetMap
// click-a-courier drilldown.
//
// `emits` is a map of viewState key -> source. The FIRST entry is the primary
// selection: it drives the row highlight and (via the renderer) the map's focus
// fit. Sources resolve as:
//   'selection' | 'highlight' -> the row's config.rowKey value (the original,
//                               single-key behaviour every other view uses)
//   any other string          -> the name of a row column, whose value is
//                               written to that viewState key
// This lets one row click set several related keys at once - e.g. the site, the
// vehicle, the replay minute and a map focus point - in a SINGLE viewState patch
// so dependent areas refetch once rather than once per key.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useViewData } from '@/hooks/use-view-data';
import { useAppStore } from '@/lib/store';
import { useStyleConfig, resolveDefaultMaxRows } from '@/lib/style-config';
import { buildTableMemo, useAgentMemo } from '@/lib/agent-memo';
import { FreshnessBadge } from './freshness-badge';
import { RoutingSuspendedNotice } from '@/components/views/RoutingSuspendedNotice';

// Row metrics for the `fitRows` height cap: sticky header + N data rows, then scroll.
const HEADER_PX = 38;
const ROW_PX = 35;

interface TableColumn {
  field: string;
  header?: string;
}

interface ViewClickableTableAreaProps {
  areaConfig: {
    data: {
      query: string;
      params?: Record<string, string>;
    };
    config?: {
      rowKey: string;
      columns?: TableColumn[];
      maxRows?: number;
      // Initial sort applied before rendering (exception-first triage default).
      defaultSort?: { column: string; direction?: 'asc' | 'desc' };
      // Pin rows whose `column` value is in `values` to the top (severity/at-risk first).
      exceptionFirst?: { column: string; values: string[] };
      // Show an "updated Ns ago" badge above the table (live operational views).
      showFreshness?: boolean;
      // Cap the visible height to N data rows (header + N rows) and scroll beyond it.
      fitRows?: number;
      // Seed the emitted selection once when data first loads and nothing is selected.
      // 'first' picks the top row; 'random' picks a random loaded row.
      autoSelect?: 'first' | 'random';
    };
    // A map of viewState key -> source. First entry is the primary selection
    // (row highlight + renderer selectionKeys); see the file header for how
    // each source resolves.
    emits?: Record<string, string>;
  };
  // The area's own key in the view layout, supplied by the renderer. Namespaces
  // this table's agent memo so sibling tables in one view do not clobber it.
  areaName?: string;
}

function compareValues(a: unknown, b: unknown, dir: 'asc' | 'desc'): number {
  const na = Number(a);
  const nb = Number(b);
  let cmp: number;
  if (!isNaN(na) && !isNaN(nb)) cmp = na - nb;
  else cmp = String(a ?? '').localeCompare(String(b ?? ''));
  return dir === 'desc' ? -cmp : cmp;
}

export function ViewClickableTableArea({ areaConfig, areaName }: ViewClickableTableAreaProps) {
  const { data, loading, error, suspended, refetch, fetchedAt } = useViewData(areaConfig.data.query, areaConfig.data.params);
  const config = areaConfig.config;
  const styleConfig = useStyleConfig();
  const updateViewState = useAppStore((s) => s.updateViewState);
  const viewState = useAppStore((s) => s.panel.viewState);

  // Interactive click-to-sort, initialized from the configured defaultSort.
  const [sortKey, setSortKey] = useState<string | null>(config?.defaultSort?.column ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(config?.defaultSort?.direction ?? 'desc');
  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const emitEntries = useMemo<[string, string][]>(
    () => Object.entries(areaConfig.emits ?? {}),
    [areaConfig.emits],
  );
  const emitKey = emitEntries.length ? emitEntries[0][0] : null;
  const rowKey = config?.rowKey;
  const selected = emitKey ? viewState[emitKey] : null;

  // Resolve one row into the full viewState patch this table emits. `rowKey`
  // sources ('selection'/'highlight') all carry the row id; every other source
  // names a column on the row. Passing null clears the whole set, so a deselect
  // never leaves a stale companion value (e.g. a vehicle with no site).
  const patchFor = useCallback(
    (row: Record<string, unknown> | null): Record<string, unknown> => {
      const patch: Record<string, unknown> = {};
      for (const [key, source] of emitEntries) {
        if (row == null) {
          patch[key] = null;
          continue;
        }
        const col = source === 'selection' || source === 'highlight' ? rowKey : source;
        patch[key] = col ? (row[col] ?? null) : null;
      }
      return patch;
    },
    [emitEntries, rowKey],
  );

  // Auto-select once on load: seed the emitted selection so the view opens with a
  // highlighted venue (same machinery as an explicit row/map click) instead of the
  // region-centroid fallback. Fires once per mount; clearing a selection later is
  // not re-seeded.
  const autoSelect = config?.autoSelect;
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (!autoSelect || !emitKey || !rowKey || autoSelectedRef.current) return;
    const r = data?.rows ?? [];
    if (!r.length) return;
    if (selected != null && selected !== '') {
      autoSelectedRef.current = true;
      return;
    }
    const idx = autoSelect === 'random' ? Math.floor(Math.random() * r.length) : 0;
    const row = r[idx];
    if (row?.[rowKey] != null) {
      updateViewState(patchFor(row));
      autoSelectedRef.current = true;
    }
  }, [data, autoSelect, emitKey, rowKey, selected, updateViewState, patchFor]);

  // Display ordering, hoisted above the early returns so the agent memo (a hook)
  // can see exactly the rows the user does. Exception-first pin, then the active
  // sort (user click, falling back to defaultSort), then the row cap.
  const rows = useMemo(() => {
    let out = data?.rows ?? [];
    if (out.length) {
      const exc = config?.exceptionFirst;
      if (exc || sortKey) {
        const excSet = exc ? new Set(exc.values.map(String)) : null;
        out = [...out].sort((a, b) => {
          if (excSet && exc) {
            const af = excSet.has(String(a[exc.column])) ? 0 : 1;
            const bf = excSet.has(String(b[exc.column])) ? 0 : 1;
            if (af !== bf) return af - bf;
          }
          if (sortKey) return compareValues(a[sortKey], b[sortKey], sortDir);
          return 0;
        });
      }
    }
    return out.slice(0, config?.maxRows ?? resolveDefaultMaxRows(styleConfig));
  }, [data, config?.exceptionFirst, config?.maxRows, sortKey, sortDir, styleConfig]);

  const columns: TableColumn[] = useMemo(
    () => config?.columns ?? (data?.columns ?? []).map((c) => ({ field: c.key, header: c.label })),
    [config?.columns, data?.columns],
  );

  // Agent grounding: republish the rendered slice, including which row is selected
  // and the exception-first pin, so the agent answers about this table rather than
  // re-deriving it from SQL and disagreeing with the screen.
  useAgentMemo(
    areaName,
    useMemo(
      () =>
        buildTableMemo({
          columns: columns.map((c) => ({ key: c.field, label: c.header ?? c.field })),
          rows,
          totalRows: data?.totalRows,
          sortKey,
          sortDir,
          formatCell: (v) => String(v ?? '-'),
          selectedLabel: selected != null && selected !== '' ? String(selected) : null,
          orderNote: config?.exceptionFirst ? `exceptions first by ${config.exceptionFirst.column}` : undefined,
        }),
      [columns, rows, data?.totalRows, sortKey, sortDir, selected, config?.exceptionFirst],
    ),
    'table',
  );

  if (loading) {
    return <div style={{ padding: '16px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>Loading…</div>;
  }
  if (suspended) {
    return <RoutingSuspendedNotice info={suspended} onRetry={refetch} />;
  }

  if (error) {
    return <div style={{ padding: '16px', color: 'var(--text-error, #dc2626)', fontSize: '13px' }}>Error: {error}</div>;
  }
  if (!rows.length) {
    return <div style={{ padding: '16px', color: 'var(--text-secondary, #6b7280)', fontSize: '13px' }}>No data</div>;
  }

  const onRowClick = (row: Record<string, unknown>) => {
    if (!emitKey || !rowKey) return;
    // Toggle selection off when re-clicking the active row: clears the primary
    // key AND every companion key in one patch.
    const isActive = String(row[rowKey]) === String(selected);
    updateViewState(patchFor(isActive ? null : row));
  };

  const fitRows = config?.fitRows;
  const maxHeight = fitRows ? `${HEADER_PX + fitRows * ROW_PX}px` : undefined;

  return (
    <div style={{ height: fitRows ? undefined : '100%', maxHeight, overflow: 'auto' }}>
      {config?.showFreshness && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 12px 0' }}>
          <FreshnessBadge fetchedAt={fetchedAt} />
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.field} onClick={() => handleSort(c.field)} style={{ textAlign: 'left', padding: '8px 12px', position: 'sticky', top: 0, backgroundColor: 'var(--surface-secondary, #f9fafb)', borderBottom: '1px solid var(--border-default, #e5e7eb)', fontWeight: 600, color: 'var(--text-secondary, #6b7280)', cursor: 'pointer', userSelect: 'none' }}>
                {c.header ?? c.field}
                {sortKey === c.field && (
                  <span style={{ marginLeft: '4px', fontSize: '10px' }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isSel = rowKey != null && String(row[rowKey]) === String(selected);
            return (
              <tr
                key={i}
                onClick={() => onRowClick(row)}
                style={{
                  cursor: emitKey && rowKey ? 'pointer' : 'default',
                  backgroundColor: isSel ? 'var(--surface-accent, #eff6ff)' : 'transparent',
                  borderBottom: '1px solid var(--border-subtle, #f3f4f6)',
                }}
              >
                {columns.map((c) => (
                  <td key={c.field} style={{ padding: '8px 12px', color: 'var(--text-primary, #111827)' }}>
                    {String(row[c.field] ?? '')}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
