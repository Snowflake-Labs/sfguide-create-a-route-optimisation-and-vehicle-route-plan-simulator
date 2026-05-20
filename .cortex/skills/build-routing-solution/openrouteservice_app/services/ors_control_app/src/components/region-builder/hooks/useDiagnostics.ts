// "Ask for status" diagnostic state, shared by ActiveJobsTable and
// FailedJobsList so the drawer renders consistently regardless of which
// section the request was triggered from.

import { useCallback, useState } from 'react';
import type { DiagState } from '../types';

export function useDiagnostics() {
  const [diagState, setDiagState] = useState<DiagState>({});

  const askForStatus = useCallback(async (region: string) => {
    setDiagState((prev) => ({
      ...prev,
      [region]: { ...(prev[region] || { loading: false, expanded: false }), loading: true, expanded: true, error: undefined },
    }));
    try {
      const r = await fetch(`/api/regions/${encodeURIComponent(region)}/diagnose`, { method: 'POST' });
      const d = await r.json();
      if (d.ok) {
        setDiagState((prev) => ({
          ...prev,
          [region]: { loading: false, markdown: d.markdown, raw: d.raw_snapshot, expanded: true },
        }));
      } else {
        setDiagState((prev) => ({
          ...prev,
          [region]: { loading: false, error: d.error || 'Unknown error', expanded: true },
        }));
      }
    } catch (e: any) {
      setDiagState((prev) => ({
        ...prev,
        [region]: { loading: false, error: e.message, expanded: true },
      }));
    }
  }, []);

  const closeDiag = useCallback((region: string) => {
    setDiagState((prev) => ({
      ...prev,
      [region]: { ...(prev[region] || { loading: false, expanded: false }), expanded: false },
    }));
  }, []);

  return { diagState, askForStatus, closeDiag };
}
