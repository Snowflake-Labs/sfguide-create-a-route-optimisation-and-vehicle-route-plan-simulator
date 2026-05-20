// Loads templates, presets, ors-readiness regions, stats and coverage.
// Refresh callbacks are exposed so generate / save flows can re-fetch.

import { useCallback, useEffect, useState } from 'react';
import { CoverageEntry, Preset, ProfileTemplate } from '../helpers';
import type { StudioStat } from '../types';

export function useStudioCatalog() {
  const [templates, setTemplates] = useState<ProfileTemplate[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [availableRegions, setAvailableRegions] = useState<{key: string; label: string}[]>(
    [{ key: 'SanFrancisco', label: 'San Francisco' }],
  );
  const [stats, setStats] = useState<StudioStat[]>([]);
  const [coverage, setCoverage] = useState<CoverageEntry[]>([]);

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
    try {
      const res = await fetch('/api/studio/stats');
      if (!res.ok) return;
      const data = await res.json();
      setStats(Array.isArray(data) ? data : []);
    } catch (e: any) {
      console.error('Failed to fetch stats:', e);
    }
  }, []);

  const fetchCoverage = useCallback(async () => {
    try {
      const res = await fetch('/api/studio/coverage');
      if (!res.ok) return;
      const data = await res.json();
      setCoverage(Array.isArray(data) ? data : []);
    } catch (e: any) {
      console.error('Failed to fetch coverage:', e);
    }
  }, []);

  useEffect(() => {
    fetchTemplates();
    fetchPresets();
    fetchStats();
    fetchCoverage();
    fetchAvailableRegions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    templates, presets, availableRegions, stats, coverage,
    fetchTemplates, fetchPresets, fetchStats, fetchCoverage, fetchAvailableRegions,
  };
}
