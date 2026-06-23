'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/lib/store';

interface QueryResult {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  totalRows: number;
}

interface UseViewDataResult {
  data: QueryResult | null;
  loading: boolean;
  error: string | null;
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
  const [data, setData] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: query, params: resolvedParams }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
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
  }, [query, paramsKey, viewsVersion]);

  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData, fetchedAt };
}
