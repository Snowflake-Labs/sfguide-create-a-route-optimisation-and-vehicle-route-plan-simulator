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

  const fetchData = useCallback(async () => {
    if (!query) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setSuspended(null);

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: query, params: resolvedParams, dynamic: isDynamic }),
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
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, paramsKey, viewsVersion, isDynamic]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  return { data, loading, error, suspended, refetch: fetchData, fetchedAt };
}
