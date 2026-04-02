import { useState, useEffect, useCallback } from 'react';
import type { DemoRegistration, OrsStatus } from './types';

export function useRegistry() {
  const [demos, setDemos] = useState<DemoRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRegistry = useCallback(async () => {
    try {
      const res = await fetch('/api/registry');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDemos(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setDemos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRegistry();
    const interval = setInterval(fetchRegistry, 30000);
    return () => clearInterval(interval);
  }, [fetchRegistry]);

  return { demos, loading, error, refresh: fetchRegistry };
}

export function useOrsStatus() {
  const [orsStatus, setOrsStatus] = useState<OrsStatus>({ installed: false, status: 'unknown' });

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/ors/status');
        if (res.ok) setOrsStatus(await res.json());
      } catch {}
    };
    check();
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, []);

  return orsStatus;
}
