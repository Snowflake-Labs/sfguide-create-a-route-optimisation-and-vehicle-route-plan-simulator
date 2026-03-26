import { useMemo, useState, useCallback } from 'react';
import { ScatterplotLayer } from '@deck.gl/layers';
import { GeoJsonLayer } from '@deck.gl/layers';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import MapView from '../../shared/MapView';
import MetricCard from '../../shared/MetricCard';
import { useSfQuery, useSnowflake } from '../../hooks/useSnowflake';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

const ZONE_COLORS: [number, number, number, number][] = [
  [41, 181, 232, 40], [41, 181, 232, 60], [41, 181, 232, 80], [41, 181, 232, 100], [41, 181, 232, 120],
];

const CATEGORY_COLORS: Record<string, [number, number, number]> = {};
const PALETTE: [number, number, number][] = [
  [41, 181, 232], [255, 107, 53], [34, 197, 94], [234, 179, 8], [168, 85, 247], [236, 72, 153],
  [59, 130, 246], [245, 158, 11], [16, 185, 129], [239, 68, 68], [99, 102, 241], [244, 114, 182],
];

export default function RetailCatchment({ sourceDb, sourceSchema, config }: Props) {
  const { regionName, center, zoom } = useRegion();
  const [selectedCity, setSelectedCity] = useState('ALL');
  const [poiType, setPoiType] = useState('ALL');
  const [selectedStore, setSelectedStore] = useState<any>(null);
  const [travelMode, setTravelMode] = useState('foot-walking');
  const [numZones, setNumZones] = useState(3);
  const [maxMinutes, setMaxMinutes] = useState(15);
  const [catchmentZones, setCatchmentZones] = useState<any[]>([]);
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [densityHexes, setDensityHexes] = useState<any[]>([]);
  const [showCompetitors, setShowCompetitors] = useState(true);
  const [showDensity, setShowDensity] = useState(false);
  const [h3Res, setH3Res] = useState(8);
  const [analyzing, setAnalyzing] = useState(false);
  const { query } = useSnowflake();

  const { data: cities } = useSfQuery(
    `SELECT DISTINCT CITY FROM CITIES_BY_STATE WHERE REGION = '${regionName}' ORDER BY CITY LIMIT 50`, sourceDb, sourceSchema, [regionName]);

  const { data: pois, loading } = useSfQuery(
    `SELECT POI_ID, POI_NAME, BASIC_CATEGORY, CITY,
            ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT
     FROM RETAIL_POIS
     WHERE REGION = '${regionName}'
     ${selectedCity !== 'ALL' ? `AND CITY = '${selectedCity}'` : ''}
     ${poiType !== 'ALL' ? `AND BASIC_CATEGORY = '${poiType}'` : ''}
     LIMIT 2000`,
    sourceDb, sourceSchema, [selectedCity, poiType, regionName]);

  const { data: typeStats } = useSfQuery(
    `SELECT BASIC_CATEGORY AS POI_TYPE, COUNT(*) AS CNT FROM RETAIL_POIS WHERE REGION = '${regionName}' GROUP BY 1 ORDER BY CNT DESC LIMIT 20`, sourceDb, sourceSchema, [regionName]);

  typeStats.forEach((t: any, i: number) => { if (!CATEGORY_COLORS[t.POI_TYPE]) CATEGORY_COLORS[t.POI_TYPE] = PALETTE[i % PALETTE.length]; });

  const storeOptions = useMemo(() =>
    pois.filter((p: any) => poiType !== 'ALL' ? p.BASIC_CATEGORY === poiType : true).slice(0, 100), [pois, poiType]);

  const analyzeCatchment = useCallback(async () => {
    if (!selectedStore) return;
    setAnalyzing(true);
    try {
      const zones: any[] = [];
      for (let i = numZones; i >= 1; i--) {
        const minutes = Math.round(maxMinutes * (i / numZones));
        const result = await query(
          `SELECT GEOJSON AS GEO FROM TABLE(OPENROUTESERVICE_NATIVE_APP.CORE.ISOCHRONES_GEO(
            '${travelMode}', ${selectedStore.LNG}::FLOAT, ${selectedStore.LAT}::FLOAT, ${minutes}::INT))`,
          { database: 'OPENROUTESERVICE_NATIVE_APP', schema: 'CORE' });
        if (result[0]?.GEO) {
          zones.push({ minutes, geojson: JSON.parse(result[0].GEO) });
        }
      }
      setCatchmentZones(zones);

      if (zones.length) {
        const outerGeoJson = JSON.stringify(zones[0].geojson).replace(/'/g, "''");
        const comp = await query(
          `SELECT POI_ID, POI_NAME, BASIC_CATEGORY, ST_X(GEOMETRY) AS LNG, ST_Y(GEOMETRY) AS LAT
           FROM ${sourceDb}.${sourceSchema}.RETAIL_POIS
           WHERE POI_ID != '${selectedStore.POI_ID}'
             AND ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('${outerGeoJson}'))
           LIMIT 500`);
        setCompetitors(comp);

        if (showDensity) {
          const dens = await query(
            `SELECT H3_POINT_TO_CELL_STRING(GEOMETRY, ${h3Res}) AS H3_INDEX, COUNT(*) AS ADDR_COUNT
             FROM ${sourceDb}.${sourceSchema}.REGIONAL_ADDRESSES
             WHERE ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('${outerGeoJson}'))
             GROUP BY 1 ORDER BY ADDR_COUNT DESC LIMIT 5000`);
          setDensityHexes(dens);
        }
      }
    } catch (err) { console.error('Catchment analysis failed:', err); }
    setAnalyzing(false);
  }, [selectedStore, travelMode, numZones, maxMinutes, showDensity, h3Res, query, sourceDb, sourceSchema]);

  const layers = useMemo(() => {
    const l: any[] = [];

    catchmentZones.forEach((zone, i) => {
      if (zone.geojson) {
        l.push(new GeoJsonLayer({
          id: `zone-${i}`,
          data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: zone.geojson, properties: { minutes: zone.minutes } }] },
          filled: true, stroked: true,
          getFillColor: ZONE_COLORS[i % ZONE_COLORS.length],
          getLineColor: [41, 181, 232, 200], getLineWidth: 2, lineWidthMinPixels: 1,
          pickable: true,
        }));
      }
    });

    if (showDensity && densityHexes.length) {
      const maxAddr = Math.max(1, ...densityHexes.map((d: any) => Number(d.ADDR_COUNT)));
      l.push(new H3HexagonLayer({
        id: 'density-hexes', data: densityHexes, pickable: true, filled: true, extruded: false,
        getHexagon: (d: any) => d.H3_INDEX,
        getFillColor: (d: any) => {
          const t = Math.min(Number(d.ADDR_COUNT) / maxAddr, 1);
          return [168, 85, 247, Math.floor(40 + t * 160)] as [number, number, number, number];
        },
      }));
    }

    if (showCompetitors && competitors.length) {
      l.push(new ScatterplotLayer({
        id: 'competitors', data: competitors, pickable: true,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: (d: any) => [...(CATEGORY_COLORS[d.BASIC_CATEGORY] || [128, 128, 128]), 180] as [number, number, number, number],
        getRadius: 50, radiusMinPixels: 3,
      }));
    }

    if (!catchmentZones.length && pois.length) {
      l.push(new ScatterplotLayer({
        id: 'retail-pois', data: pois.filter((p: any) => p.LNG && p.LAT), pickable: true,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: (d: any) => [...(CATEGORY_COLORS[d.BASIC_CATEGORY] || [128, 128, 128]), 180] as [number, number, number, number],
        getRadius: 60, radiusMinPixels: 3,
      }));
    }

    if (selectedStore) {
      l.push(new ScatterplotLayer({
        id: 'selected-store', data: [selectedStore], pickable: true,
        getPosition: (d: any) => [Number(d.LNG), Number(d.LAT)],
        getFillColor: [255, 255, 255, 255], getLineColor: [239, 68, 68, 255],
        getRadius: 120, radiusMinPixels: 8, stroked: true, lineWidthMinPixels: 3,
      }));
    }

    return l;
  }, [pois, catchmentZones, competitors, densityHexes, showCompetitors, showDensity, selectedStore]);

  const viewState = useMemo(() => {
    if (selectedStore) return { longitude: Number(selectedStore.LNG), latitude: Number(selectedStore.LAT), zoom: 13 };
    const valid = pois.filter((p: any) => p.LNG && p.LAT);
    if (valid.length) {
      const lngs = valid.map((p: any) => Number(p.LNG));
      const lats = valid.map((p: any) => Number(p.LAT));
      return { longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 11 };
    }
    const ors = config?.ors?.bounds?.center;
    if (ors?.lng && ors?.lat) return { longitude: ors.lng, latitude: ors.lat, zoom: 11 };
    return { longitude: center.lng, latitude: center.lat, zoom };
  }, [pois, selectedStore, config]);

  return (
    <div className="page-full">
      <div className="page-sidebar-panel" style={{ overflowY: 'auto' }}>
        <h2>Retail Catchment</h2>
        <p style={{ fontSize: 11, color: '#6E7681' }}>{loading ? 'Loading...' : `${pois.length} POIs`}</p>

        <div className="form-group">
          <label>City</label>
          <select className="form-select" value={selectedCity} onChange={e => { setSelectedCity(e.target.value); setSelectedStore(null); setCatchmentZones([]); setCompetitors([]); }}>
            <option value="ALL">All Cities</option>
            {cities.map((c: any) => <option key={c.CITY} value={c.CITY}>{c.CITY}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Category</label>
          <select className="form-select" value={poiType} onChange={e => { setPoiType(e.target.value); setSelectedStore(null); setCatchmentZones([]); setCompetitors([]); }}>
            <option value="ALL">All Types</option>
            {typeStats.map((t: any) => <option key={t.POI_TYPE} value={t.POI_TYPE}>{t.POI_TYPE} ({t.CNT})</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Store</label>
          <select className="form-select" value={selectedStore?.POI_ID || ''} onChange={e => {
            const s = storeOptions.find((p: any) => p.POI_ID === e.target.value);
            setSelectedStore(s || null); setCatchmentZones([]); setCompetitors([]); setDensityHexes([]);
          }}>
            <option value="">Select store...</option>
            {storeOptions.map((p: any) => <option key={p.POI_ID} value={p.POI_ID}>{p.POI_NAME} ({p.CITY})</option>)}
          </select>
        </div>

        {selectedStore && (
          <>
            <div style={{ marginTop: 12, padding: 8, background: 'rgba(41,181,232,0.06)', borderRadius: 8 }}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>Catchment Analysis</h3>
              <div className="form-group">
                <label>Travel Mode</label>
                <select className="form-select" value={travelMode} onChange={e => setTravelMode(e.target.value)}>
                  <option value="foot-walking">Walking</option>
                  <option value="driving-car">Driving</option>
                </select>
              </div>
              <div className="form-group" style={{ marginTop: 6 }}>
                <label>Zones ({numZones})</label>
                <input type="range" min={1} max={5} value={numZones} onChange={e => setNumZones(Number(e.target.value))} style={{ width: '100%' }} />
              </div>
              <div className="form-group" style={{ marginTop: 6 }}>
                <label>Max Travel Time ({maxMinutes} min)</label>
                <input type="range" min={5} max={60} step={5} value={maxMinutes} onChange={e => setMaxMinutes(Number(e.target.value))} style={{ width: '100%' }} />
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, marginTop: 6 }}>
                <input type="checkbox" checked={showCompetitors} onChange={e => setShowCompetitors(e.target.checked)} />
                Show Competitors
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, marginTop: 4 }}>
                <input type="checkbox" checked={showDensity} onChange={e => setShowDensity(e.target.checked)} />
                Show Address Density
              </label>
              {showDensity && (
                <div className="form-group" style={{ marginTop: 4 }}>
                  <label>H3 Resolution ({h3Res})</label>
                  <input type="range" min={7} max={10} value={h3Res} onChange={e => setH3Res(Number(e.target.value))} style={{ width: '100%' }} />
                </div>
              )}
              <button onClick={analyzeCatchment} disabled={analyzing}
                style={{ marginTop: 10, width: '100%', padding: '8px 12px', background: '#29B5E8', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                {analyzing ? 'Analyzing...' : 'Analyze Catchment'}
              </button>
            </div>

            {catchmentZones.length > 0 && (
              <div className="metric-grid-vertical" style={{ marginTop: 12 }}>
                <MetricCard label="Store" value={selectedStore.POI_NAME?.slice(0, 18) || '...'} />
                <MetricCard label="Competitors" value={competitors.length} />
                <MetricCard label="Zones" value={catchmentZones.length} />
                {densityHexes.length > 0 && (
                  <MetricCard label="Address Hexes" value={densityHexes.length} />
                )}
              </div>
            )}

            {competitors.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <h3 style={{ fontSize: 13, marginBottom: 6 }}>Competitor Breakdown</h3>
                <div className="data-table-container" style={{ maxHeight: 150 }}>
                  <table className="data-table">
                    <thead><tr><th className="data-table-th">Category</th><th className="data-table-th">Count</th></tr></thead>
                    <tbody>{Object.entries(
                      competitors.reduce((acc: Record<string, number>, c: any) => { acc[c.BASIC_CATEGORY] = (acc[c.BASIC_CATEGORY] || 0) + 1; return acc; }, {})
                    ).sort((a, b) => (b[1] as number) - (a[1] as number)).map(([cat, cnt]) => (
                      <tr key={cat}><td style={{ fontSize: 11 }}>{cat}</td><td>{cnt as number}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {!selectedStore && (
          <div className="metric-grid-vertical" style={{ marginTop: 12 }}>
            {typeStats.slice(0, 6).map((t: any) => (
              <MetricCard key={t.POI_TYPE} label={t.POI_TYPE} value={Number(t.CNT).toLocaleString()} />
            ))}
          </div>
        )}
      </div>
      <MapView layers={layers} initialViewState={viewState} />
    </div>
  );
}
