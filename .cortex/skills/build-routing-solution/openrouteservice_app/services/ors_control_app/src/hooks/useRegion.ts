import { useState, useEffect, useCallback, createContext, useContext } from 'react';

export interface RegionInfo {
  REGION_NAME: string;
  DISPLAY_NAME: string;
  CENTER_LAT: number;
  CENTER_LON: number;
  BBOX_MIN_LAT: number | null;
  BBOX_MAX_LAT: number | null;
  BBOX_MIN_LON: number | null;
  BBOX_MAX_LON: number | null;
  ZOOM_LEVEL: number;
  ORS_REGION_KEY: string | null;
  DATA_SOURCE: string;
}

interface RegionContextValue {
  regionName: string;
  displayName: string;
  center: { lat: number; lng: number };
  zoom: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
  regions: RegionInfo[];
  loading: boolean;
  switchRegion: (regionName: string) => Promise<void>;
  refresh: () => void;
}

const defaults: RegionContextValue = {
  regionName: 'SanFrancisco',
  displayName: 'San Francisco',
  center: { lat: 37.7749, lng: -122.4194 },
  zoom: 11,
  bbox: { minLat: 37.700, maxLat: 37.820, minLon: -122.520, maxLon: -122.350 },
  regions: [],
  loading: true,
  switchRegion: async () => {},
  refresh: () => {},
};

const RegionContext = createContext<RegionContextValue>(defaults);

export function useRegion() {
  return useContext(RegionContext);
}

export function useRegionProvider() {
  const [active, setActive] = useState<RegionInfo | null>(null);
  const [regions, setRegions] = useState<RegionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRegions = useCallback(async () => {
    try {
      const res = await fetch('/api/regions');
      if (res.ok) {
        const data = await res.json();
        setRegions(data.regions || []);
        const activeRegion = data.regions?.find((r: RegionInfo) => r.REGION_NAME === data.active);
        if (activeRegion) setActive(activeRegion);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRegions(); }, [fetchRegions]);

  const switchRegion = useCallback(async (regionName: string) => {
    try {
      await fetch('/api/regions/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: regionName }),
      });
      await fetchRegions();
    } catch {}
  }, [fetchRegions]);

  const value: RegionContextValue = {
    regionName: active?.REGION_NAME ?? defaults.regionName,
    displayName: active?.DISPLAY_NAME ?? defaults.displayName,
    center: {
      lat: Number(active?.CENTER_LAT ?? defaults.center.lat),
      lng: Number(active?.CENTER_LON ?? defaults.center.lng),
    },
    zoom: Number(active?.ZOOM_LEVEL ?? defaults.zoom),
    bbox: active?.BBOX_MIN_LAT != null
      ? {
          minLat: active.BBOX_MIN_LAT!,
          maxLat: active.BBOX_MAX_LAT!,
          minLon: active.BBOX_MIN_LON!,
          maxLon: active.BBOX_MAX_LON!,
        }
      : defaults.bbox,
    regions,
    loading,
    switchRegion,
    refresh: fetchRegions,
  };

  return { value, RegionContext };
}

export { RegionContext };
