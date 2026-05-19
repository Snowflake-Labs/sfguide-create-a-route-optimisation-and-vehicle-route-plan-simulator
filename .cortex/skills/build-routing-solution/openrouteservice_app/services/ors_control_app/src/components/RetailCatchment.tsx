import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import { H3HexagonLayer, TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { useRegion } from '../hooks/useRegion';

const RC_DB = 'FLEET_INTELLIGENCE';
const RC_SCHEMA = 'RETAIL_CATCHMENT';

const PROFILE_LABELS: Record<string, string> = {
  'driving-car': 'Car',
  'driving-hgv': 'Truck',
  'cycling-regular': 'Bicycle',
  'cycling-electric': 'E-Bike',
  'cycling-mountain': 'Mountain Bike',
  'cycling-road': 'Road Bike',
  'foot-walking': 'Walking',
  'foot-hiking': 'Hiking',
  'wheelchair': 'Wheelchair',
};

interface ProvisionedRegion {
  region: string;
  display_name: string;
  profiles_loaded: string[];
  center_lat: number;
  center_lon: number;
  zoom: number;
}

async function sfQuery(sql: string, database = RC_DB, schema = RC_SCHEMA): Promise<any[]> {
  try {
    const res = await fetch('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, database, schema }) });
    const body = await res.json();
    const rows = Array.isArray(body) ? body : (body.result ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function cartoBasemap() {
  return new TileLayer({ id: 'carto-basemap', data: '/api/tiles/{z}/{x}/{y}', minZoom: 0, maxZoom: 19, tileSize: 256, renderSubLayers: (props: any) => { const { boundingBox } = props.tile; return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] }); } });
}

const ZONE_COLORS: [number, number, number][] = [[34, 197, 94], [41, 181, 232], [245, 158, 11], [239, 68, 68], [128, 0, 255]];

export default function RetailCatchment() {
  const { regions: globalRegions, center: globalCenter, zoom: globalZoom } = useRegion();
  const [provisionedRegions, setProvisionedRegions] = useState<ProvisionedRegion[]>([]);
  const [selectedRegion, setSelectedRegion] = useState('');
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [pois, setPois] = useState<any[]>([]);
  const [selectedStore, setSelectedStore] = useState<any>(null);
  const [travelMode, setTravelMode] = useState('driving-car');
  const [numZones, setNumZones] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [catchmentZones, setCatchmentZones] = useState<any[]>([]);
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [densityHexes, setDensityHexes] = useState<any[]>([]);
  const [regionBbox, setRegionBbox] = useState<{ minLon: number; maxLon: number; minLat: number; maxLat: number } | null>(null);
  const [showCompetitors, setShowCompetitors] = useState(true);
  const [showDensity, setShowDensity] = useState(true);
  const [h3Res, setH3Res] = useState(7);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.4194, latitude: 37.7749, zoom: 11, pitch: 0, bearing: 0 });

  // Fetch the list of provisioned regions (with their built profiles) once on mount.
  // Local-only: this dropdown does NOT call switchRegion(). The header switcher
  // remains the sole driver of the global active region.
  useEffect(() => {
    setLoading(true);
    // /api/regions/provisioned returns { regions: [...] }, NOT a bare array.
    // Also: the legacy default ORS service is reported as region:"default";
    // map that to the IS_DEFAULT row in REGION_REGISTRY (e.g. "SanFrancisco")
    // so it matches RETAIL_POIS.REGION values.
    const defaultRegistryName = globalRegions[0]?.REGION_NAME ?? 'SanFrancisco';
    fetch('/api/regions/provisioned')
      .then(r => r.json())
      .then((body: any) => {
        const data: any[] = Array.isArray(body) ? body : (body?.regions ?? []);
        const ready: ProvisionedRegion[] = data
          .filter(d => d && (d.serviceStatus === 'RUNNING' || d.serviceStatus === 'READY'))
          .map(d => {
            const profiles: string[] = d.graphReadiness?.profiles_loaded || [];
            const regionKey = (d.isDefault || d.region === 'default') ? defaultRegistryName : d.region;
            const matching = globalRegions.find(g => g.REGION_NAME === regionKey);
            const bboxLat = (d.bbox?.min_lat != null && d.bbox?.max_lat != null) ? ((d.bbox.min_lat + d.bbox.max_lat) / 2) : null;
            const bboxLon = (d.bbox?.min_lon != null && d.bbox?.max_lon != null) ? ((d.bbox.min_lon + d.bbox.max_lon) / 2) : null;
            const centerLat = Number(matching?.BOUNDARY_CENTROID_LAT ?? matching?.CENTER_LAT ?? bboxLat ?? 0) || 0;
            const centerLon = Number(matching?.BOUNDARY_CENTROID_LON ?? matching?.CENTER_LON ?? bboxLon ?? 0) || 0;
            const zoomLvl = Number(matching?.ZOOM_LEVEL ?? 11);
            return {
              region: regionKey,
              display_name: matching?.DISPLAY_NAME || d.display_name || regionKey,
              profiles_loaded: profiles,
              center_lat: centerLat,
              center_lon: centerLon,
              zoom: zoomLvl,
            };
          })
          .filter(d => d.profiles_loaded.length > 0);
        // Dedupe by resolved region key; prefer the entry with the most loaded profiles.
        const byKey = new Map<string, ProvisionedRegion>();
        for (const r of ready) {
          const existing = byKey.get(r.region);
          if (!existing || r.profiles_loaded.length > existing.profiles_loaded.length) byKey.set(r.region, r);
        }
        setProvisionedRegions(Array.from(byKey.values()));
      })
      .catch(() => setProvisionedRegions([]))
      .finally(() => setLoading(false));
  }, [globalRegions]);

  // Initial map view follows the global region until the user picks one locally.
  useEffect(() => {
    if (!selectedRegion && globalCenter.lng !== 0 && globalCenter.lat !== 0) {
      setViewState(prev => ({ ...prev, longitude: globalCenter.lng, latitude: globalCenter.lat, zoom: globalZoom }));
    }
  }, [globalCenter.lng, globalCenter.lat, globalZoom, selectedRegion]);

  // When the local region selection changes: refresh available profiles, reset
  // travel mode if needed, recenter the map, and load POIs for that region.
  useEffect(() => {
    setSelectedStore(null);
    setCatchmentZones([]);
    setCompetitors([]);
    setDensityHexes([]);
    setPois([]);
    setRegionBbox(null);

    if (!selectedRegion) {
      setAvailableProfiles([]);
      return;
    }

    const region = provisionedRegions.find(r => r.region === selectedRegion);
    if (!region) return;

    setAvailableProfiles(region.profiles_loaded);
    if (!region.profiles_loaded.includes(travelMode)) {
      setTravelMode(region.profiles_loaded[0]);
    }

    if (region.center_lat && region.center_lon) {
      setViewState(prev => ({ ...prev, longitude: region.center_lon, latitude: region.center_lat, zoom: region.zoom }));
    }

    setLoading(true);
    sfQuery(`SELECT POI_ID, POI_NAME AS NAME, BASIC_CATEGORY AS CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT FROM RETAIL_POIS WHERE REGION = '${selectedRegion}' LIMIT 200`)
      .then(r => {
        setPois(r);
        if (r.length > 0) {
          const lngs = r.map((p: any) => Number(p.LNG));
          const lats = r.map((p: any) => Number(p.LAT));
          const avgLng = lngs.reduce((s: number, v: number) => s + v, 0) / lngs.length;
          const avgLat = lats.reduce((s: number, v: number) => s + v, 0) / lats.length;
          setRegionBbox({ minLon: Math.min(...lngs) - 0.1, maxLon: Math.max(...lngs) + 0.1, minLat: Math.min(...lats) - 0.08, maxLat: Math.max(...lats) + 0.08 });
          setViewState(prev => ({ ...prev, longitude: avgLng, latitude: avgLat, zoom: 12 }));
        }
      })
      .finally(() => setLoading(false));
  }, [selectedRegion, provisionedRegions]);

  const fetchDensity = useCallback(async (_poi: any, res: number, bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number } | null) => {
    if (!selectedRegion) return;
    const bboxFilter = bbox
      ? `LONGITUDE BETWEEN ${bbox.minLon} AND ${bbox.maxLon} AND LATITUDE BETWEEN ${bbox.minLat} AND ${bbox.maxLat}`
      : `REGION = '${selectedRegion}'`;
    const density = await sfQuery(`SELECT H3_POINT_TO_CELL_STRING(GEOMETRY, ${res}) AS H3_INDEX, COUNT(*) AS CNT FROM REGIONAL_ADDRESSES WHERE REGION = '${selectedRegion}' AND ${bboxFilter} GROUP BY 1 HAVING CNT >= 2 LIMIT 5000`);
    setDensityHexes(density);
  }, [selectedRegion]);

  useEffect(() => {
    if (selectedStore && regionBbox) fetchDensity(selectedStore, h3Res, regionBbox);
  }, [h3Res, fetchDensity, regionBbox]);

  const selectStore = useCallback(async (poi: any) => {
    setSelectedStore(poi);
    setCatchmentZones([]);
    setCompetitors([]);
    setDensityHexes([]);

    const lng = Number(poi.LNG);
    const lat = Number(poi.LAT);
    setViewState(prev => ({ ...prev, longitude: lng, latitude: lat, zoom: 13 }));

    const zones: any[] = [];
    for (let z = 1; z <= numZones; z++) {
      const minutes = Math.round((maxMinutes / numZones) * z);
      console.log('[RetailCatchment] calling ISOCHRONES', travelMode, lng, lat, minutes);
      const rows = await sfQuery(`SELECT GEOJSON AS GEO FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES('${travelMode}', ${lng}::FLOAT, ${lat}::FLOAT, ${minutes}::INT, NULL::VARCHAR))`, 'OPENROUTESERVICE_APP', 'CORE');
      console.log('[RetailCatchment] ISOCHRONES rows:', rows.length, rows[0]);
      if (rows[0]?.GEO) {
        try { zones.push({ zoneIdx: z - 1, minutes, geojson: JSON.parse(rows[0].GEO) }); } catch {}
      }
    }
    setCatchmentZones(zones.reverse());

    const bboxFilter = regionBbox
      ? `LONGITUDE BETWEEN ${regionBbox.minLon} AND ${regionBbox.maxLon} AND LATITUDE BETWEEN ${regionBbox.minLat} AND ${regionBbox.maxLat}`
      : `REGION = '${selectedRegion}'`;
    const [comp, density] = await Promise.all([
      sfQuery(`SELECT POI_ID, POI_NAME AS NAME, BASIC_CATEGORY AS CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT FROM RETAIL_POIS WHERE REGION = '${selectedRegion}' AND POI_ID != '${poi.POI_ID}' AND ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(${lng}, ${lat}), ${maxMinutes * 1000}) LIMIT 50`),
      sfQuery(`SELECT H3_POINT_TO_CELL_STRING(GEOMETRY, ${h3Res}) AS H3_INDEX, COUNT(*) AS CNT FROM REGIONAL_ADDRESSES WHERE REGION = '${selectedRegion}' AND ${bboxFilter} GROUP BY 1 HAVING CNT >= 2 LIMIT 5000`),
    ]);
    setCompetitors(comp);
    setDensityHexes(density);
  }, [selectedRegion, travelMode, numZones, maxMinutes, h3Res, regionBbox]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    catchmentZones.forEach((z, i) => {
      const c = ZONE_COLORS[z.zoneIdx % ZONE_COLORS.length];
      result.push(new GeoJsonLayer({ id: `zone-${i}`, data: z.geojson, filled: true, stroked: true, getFillColor: [...c, 40], getLineColor: [...c, 180], lineWidthMinPixels: 2 }));
    });
    if (showDensity && densityHexes.length) {
      const maxCnt = Math.max(1, ...densityHexes.map((h: any) => Number(h.CNT)));
      result.push(new H3HexagonLayer({ id: 'density', data: densityHexes.filter((d: any) => d.H3_INDEX && typeof d.H3_INDEX === 'string' && d.H3_INDEX.length >= 15), pickable: true, filled: true, extruded: false, getHexagon: (d: any) => d.H3_INDEX, getFillColor: (d: any) => { const t = Number(d.CNT) / maxCnt; return [245, 158, 11, Math.floor(t * 180)] as [number, number, number, number]; }, updateTriggers: { getFillColor: [maxCnt] } }));
    }
    if (showCompetitors && competitors.length) {
      result.push(new ScatterplotLayer({ id: 'competitors', data: competitors.filter((c: any) => c.LNG && c.LAT), getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)], getFillColor: [239, 68, 68, 180], getRadius: 50, radiusMinPixels: 4, pickable: true }));
    }
    if (pois.length) {
      result.push(new ScatterplotLayer({ id: 'pois', data: pois.filter((p: any) => p.LNG && p.LAT), getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)], getFillColor: (d: any) => d.POI_ID === selectedStore?.POI_ID ? [41, 181, 232, 255] : [100, 100, 100, 150], getRadius: 60, radiusMinPixels: 5, pickable: true, updateTriggers: { getFillColor: [selectedStore?.POI_ID] } }));
    }
    return result;
  }, [catchmentZones, densityHexes, competitors, pois, selectedStore, showCompetitors, showDensity]);

  const layers = useMemo(() => [basemap, ...dataLayers].filter(Boolean), [basemap, dataLayers]);

  const getTooltip = useCallback(({ object }: any) => {
    if (!object?.NAME) return null;
    return { html: `<b>${object.NAME}</b><br/>${object.CATEGORY || ''}`, style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' } };
  }, []);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Retail Catchment</h2>
      <p className="subtitle">Multi-zone isochrone catchment analysis</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ minWidth: 200 }}>
          <label>Region</label>
          <select className="form-select" value={selectedRegion} onChange={e => setSelectedRegion(e.target.value)}>
            <option value="">Select region...</option>
            {provisionedRegions.map(r => <option key={r.region} value={r.region}>{r.display_name}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ minWidth: 140 }}>
          <label>Travel Mode</label>
          <select className="form-select" value={travelMode} onChange={e => setTravelMode(e.target.value)} disabled={!availableProfiles.length}>
            {availableProfiles.length === 0 && <option value="">—</option>}
            {availableProfiles.map(p => <option key={p} value={p}>{PROFILE_LABELS[p] ?? p}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 100 }}>
          <label className="range-label">Zones: {numZones}</label>
          <input type="range" min={1} max={5} value={numZones} onChange={e => setNumZones(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 120 }}>
          <label className="range-label">Max: {maxMinutes} min</label>
          <input type="range" min={5} max={60} step={5} value={maxMinutes} onChange={e => setMaxMinutes(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <label className="check-label"><input type="checkbox" checked={showCompetitors} onChange={e => setShowCompetitors(e.target.checked)} /> Competitors (red)</label>
        <label className="check-label"><input type="checkbox" checked={showDensity} onChange={e => setShowDensity(e.target.checked)} /> Address Density</label>
        {showDensity && <div style={{ minWidth: 120 }}><label className="range-label">H3 Res: {h3Res}</label><input type="range" min={5} max={9} value={h3Res} onChange={e => setH3Res(Number(e.target.value))} style={{ width: '100%' }} /></div>}
      </div>

      <h3>POIs</h3>
      <div style={{ maxHeight: 180, overflowY: 'auto', marginBottom: 12 }}>
        <table className="sidebar-table">
          <thead><tr>{['Name', 'Category'].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{pois.map((p: any) => (
            <tr key={p.POI_ID} className={`clickable${selectedStore?.POI_ID === p.POI_ID ? ' selected' : ''}`} onClick={() => selectStore(p)}>
              <td>{p.NAME}</td>
              <td style={{ fontSize: 10 }}>{p.CATEGORY}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
        {catchmentZones.length > 0 && (
          <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', gap: 8, background: 'rgba(0,0,0,0.6)', borderRadius: 6, padding: '4px 8px' }}>
            {catchmentZones.map((z, i) => <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#fff' }}><span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${ZONE_COLORS[z.zoneIdx % ZONE_COLORS.length].join(',')})` }} />{z.minutes} min</span>)}
          </div>
        )}
      </div>
    </div>
  );
}
