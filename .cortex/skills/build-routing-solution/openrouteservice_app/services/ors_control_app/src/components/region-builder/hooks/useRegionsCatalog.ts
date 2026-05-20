// Owns the provisioned-regions list and the upstream catalog (Geofabrik +
// BBBike). Auto-refreshes the catalog once on first load if it comes back
// empty so users do not see a blank state on cold start.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CatalogRegion } from '../../../types';
import { RegionStatus, toCatalogRegion } from '../helpers';

export function useRegionsCatalog() {
  const [regions, setRegions] = useState<RegionStatus[]>([]);
  const [catalog, setCatalog] = useState<CatalogRegion[]>([]);
  const [regionsLoading, setRegionsLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const autoRefreshedRef = useRef(false);

  const fetchRegions = useCallback(async () => {
    try {
      const r = await fetch('/api/regions/provisioned');
      const data = await r.json();
      setRegions(data.regions || []);
    } catch {}
    setRegionsLoading(false);
  }, []);

  const fetchCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const r = await fetch('/api/regions/catalog');
      const data = await r.json();
      const items = (data.catalog || []).map(toCatalogRegion);
      setCatalog(items);
      if (items.length === 0 && !autoRefreshedRef.current) {
        autoRefreshedRef.current = true;
        setRefreshing(true);
        try {
          await fetch('/api/regions/catalog/refresh', { method: 'POST' });
          const r2 = await fetch('/api/regions/catalog');
          const data2 = await r2.json();
          setCatalog((data2.catalog || []).map(toCatalogRegion));
        } catch {}
        setRefreshing(false);
      }
    } catch {}
    setCatalogLoading(false);
  }, []);

  const refreshCatalog = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch('/api/regions/catalog/refresh', { method: 'POST' });
      await fetchCatalog();
    } catch {}
    setRefreshing(false);
  }, [fetchCatalog]);

  const dropRegion = useCallback(async (region: string) => {
    try {
      await fetch(`/api/regions/${encodeURIComponent(region)}`, { method: 'DELETE' });
      fetchRegions();
    } catch {}
  }, [fetchRegions]);

  useEffect(() => {
    fetchRegions();
    fetchCatalog();
  }, [fetchRegions, fetchCatalog]);

  return {
    regions,
    catalog,
    regionsLoading,
    catalogLoading,
    refreshing,
    fetchRegions,
    refreshCatalog,
    dropRegion,
  };
}
