'use client';
// Loads templates, presets, ors-readiness regions, stats and coverage.
// Refresh callbacks are exposed so generate / save flows can re-fetch.

import { useCallback, useEffect, useState } from 'react';
import { CoverageEntry, Preset, ProfileTemplate } from '../helpers';
import type { StudioStat } from '../types';
import { safeFetchJson } from '@/utils/safeFetch';
import { useVisiblePolling } from '@/hooks/useVisiblePolling';

export function useStudioCatalog() {
  const [templates, setTemplates] = useState<ProfileTemplate[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [availableRegions, setAvailableRegions] = useState<{key: string; label: string}[]>(
    [{ key: 'SanFrancisco', label: 'San Francisco' }],
  );
  const [stats, setStats] = useState<StudioStat[]>([]);
  const [coverage, setCoverage] = useState<CoverageEntry[]>([]);
  // Distinguish "not loaded yet" and "failed" from "loaded, genuinely empty".
  // Without this the page cannot tell them apart and renders 0 for all three,
  // which is exactly how a warehouse-contention outage was read as missing seed
  // data for hours.
  const [statsError, setStatsError] = useState<string | null>(null);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/templates');
      setTemplates(await res.json());
    } catch (e: any) {
      console.error('Failed to fetch templates:', e);
    }
  }, []);

  const fetchAvailableRegions = useCallback(async () => {
    try {
      const res = await fetch('/api/ors-readiness');
      const data = await res.json();
      const regions: {key: string; label: string}[] = [];
      for (const [key] of Object.entries(data as Record<string, any>)) {
        regions.push({ key, label: key });
      }
      if (regions.length > 0) setAvailableRegions(regions);
    } catch {}
  }, []);

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/presets');
      setPresets(await res.json());
    } catch (e: any) {
      console.error('Failed to fetch presets:', e);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    // safeFetchJson (not raw fetch): the route now answers 503 with an { error }
    // body on failure instead of a 200 with []. The previous `if (!res.ok)
    // return` silently left the last-known stats in place and logged to a
    // console nobody reads.
    const res = await safeFetchJson<StudioStat[]>('/api/studio/stats');
    setStatsLoaded(true);
    if (res.aborted) return;
    if (!res.ok) {
      setStatsError(res.error || `HTTP ${res.status}`);
      setStats([]);
      return;
    }
    setStatsError(null);
    setStats(Array.isArray(res.data) ? res.data : []);
  }, []);

  const fetchCoverage = useCallback(async () => {
    const res = await safeFetchJson<CoverageEntry[]>('/api/studio/coverage');
    if (res.aborted) return;
    if (!res.ok) {
      setCoverageError(res.error || `HTTP ${res.status}`);
      setCoverage([]);
      return;
    }
    setCoverageError(null);
    setCoverage(Array.isArray(res.data) ? res.data : []);
  }, []);

  useEffect(() => {
    fetchTemplates();
    fetchPresets();
    fetchStats();
    fetchCoverage();
    fetchAvailableRegions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the region dropdown fresh without a hard page refresh: poll every
  // 30s (mirrors ServiceManager) and re-fetch whenever the tab regains
  // focus / becomes visible. Picks up regions that finished provisioning
  // in the Region Builder while Data Studio was open.
  // Was a hand-rolled copy of useVisiblePolling (interval + visibilitychange +
  // focus). Now that the hook owns the focus refetch too, use it: a shared hook
  // plus a near-identical local reimplementation is what let six other polling
  // sites skip the visibility guard entirely.
  useVisiblePolling(fetchAvailableRegions, 30000);

  return {
    templates, presets, availableRegions, stats, coverage,
    statsError, coverageError, statsLoaded,
    fetchTemplates, fetchPresets, fetchStats, fetchCoverage, fetchAvailableRegions,
  };
}
