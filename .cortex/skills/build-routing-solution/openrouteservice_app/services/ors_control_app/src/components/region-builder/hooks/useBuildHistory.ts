// Aggregated build history fan-out across all provisioned regions. Refreshes
// whenever the regions list changes; keeps the most recent 10 entries so the
// card stays compact.

import { useEffect, useState } from 'react';
import type { BuildHistoryRow } from '../types';
import { RegionStatus } from '../helpers';

export function useBuildHistory(regions: RegionStatus[]) {
  const [history, setHistory] = useState<BuildHistoryRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (regions.length === 0) {
      setHistory([]);
      return;
    }
    Promise.all(
      regions.map((c) =>
        fetch(`/api/regions/${encodeURIComponent(c.region)}/build-history`)
          .then((r) => r.json())
          .then((d) => (Array.isArray(d?.history) ? (d.history as BuildHistoryRow[]) : []))
          .catch(() => [] as BuildHistoryRow[]),
      ),
    ).then((all) => {
      if (cancelled) return;
      const flat: BuildHistoryRow[] = ([] as BuildHistoryRow[]).concat(...all);
      flat.sort((a, b) => {
        const ta = a.STARTED_AT ? new Date(a.STARTED_AT).getTime() : 0;
        const tb = b.STARTED_AT ? new Date(b.STARTED_AT).getTime() : 0;
        return tb - ta;
      });
      setHistory(flat.slice(0, 10));
    });
    return () => { cancelled = true; };
  }, [regions]);
  return history;
}
