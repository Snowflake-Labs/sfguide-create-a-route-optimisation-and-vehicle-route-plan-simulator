import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import { H3HexagonLayer, TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { useRegion } from '../hooks/useRegion';
import { useActivePreset } from '../hooks/useActivePreset';
import { useFitMap } from '../shared/useFitMap';
import RecenterButton from '../shared/RecenterButton';
import { coordsFromGeoJSON, type LngLat } from '../shared/mapFit';

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

// POI categories used by the retail-catchment SQL pipeline. Kept in sync with
// references/sql-pipeline.md Step 5b so that the live Overture path returns
// the same kinds of stores as the cached RETAIL_POIS table.
const POI_CATEGORIES = [
  'coffee_shop', 'fast_food_restaurant', 'restaurant', 'casual_eatery',
  'grocery_store', 'convenience_store', 'gas_station', 'pharmacy',
  'clothing_store', 'electronics_store', 'specialty_store', 'gym',
  'beauty_salon', 'hair_salon', 'bakery', 'bar', 'supermarket',
];
const POI_CATEGORIES_SQL = POI_CATEGORIES.map(c => `'${c}'`).join(',');

interface ProvisionedRegion {
  region: string;          // REGION_REGISTRY.REGION_NAME (used as REGION column value in cached tables)
  ors_key: string;         // The key that ORS_STATUS / ISOCHRONES actually accept for this region
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

// Standard boundary join pattern (see AGENTS.md "Prefer Boundary over Bbox").
// Resolves REGION_CATALOG to the ONE correct polygon for `orsKey` and joins it
// so spatial filtering happens server-side against the polygon — no GeoJSON sent
// over the wire. The catalog holds same-name rows (e.g. country "Mexico" vs the
// natural-earth state "México", both LOOKUP_NAME='Mexico'), so we resolve to a
// single ranked row (exact REGION_KEY first, then larger admin level/area) and
// JOIN it via ON TRUE — a bare JOIN on the table would fan out duplicate POIs
// and could pick the wrong (smaller) polygon. Ranking mirrors the server helper
// server/lib/region-catalog-match.ts; keep the two in sync.
function boundaryJoin(orsKey: string): string {
  const k = orsKey.replace(/'/g, "''");
  return `JOIN (
            SELECT BOUNDARY FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG
            WHERE BOUNDARY IS NOT NULL
              AND (UPPER(REGION_KEY) = UPPER('${k}')
                   OR UPPER(LOOKUP_NAME) = UPPER('${k}')
                   OR UPPER(REGION_NAME) = UPPER('${k}'))
            ORDER BY
              CASE WHEN UPPER(REGION_KEY) = UPPER('${k}') THEN 0
                   WHEN UPPER(LOOKUP_NAME) = UPPER('${k}') THEN 1 ELSE 2 END,
              CASE LEVEL WHEN 'continent' THEN 0 WHEN 'country' THEN 1
                   WHEN 'sub-region' THEN 2 WHEN 'sub-sub-region' THEN 3 ELSE 4 END,
              COALESCE(BOUNDARY_AREA_KM2, 0) DESC
            LIMIT 1
          ) rc ON TRUE`;
}
const BOUNDARY_FILTER = `ST_WITHIN(p.GEOMETRY, rc.BOUNDARY)`;

export default function RetailCatchment() {
  const preset = useActivePreset();
  const { regions: globalRegions, center: globalCenter, zoom: globalZoom } = useRegion();
  const [provisionedRegions, setProvisionedRegions] = useState<ProvisionedRegion[]>([]);
  const [selectedRegion, setSelectedRegion] = useState('');
  const [availableProfiles, setAvailableProfiles] = useState<string[]>([]);
  const [pois, setPois] = useState<any[]>([]);
  const [selectedStore, setSelectedStore] = useState<any>(null);
  const [travelMode, setTravelMode] = useState(preset.orsProfile);
  const [numZones, setNumZones] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [catchmentZones, setCatchmentZones] = useState<any[]>([]);
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [densityHexes, setDensityHexes] = useState<any[]>([]);
  const [showCompetitors, setShowCompetitors] = useState(true);
  const [showDensity, setShowDensity] = useState(true);
  const [h3Res, setH3Res] = useState(7);
  const [loading, setLoading] = useState(true);

  // Resolve every globalRegion against ORS_STATUS. Try REGION_NAME first, then
  // ORS_REGION_KEY — REGION_REGISTRY can hold a stale ORS_REGION_KEY (e.g.
  // 'California' for region 'UsCalifornia'), and the actual ORS service is
  // named after REGION_NAME. The first key that returns service_ready=true
  // with non-empty profiles is stored as ors_key for downstream calls.
  useEffect(() => {
    if (!globalRegions.length) return;
    setLoading(true);
    const regionChecks = globalRegions.map(async r => {
      const candidates = Array.from(new Set([r.REGION_NAME, r.ORS_REGION_KEY].filter(Boolean) as string[]));
      for (const key of candidates) {
        try {
          const rows = await sfQuery(`SELECT TO_VARCHAR(OPENROUTESERVICE_APP.CORE.ORS_STATUS('${key.replace(/'/g, "''")}')) AS S`, 'OPENROUTESERVICE_APP', 'CORE');
          const raw = rows?.[0]?.S;
          if (!raw) continue;
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!data?.service_ready) continue;
          const profiles = Object.keys(data.profiles || {});
          if (!profiles.length) continue;
          return {
            region: r.REGION_NAME,
            ors_key: key,
            display_name: r.DISPLAY_NAME || r.REGION_NAME,
            profiles_loaded: profiles,
            center_lat: Number(r.BOUNDARY_CENTROID_LAT ?? r.CENTER_LAT ?? 0) || 0,
            center_lon: Number(r.BOUNDARY_CENTROID_LON ?? r.CENTER_LON ?? 0) || 0,
            zoom: Number(r.ZOOM_LEVEL ?? 11),
          } as ProvisionedRegion;
        } catch { /* try next candidate */ }
      }
      return null;
    });
    Promise.all(regionChecks)
      .then(results => setProvisionedRegions(results.filter((r): r is ProvisionedRegion => r !== null)))
      .finally(() => setLoading(false));
  }, [globalRegions]);

  // Initial map view follows the global region until the user picks one locally.
  useEffect(() => {
    /* viewState now driven by useFitMap below */
  }, [globalCenter.lng, globalCenter.lat, globalZoom, selectedRegion]);

  useEffect(() => {
    if (preset.loading || !preset.orsProfile) return;
    setTravelMode((prev) => {
      if (availableProfiles.length > 0 && !availableProfiles.includes(preset.orsProfile)) return prev;
      return preset.orsProfile;
    });
  }, [preset.orsProfile, preset.loading, availableProfiles]);

  // When the local region selection changes: refresh available profiles, reset
  // travel mode if needed, recenter the map onto the region's BOUNDARY centroid
  // (authoritative — always on land, inside the polygon), and load POIs from
  // either the cached pipeline tables (SanFrancisco) or live Overture
  // polygon-clipped (every other region).
  useEffect(() => {
    setSelectedStore(null);
    setCatchmentZones([]);
    setCompetitors([]);
    setDensityHexes([]);
    setPois([]);

    if (!selectedRegion) {
      setAvailableProfiles([]);
      return;
    }

    const region = provisionedRegions.find(r => r.region === selectedRegion);
    if (!region) return;

    setAvailableProfiles(region.profiles_loaded);
    const preferred = region.profiles_loaded.includes(preset.orsProfile)
      ? preset.orsProfile
      : region.profiles_loaded[0];
    if (!region.profiles_loaded.includes(travelMode)) {
      setTravelMode(preferred);
    }

    // Always recenter on the boundary centroid — even if 0 POIs come back.
    /* viewState driven by useFitMap on data changes */

    setLoading(true);
    const useCached = region.region === 'SanFrancisco';
    const poiSql = useCached
      // SF fast path: cached, indexed pipeline table. ST_WITHIN against the
      // boundary is a safe over-filter (REGION column already constrains
      // the result set, ST_WITHIN drops anything outside the polygon).
      ? `SELECT p.POI_ID, p.POI_NAME AS NAME, p.BASIC_CATEGORY AS CATEGORY,
                ST_X(p.GEOMETRY) AS LNG, ST_Y(p.GEOMETRY) AS LAT
         FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS p
         ${boundaryJoin(region.ors_key)}
         WHERE p.REGION = '${region.region.replace(/'/g, "''")}'
           AND ${BOUNDARY_FILTER}
         LIMIT 200`
      // Live boundary path: any provisioned region. Polygon-clipped via
      // REGION_CATALOG.BOUNDARY (no bbox, no GeoJSON over the wire).
      : `SELECT p.ID AS POI_ID,
                p.NAMES:primary::VARCHAR AS NAME,
                p.BASIC_CATEGORY AS CATEGORY,
                ST_X(p.GEOMETRY) AS LNG,
                ST_Y(p.GEOMETRY) AS LAT
         FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
         ${boundaryJoin(region.ors_key)}
         WHERE p.GEOMETRY IS NOT NULL
           AND p.BASIC_CATEGORY IN (${POI_CATEGORIES_SQL})
           AND ${BOUNDARY_FILTER}
         LIMIT 200`;

    sfQuery(poiSql)
      .then(r => setPois(r))
      .finally(() => setLoading(false));
  }, [selectedRegion, provisionedRegions]);

  const fetchDensity = useCallback(async (region: ProvisionedRegion, res: number) => {
    const sql = region.region === 'SanFrancisco'
      ? `SELECT H3_POINT_TO_CELL_STRING(p.GEOMETRY, ${res}) AS H3_INDEX, COUNT(*) AS CNT
         FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.REGIONAL_ADDRESSES p
         ${boundaryJoin(region.ors_key)}
         WHERE p.REGION = '${region.region.replace(/'/g, "''")}'
           AND ${BOUNDARY_FILTER}
         GROUP BY 1 HAVING CNT >= 2 LIMIT 5000`
      : `SELECT H3_POINT_TO_CELL_STRING(p.GEOMETRY, ${res}) AS H3_INDEX, COUNT(*) AS CNT
         FROM OVERTURE_MAPS__ADDRESSES.CARTO.ADDRESS p
         ${boundaryJoin(region.ors_key)}
         WHERE p.GEOMETRY IS NOT NULL AND ${BOUNDARY_FILTER}
         GROUP BY 1 HAVING CNT >= 2 LIMIT 5000`;
    const density = await sfQuery(sql);
    setDensityHexes(density);
  }, []);

  useEffect(() => {
    const region = provisionedRegions.find(r => r.region === selectedRegion);
    if (selectedStore && region) fetchDensity(region, h3Res);
  }, [h3Res, fetchDensity, selectedStore, selectedRegion, provisionedRegions]);

  const selectStore = useCallback(async (poi: any) => {
    setSelectedStore(poi);
    setCatchmentZones([]);
    setCompetitors([]);
    setDensityHexes([]);

    const region = provisionedRegions.find(r => r.region === selectedRegion);
    if (!region) return;

    const lng = Number(poi.LNG);
    const lat = Number(poi.LAT);

    const zones: any[] = [];
    for (let z = 1; z <= numZones; z++) {
      const minutes = Math.round((maxMinutes / numZones) * z);
      const orsKey = region.ors_key.replace(/'/g, "''");
      console.log('[RetailCatchment] calling ISOCHRONES', travelMode, lng, lat, minutes, orsKey);
      const rows = await sfQuery(`SELECT GEOJSON AS GEO FROM TABLE(OPENROUTESERVICE_APP.CORE.ISOCHRONES('${travelMode}', ${lng}::FLOAT, ${lat}::FLOAT, ${minutes}::INT, '${orsKey}'))`, 'OPENROUTESERVICE_APP', 'CORE');
      console.log('[RetailCatchment] ISOCHRONES rows:', rows.length, rows[0]);
      if (rows[0]?.GEO) {
        try { zones.push({ zoneIdx: z - 1, minutes, geojson: JSON.parse(rows[0].GEO) }); } catch {}
      }
    }
    setCatchmentZones(zones.reverse());

    const poiId = String(poi.POI_ID).replace(/'/g, "''");
    const compSql = region.region === 'SanFrancisco'
      ? `SELECT p.POI_ID, p.POI_NAME AS NAME, p.BASIC_CATEGORY AS CATEGORY,
                ST_X(p.GEOMETRY) AS LNG, ST_Y(p.GEOMETRY) AS LAT
         FROM FLEET_INTELLIGENCE.RETAIL_CATCHMENT.RETAIL_POIS p
         ${boundaryJoin(region.ors_key)}
         WHERE p.REGION = '${region.region.replace(/'/g, "''")}'
           AND ${BOUNDARY_FILTER}
           AND p.POI_ID != '${poiId}'
           AND ST_DWITHIN(p.GEOMETRY, ST_MAKEPOINT(${lng}, ${lat}), ${maxMinutes * 1000})
         LIMIT 50`
      : `SELECT p.ID AS POI_ID, p.NAMES:primary::VARCHAR AS NAME,
                p.BASIC_CATEGORY AS CATEGORY,
                ST_X(p.GEOMETRY) AS LNG, ST_Y(p.GEOMETRY) AS LAT
         FROM OVERTURE_MAPS__PLACES.CARTO.PLACE p
         ${boundaryJoin(region.ors_key)}
         WHERE p.GEOMETRY IS NOT NULL
           AND p.BASIC_CATEGORY IN (${POI_CATEGORIES_SQL})
           AND ${BOUNDARY_FILTER}
           AND p.ID != '${poiId}'
           AND ST_DWITHIN(p.GEOMETRY, ST_MAKEPOINT(${lng}, ${lat}), ${maxMinutes * 1000})
         LIMIT 50`;

    const [comp] = await Promise.all([
      sfQuery(compSql),
      fetchDensity(region, h3Res),
    ]);
    setCompetitors(comp);
  }, [selectedRegion, provisionedRegions, travelMode, numZones, maxMinutes, h3Res, fetchDensity]);

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

  const fitCoords = useMemo<LngLat[]>(() => {
    const out: LngLat[] = [];
    if (selectedStore && selectedStore.LNG != null && selectedStore.LAT != null) {
      out.push([Number(selectedStore.LNG), Number(selectedStore.LAT)]);
    }
    for (const z of catchmentZones) {
      if (z.geojson) out.push(...coordsFromGeoJSON(z.geojson));
    }
    for (const p of pois) {
      if (p.LNG != null && p.LAT != null) out.push([Number(p.LNG), Number(p.LAT)]);
    }
    for (const c of competitors) {
      if (c.LNG != null && c.LAT != null) out.push([Number(c.LNG), Number(c.LAT)]);
    }
    return out;
  }, [selectedStore, catchmentZones, pois, competitors]);

  const region = provisionedRegions.find(r => r.region === selectedRegion);
  const fallback = useMemo(() => {
    const lng = region?.center_lon ?? globalCenter.lng ?? -122.4194;
    const lat = region?.center_lat ?? globalCenter.lat ?? 37.7749;
    const z = region?.zoom ?? globalZoom ?? 11;
    return { longitude: lng, latitude: lat, zoom: z, pitch: 0, bearing: 0 };
  }, [region, globalCenter.lng, globalCenter.lat, globalZoom]);
  const { containerRef, viewState, onViewStateChange, recenter } = useFitMap(fitCoords, { fallback, regionKey: selectedRegion });

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

      <div ref={containerRef} style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL viewState={viewState} onViewStateChange={onViewStateChange} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
        <RecenterButton onClick={recenter} disabled={!fitCoords.length} />
        {catchmentZones.length > 0 && (
          <div style={{ position: 'absolute', bottom: 12, left: 12, display: 'flex', gap: 8, background: 'rgba(0,0,0,0.6)', borderRadius: 6, padding: '4px 8px' }}>
            {catchmentZones.map((z, i) => <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#fff' }}><span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${ZONE_COLORS[z.zoneIdx % ZONE_COLORS.length].join(',')})` }} />{z.minutes} min</span>)}
          </div>
        )}
      </div>
    </div>
  );
}
