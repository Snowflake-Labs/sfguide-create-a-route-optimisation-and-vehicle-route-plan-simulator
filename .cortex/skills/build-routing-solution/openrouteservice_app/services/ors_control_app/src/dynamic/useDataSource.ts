import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { DataSourceSpec } from './spec-types';
import { buildQuery, type BindingScope } from './spec-runtime';

interface DataSourceDefaults {
  database?: string;
  schema?: string;
}

interface DataSourceResult {
  rows: Record<string, any>[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Run a DataSourceSpec against /api/query, resolving `:param` placeholders from
 * the binding scope and re-fetching when the spec's `refetchOn` context values
 * change. Mirrors the existing useSfQuery fetch/parse contract (errors surface
 * as { error } in the body; rows may be a bare array or { result: [...] }).
 */
export function useDataSource(
  ds: DataSourceSpec | undefined,
  scope: BindingScope,
  defaults: DataSourceDefaults = {},
): DataSourceResult {
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [loading, setLoading] = useState<boolean>(!!ds);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Resolve the final SQL + connection. Recomputed when the spec or any bound
  // value changes, so param-driven queries (e.g. FilterBar selections) refetch.
  const sql = useMemo(() => (ds ? buildQuery(ds, scope) : ''), [ds, scope]);
  const database = ds?.database ?? defaults.database;
  const schema = ds?.schema ?? defaults.schema;

  // refetchOn triggers: fold the named context values into the dep signature.
  const triggerSig = useMemo(() => {
    if (!ds?.refetchOn?.length) return '';
    return ds.refetchOn
      .map((t) => {
        if (t === 'region') return `r:${scope.region.regionName}`;
        if (t === 'vehicle') return `v:${scope.vehicle.vehicleType}`;
        if (t === 'dataset') return `d:${scope.vehicle.activeDatasetId ?? ''}`;
        return '';
      })
      .join('|');
  }, [ds?.refetchOn, scope.region.regionName, scope.vehicle.vehicleType, scope.vehicle.activeDatasetId]);

  const fetchData = useCallback(async () => {
    if (!sql) { setRows([]); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, database, schema }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (body && body.error) throw new Error(body.error);
      const out = Array.isArray(body) ? body : (body.result ?? []);
      if (mounted.current) setRows(Array.isArray(out) ? out : []);
    } catch (err: any) {
      if (mounted.current) { setError(err.message ?? String(err)); setRows([]); }
    } finally {
      if (mounted.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, database, schema, triggerSig]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return { rows, loading, error, refresh: fetchData };
}
