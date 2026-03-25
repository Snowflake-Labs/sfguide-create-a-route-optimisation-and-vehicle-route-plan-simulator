import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import { H3HexagonLayer, TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';

const RC_DB = 'FLEET_INTELLIGENCE';
const RC_SCHEMA = 'RETAIL_CATCHMENT';

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
  const [cities, setCities] = useState<any[]>([]);
  const [selectedCity, setSelectedCity] = useState('');
  const [pois, setPois] = useState<any[]>([]);
  const [selectedStore, setSelectedStore] = useState<any>(null);
  const [travelMode, setTravelMode] = useState('driving-car');
  const [numZones, setNumZones] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [catchmentZones, setCatchmentZones] = useState<any[]>([]);
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [densityHexes, setDensityHexes] = useState<any[]>([]);
  const [showCompetitors, setShowCompetitors] = useState(true);
  const [showDensity, setShowDensity] = useState(false);
  const [h3Res, setH3Res] = useState(7);
  const [loading, setLoading] = useState(true);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });

  useEffect(() => {
    sfQuery(`SELECT DISTINCT CITY, STATE FROM CITIES_BY_STATE ORDER BY STATE, CITY`)
      .then(setCities)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedCity) return;
    setLoading(true);
    sfQuery(`SELECT POI_ID, NAME, CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT FROM RETAIL_POIS WHERE CITY = '${selectedCity}' LIMIT 200`)
      .then(r => { setPois(r); if (r.length > 0) setViewState(prev => ({ ...prev, longitude: Number(r[0].LNG), latitude: Number(r[0].LAT), zoom: 12 })); })
      .finally(() => setLoading(false));
  }, [selectedCity]);

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
      const rows = await sfQuery(`SELECT GEOJSON AS GEO FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES_GEO('${travelMode}', ${lng}, ${lat}, ${minutes}))`, RC_DB, RC_SCHEMA);
      if (rows[0]?.GEO) {
        try { zones.push({ zoneIdx: z - 1, minutes, geojson: JSON.parse(rows[0].GEO) }); } catch {}
      }
    }
    setCatchmentZones(zones.reverse());

    const [comp, density] = await Promise.all([
      sfQuery(`SELECT POI_ID, NAME, CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT FROM RETAIL_POIS WHERE CITY = '${selectedCity}' AND POI_ID != '${poi.POI_ID}' AND ST_DWITHIN(GEOMETRY, ST_MAKEPOINT(${lng}, ${lat}), ${maxMinutes * 1000}) LIMIT 50`),
      sfQuery(`SELECT H3_POINT_TO_CELL_STRING(GEOMETRY, ${h3Res}) AS H3_INDEX, COUNT(*) AS CNT FROM REGIONAL_ADDRESSES WHERE CITY = '${selectedCity}' GROUP BY 1 HAVING CNT >= 2 LIMIT 5000`),
    ]);
    setCompetitors(comp);
    setDensityHexes(density);
  }, [selectedCity, travelMode, numZones, maxMinutes, h3Res]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const dataLayers = useMemo(() => {
    const result: any[] = [];
    catchmentZones.forEach((z, i) => {
      const c = ZONE_COLORS[z.zoneIdx % ZONE_COLORS.length];
      result.push(new GeoJsonLayer({ id: `zone-${i}`, data: z.geojson, filled: true, stroked: true, getFillColor: [...c, 40], getLineColor: [...c, 180], lineWidthMinPixels: 2 }));
    });
    if (showDensity && densityHexes.length) {
      const maxCnt = Math.max(1, ...densityHexes.map((h: any) => Number(h.CNT)));
      result.push(new H3HexagonLayer({ id: 'density', data: densityHexes, pickable: true, filled: true, extruded: false, getHexagon: (d: any) => d.H3_INDEX, getFillColor: (d: any) => { const t = Number(d.CNT) / maxCnt; return [245, 158, 11, Math.floor(t * 180)] as [number, number, number, number]; }, updateTriggers: { getFillColor: [maxCnt] } }));
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
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Multi-zone isochrone catchment analysis</p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ minWidth: 160 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>City</label>
          <select className="select" value={selectedCity} onChange={e => setSelectedCity(e.target.value)}>
            <option value="">Select city...</option>
            {cities.map(c => <option key={`${c.CITY}-${c.STATE}`} value={c.CITY}>{c.CITY}, {c.STATE}</option>)}
          </select>
        </div>
        <div style={{ minWidth: 120 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Travel Mode</label>
          <select className="select" value={travelMode} onChange={e => setTravelMode(e.target.value)}>
            <option value="driving-car">Car</option>
            <option value="cycling-regular">Bicycle</option>
            <option value="foot-walking">Walking</option>
          </select>
        </div>
        <div style={{ minWidth: 120 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Zones: {numZones}</label>
          <input type="range" min={1} max={5} value={numZones} onChange={e => setNumZones(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
        <div style={{ minWidth: 120 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Max: {maxMinutes} min</label>
          <input type="range" min={5} max={60} step={5} value={maxMinutes} onChange={e => setMaxMinutes(Number(e.target.value))} style={{ width: '100%' }} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={showCompetitors} onChange={e => setShowCompetitors(e.target.checked)} /> Competitors (red)</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={showDensity} onChange={e => setShowDensity(e.target.checked)} /> Address Density</label>
        {showDensity && <div style={{ minWidth: 120 }}><label>H3 Res: {h3Res}</label><input type="range" min={5} max={9} value={h3Res} onChange={e => setH3Res(Number(e.target.value))} style={{ width: '100%' }} /></div>}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
            <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, fontSize: 11, flexWrap: 'wrap' }}>
            {catchmentZones.map((z, i) => <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: `rgb(${ZONE_COLORS[z.zoneIdx % ZONE_COLORS.length].join(',')})` }} />{z.minutes} min</span>)}
          </div>
        </div>
        <div style={{ flex: '0 0 260px', maxHeight: 560, overflowY: 'auto' }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>POIs</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead><tr>{['Name', 'Category'].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)' }}>{h}</th>)}</tr></thead>
            <tbody>{pois.map((p: any) => (
              <tr key={p.POI_ID} onClick={() => selectStore(p)} style={{ cursor: 'pointer', background: selectedStore?.POI_ID === p.POI_ID ? 'rgba(41,181,232,0.1)' : undefined }}>
                <td style={{ padding: '6px 8px' }}>{p.NAME}</td>
                <td style={{ padding: '6px 8px', fontSize: 10 }}>{p.CATEGORY}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
