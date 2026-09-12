'use client';
// Polls /api/regions/:region/build-progress for each region that is currently
// building a graph. Returns a map keyed by region name.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BuildProgress } from '../types';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

// This was the single most expensive client loop in the app. Each tick fans out
// one request PER BUILDING REGION, and /build-progress does an ORS_STATUS plus a
// 1000-line SYSTEM$GET_SERVICE_LOGS. At the previous 5s cadence a 3.2-hour build
// issued roughly 2,300 ticks of that, which on its own kept the interactive
// warehouse from ever reaching its 60s idle - and warehouse credits are billed
// for hours-the-warehouse-is-up, not for work done.
//
// A graph build takes minutes to hours, so 15s costs nothing a user can perceive
// on a progress bar. Combined with the visibility guard below, a backgrounded
// tab now costs nothing at all.
const BUILD_PROGRESS_POLL_MS = 15000;

export function useBuildProgress(buildingRegions: string[]) {
  const [progress, setProgress] = useState<Record<string, BuildProgress>>({});

  // Stable signature so the effect only resubscribes when the set changes.
  const key = buildingRegions.join(',');
  // Derive the list from `key` rather than closing over the caller's array,
  // which is a fresh reference every render. This is what lets the callback
  // below have honest dependencies instead of an eslint-disable.
  const regions = useMemo(() => (key ? key.split(',') : []), [key]);

  const poll = useCallback(() => {
    regions.forEach((region) => {
      fetch(`/api/regions/${region}/build-progress`)
        .then((r) => r.json())
        .then((data) => setProgress((prev) => {
          if (data.phase === 'ready' && prev[region]?.phase === 'ready') return prev;
          return { ...prev, [region]: data };
        }))
        .catch(() => {});
    });
  }, [regions]);

  // Fetch once immediately so the panel is populated on open; useVisiblePolling
  // only fires on its interval and on visibility/focus regain, not on mount.
  useEffect(() => {
    if (regions.length === 0) { setProgress({}); return; }
    poll();
  }, [regions, poll]);

  useVisiblePolling(poll, BUILD_PROGRESS_POLL_MS, regions.length > 0);

  return progress;
}
