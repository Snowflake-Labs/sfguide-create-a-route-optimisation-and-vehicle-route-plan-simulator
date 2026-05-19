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
  // Boundary fields populated from REGION_CATALOG (joined via
  // ORS_REGION_KEY -> LOOKUP_NAME). Null when no catalog row matches
  // (e.g. user-added regions before the catalog is refreshed).
  BOUNDARY_GEOJSON?: string | null;     // GeoJSON string of the simplified polygon
  BOUNDARY_SOURCE?: string | null;      // 'geofabrik-poly' | 'bbbike-bbox' | 'bbox-fallback'
  BOUNDARY_AREA_KM2?: number | null;
  BOUNDARY_BAKED_AT?: string | null;    // ISO date - cache-bust signal
  BOUNDARY_CENTROID_LON?: number | null; // ST_X(ST_CENTROID(BOUNDARY))
  BOUNDARY_CENTROID_LAT?: number | null;
  ISO_COUNTRY_A2?: string | null;
  ISO_COUNTRY_A3?: string | null;
  ISO_SUBDIVISION?: string | null;
}

interface RegionContextValue {
  regionName: string;
  displayName: string;
  center: { lat: number; lng: number };
  zoom: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
  // Polygon boundary as GeoJSON for deck.gl GeoJsonLayer + turf.js
  // boolean-point-in-polygon. Null when no catalog row matches.
  boundaryGeoJson: string | null;
  boundarySource: string | null;
  boundaryBakedAt: string | null;
  isoCountry: string | null;       // alpha-2
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
  boundaryGeoJson: null,
  boundarySource: null,
  boundaryBakedAt: null,
  isoCountry: null,
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
    // IMPORTANT: await the server-side CONFIG.REGION update BEFORE flipping
    // React state. Otherwise `setActive` causes the App.tsx `dataKey` to
    // change synchronously, which remounts every demo component. Those
    // remounted components fire `useEffect` SQL queries against projection
    // views (e.g. VW_TRIP_SUMMARY) that read REGION via `(SELECT REGION
    // FROM CONFIG LIMIT 1)`. If the POST hasn't completed yet, CONFIG
    // still holds the OLD region and demos render stale data.
    try {
      await fetch('/api/regions/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: regionName }),
      });
      const target = regions.find(r => r.REGION_NAME === regionName);
      if (target) setActive(target);
      await fetchRegions();
    } catch {
      await fetchRegions();
    }
  }, [fetchRegions, regions]);

  const value: RegionContextValue = {
    regionName: active?.REGION_NAME ?? defaults.regionName,
    displayName: active?.DISPLAY_NAME ?? defaults.displayName,
    center: {
      // Prefer boundary centroid (always on land, inside the region) over
      // CENTER_LAT/LON (sometimes water for bbox-defined regions).
      lat: Number(active?.BOUNDARY_CENTROID_LAT ?? active?.CENTER_LAT ?? defaults.center.lat),
      lng: Number(active?.BOUNDARY_CENTROID_LON ?? active?.CENTER_LON ?? defaults.center.lng),
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
    boundaryGeoJson: active?.BOUNDARY_GEOJSON ?? null,
    boundarySource: active?.BOUNDARY_SOURCE ?? null,
    boundaryBakedAt: active?.BOUNDARY_BAKED_AT ?? null,
    isoCountry: active?.ISO_COUNTRY_A2 ?? null,
    regions,
    loading,
    switchRegion,
    refresh: fetchRegions,
  };

  return { value, RegionContext };
}

export { RegionContext };
