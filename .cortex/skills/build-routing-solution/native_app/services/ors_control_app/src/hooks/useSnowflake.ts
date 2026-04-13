import { useCallback, useState, useEffect, useRef } from 'react';

interface QueryOptions {
  database?: string;
  schema?: string;
}

export function useSnowflake() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useCallback(async (sql: string, options?: QueryOptions) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, database: options?.database, schema: options?.schema }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      return Array.isArray(body) ? body : (body.result || body);
    } catch (err: any) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  return { query, loading, error };
}

export function useSfQuery<T = Record<string, any>>(
  sql: string,
  database?: string,
  schema?: string,
  deps: any[] = [],
) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const fetchData = useCallback(async () => {
    if (!sql) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, database, schema }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      const rows = Array.isArray(body) ? body : (body.result ?? []);
      if (mounted.current) setData(Array.isArray(rows) ? rows : []);
    } catch (err: any) {
      if (mounted.current) setError(err.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [sql, database, schema, ...deps]);

  useEffect(() => { fetchData(); }, [fetchData]);

  return { data, loading, error, refresh: fetchData };
}
