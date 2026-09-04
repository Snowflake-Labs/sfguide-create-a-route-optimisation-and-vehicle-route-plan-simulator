'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/lib/store';
import { DYNAMIC_VIEW_ID } from '@/lib/load-views';
import { isSuspendedBody, type SuspendedInfo } from '@/lib/routing-suspend';

interface QueryResult {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  totalRows: number;
}

interface UseViewDataResult {
  data: QueryResult | null;
  loading: boolean;
  error: string | null;
  // Set when the query failed because the region's routing engine is suspended
  // (server has already triggered a resume). Views render RoutingSuspendedNotice.
  suspended: SuspendedInfo | null;
  refetch: () => void;
  // Epoch ms when the current data last arrived (for freshness indicators); null until first load.
  fetchedAt: number | null;
}

function resolveParamValue(
  ref: string,
  viewState: Record<string, unknown>,
  context: Record<string, unknown>,
): string | null {
  if (ref.startsWith('viewState.')) {
    const key = ref.slice('viewState.'.length);
    const val = viewState[key];
    return val === undefined || val === null ? null : String(val);
  }
  if (ref.startsWith('context.')) {
    const key = ref.slice('context.'.length);
    const val = context[key];
    return val === undefined || val === null ? null : String(val);
  }
  return ref;
}

export function useViewData(
  query: string | undefined,
  paramRefs?: Record<string, string>,
): UseViewDataResult {
  const viewState = useAppStore((s) => s.panel.viewState);
  const context = useAppStore((s) => s.context);
  const viewsVersion = useAppStore((s) => s.viewsVersion);
  // Queries for the ephemeral agent-emitted page run through the owner's-rights
  // dynamic boundary (/api/query dynamic:true). Trusted shipped views do not.
  const isDynamic = useAppStore((s) => s.panel.activeViewId === DYNAMIC_VIEW_ID);
  const beginFetch = useAppStore((s) => s.beginFetch);
  const endFetch = useAppStore((s) => s.endFetch);
  const [data, setData] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suspended, setSuspended] = useState<SuspendedInfo | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const resolvedParams = paramRefs
    ? Object.fromEntries(
        Object.entries(paramRefs).map(([key, ref]) => [key, resolveParamValue(ref, viewState, context)]),
      )
    : undefined;

  const paramsKey = JSON.stringify(resolvedParams);

  // Region hint for the suspended-engine handler. Several routing errors (a
  // gateway failure, 'matrix pre-compute failed', a bare 'service_unreachable')
  // carry NO 'ors-service-<region>' token, so without this the server falls back
  // to its hardcoded default and would resume the wrong region while telling the
  // user it resumed that default. `context.region` is written by the dataset
  // picker and is the region every view query is scoped to.
  const regionHint = typeof context.region === 'string' && context.region ? context.region : null;

  // Does this query depend on a required filter that currently has no options?
  //
  // If so it MUST NOT be issued. The bind would go out as NULL, and several of
  // these queries pass it into a table-function argument where the SQL-side
  // `COALESCE(:bind,(SELECT ...))` fallback cannot be evaluated at all - Snowflake
  // raises "Unsupported subquery type cannot be evaluated", so the panel shows a
  // SQL error rather than being empty. Skipping yields an empty result instead,
  // which is both honest and the state every consumer already renders; the filter
  // itself explains why (see view-filter-bar.tsx).
  const blockedBinds = useAppStore((s) => s.blockedBinds);
  const blockedBy = paramRefs
    ? Object.values(paramRefs)
        .filter((ref) => ref.startsWith('viewState.'))
        .map((ref) => blockedBinds[ref.slice('viewState.'.length)])
        .find((label) => label !== undefined) ?? null
    : null;

  const fetchData = useCallback(async () => {
    if (!query) return;
    // Gated BEFORE beginFetch so the in-flight count stays balanced - an early
    // return after incrementing would strand the counter and stall replay.
    if (blockedBy !== null) {
      setData({ columns: [], rows: [], totalRows: 0 });
      setLoading(false);
      setError(null);
      setSuspended(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setSuspended(null);

    // Global in-flight accounting. The replay Slider gates its auto-advance on
    // the count reaching zero, so this MUST be paired 1:1 with the endFetch() in
    // the finally below. Every exit path from here on (success, abort, HTTP
    // error, thrown error, and the early return on the suspended-503) has to
    // decrement exactly once: a leak leaves the count above zero forever and
    // permanently stalls playback. The decrement therefore lives OUTSIDE the
    // `!aborted` guard, because an aborted request is still a finished request.
    beginFetch();

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: query, params: resolvedParams, dynamic: isDynamic, region: regionHint }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        // A suspended routing engine returns a typed 503; surface it as a
        // friendly notice (resume already triggered) instead of a raw error.
        if (res.status === 503 && isSuspendedBody(body)) {
          if (!controller.signal.aborted) setSuspended(body);
          return;
        }
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const result: QueryResult = await res.json();
      if (!controller.signal.aborted) {
        setData(result);
        setFetchedAt(Date.now());
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Query failed');
      }
    } finally {
      // Unconditional: balances beginFetch() on every path, including aborts.
      endFetch();
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, paramsKey, viewsVersion, isDynamic, regionHint, blockedBy]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  return { data, loading, error, suspended, refetch: fetchData, fetchedAt };
}
