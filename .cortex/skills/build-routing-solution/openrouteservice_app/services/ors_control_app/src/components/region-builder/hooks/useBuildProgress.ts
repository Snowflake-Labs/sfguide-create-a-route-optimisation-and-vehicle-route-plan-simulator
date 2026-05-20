// Polls /api/regions/:region/build-progress every 5s for each region that's
// currently building a graph. Returns a map keyed by region name.

import { useEffect, useState } from 'react';
import type { BuildProgress } from '../types';

export function useBuildProgress(buildingRegions: string[]) {
  const [progress, setProgress] = useState<Record<string, BuildProgress>>({});

  // Stable signature so the effect only resubscribes when the set changes.
  const key = buildingRegions.join(',');

  useEffect(() => {
    if (buildingRegions.length === 0) { setProgress({}); return; }
    const poll = () => {
      buildingRegions.forEach((region) => {
        fetch(`/api/regions/${region}/build-progress`)
          .then((r) => r.json())
          .then((data) => setProgress((prev) => {
            if (data.phase === 'ready' && prev[region]?.phase === 'ready') return prev;
            return { ...prev, [region]: data };
          }))
          .catch(() => {});
      });
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return progress;
}
