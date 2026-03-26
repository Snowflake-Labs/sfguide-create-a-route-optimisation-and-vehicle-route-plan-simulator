import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TileLayer, H3HexagonLayer } from '@deck.gl/geo-layers';
import MetricCard from '../../shared/MetricCard';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

interface MatrixTable {
  region: string;
  profile: string;
  resolution: string;
  row_count: number;
  bytes: number;
  table_name: string;
  full_table: string;
}

interface ReachDest {
  hex_id: string;
  lat: number;
  lon: number;
  travel_time_secs: number;
  distance_meters: number;
}

const COLORS: [number, number, number][] = [
  [127, 0, 155],
  [95, 0, 180],
  [75, 0, 130],
  [50, 0, 180],
  [0, 40, 210],
  [0, 90, 235],
  [0, 155, 100],
  [0, 200, 30],
  [220, 210, 0],
  [255, 220, 0],
  [255, 165, 0],
  [255, 100, 0],
];
const COLOR_OVER_MAX: [number, number, number] = [210, 0, 0];
const BUCKET_MINUTES = 10;
const CARTO_TILES = '/api/tiles/{z}/{x}/{y}';

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + ' GB';
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(1) + ' MB';
  if (bytes >= 1_000) return (bytes / 1_000).toFixed(1) + ' KB';
  return bytes + ' B';
}

const RES_LABELS: Record<number, string> = {
  5: 'Metro (~250 km\u00B2)', 6: 'City (~36 km\u00B2)', 7: 'District (~5 km\u00B2)',
  8: 'Neighborhood (~0.7 km\u00B2)', 9: 'Block (~0.1 km\u00B2)', 10: 'Street (~0.015 km\u00B2)',
};

function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap',
    data: CARTO_TILES,
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props: any) => {
      const { boundingBox } = props.tile;
      return new BitmapLayer(props, {
        data: undefined,
        image: props.data,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
      });
    },
  });
}

export default function TravelTimeExplorer({}: Props) {
  const { center, zoom } = useRegion();
  const [inventory, setInventory] = useState<MatrixTable[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [destinations, setDestinations] = useState<ReachDest[]>([]);
  const [allHexes, setAllHexes] = useState<string[]>([]);
  const [originHex, setOriginHex] = useState('');
  const [originLat, setOriginLat] = useState(0);
  const [originLon, setOriginLon] = useState(0);
  const [driveTimeLimit, setDriveTimeLimit] = useState(60);
  const [sliderMax, setSliderMax] = useState(60);
  const [activeTable, setActiveTable] = useState('');
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom, pitch: 0, bearing: 0 });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const [mapDims, setMapDims] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const el = mapContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setMapDims({ width: Math.round(width), height: Math.round(height) });
    });
    ro.observe(el);
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      setMapDims({ width: el.clientWidth, height: el.clientHeight });
    }
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    fetch('/api/matrix/viewer-inventory')
      .then(r => r.json())
      .then(d => setInventory(d.tables || []))
      .catch(() => {});
  }, []);

  const regions = useMemo(() => [...new Set(inventory.map(t => t.region))], [inventory]);
  const [selRegion, setSelRegion] = useState('');
  const [selProfile, setSelProfile] = useState('');
  const [selRes, setSelRes] = useState('');

  useEffect(() => {
    if (regions.length > 0 && !selRegion) setSelRegion(regions[0]);
  }, [regions]);

  const profiles = useMemo(() =>
    [...new Set(inventory.filter(t => t.region === selRegion).map(t => t.profile))],
    [inventory, selRegion]
  );
  useEffect(() => {
    if (profiles.length > 0 && !profiles.includes(selProfile)) setSelProfile(profiles[0]);
  }, [profiles]);

  const resolutions = useMemo(() =>
    [...new Set(inventory.filter(t => t.region === selRegion && t.profile === selProfile).map(t => t.resolution))].sort(),
    [inventory, selRegion, selProfile]
  );
  useEffect(() => {
    if (resolutions.length > 0 && !resolutions.includes(selRes)) setSelRes(resolutions[0]);
  }, [resolutions]);

  const matchedTable = useMemo(() =>
    inventory.find(t => t.region === selRegion && t.profile === selProfile && t.resolution === selRes) || null,
    [inventory, selRegion, selProfile, selRes]
  );

  const fetchReachability = useCallback(async (tableName: string, origin: string, maxTimeSecs?: number) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const tbl = encodeURIComponent(tableName);
    let url = `/api/matrix/reachability?table=${tbl}&origin=${origin}`;
    if (maxTimeSecs !== undefined) url += `&max_time=${maxTimeSecs}`;
    const res = await fetch(url, { signal: ctrl.signal });
    return res.json();
  }, []);

  const parseDestinations = (data: any): ReachDest[] =>
    (data.destinations || []).map((r: any) => ({
      hex_id: r.HEX_ID, lat: Number(r.LAT), lon: Number(r.LON),
      travel_time_secs: Number(r.TRAVEL_TIME_SECONDS || 0),
      distance_meters: Number(r.TRAVEL_DISTANCE_METERS || 0),
    }));

  const loadRandomOrigin = useCallback(async (table: MatrixTable) => {
    setLoading(true);
    setLoadingMsg('Loading...');
    setDestinations([]);
    try {
      const tbl = encodeURIComponent(table.table_name);
      const [originRes, hexesRes] = await Promise.all([
        fetch(`/api/matrix/random-origin?table=${tbl}`),
        fetch(`/api/matrix/all-hexes?table=${tbl}`),
      ]);
      const [originData, hexesData] = await Promise.all([originRes.json(), hexesRes.json()]);
      if (!originData.origin_hex) return;
      setAllHexes(hexesData.hexes || []);
      const gMax = Number(originData.global_max_time_secs || 0);
      const sMax = Math.ceil(gMax / 60) || 60;
      setSliderMax(sMax);
      setOriginHex(originData.origin_hex);
      setOriginLat(originData.origin_lat);
      setOriginLon(originData.origin_lon);
      setActiveTable(table.table_name);
      setLoadingMsg('Loading reachability...');
      const reachData = await fetchReachability(table.table_name, originData.origin_hex);
      const dests = parseDestinations(reachData);
      setDestinations(dests);
      const maxVisible = dests.reduce((m, d) => Math.max(m, d.travel_time_secs), 0);
      setDriveTimeLimit(Math.ceil(maxVisible / 60) || sMax);
      setViewState(prev => ({
        ...prev,
        longitude: originData.origin_lon,
        latitude: originData.origin_lat,
        zoom: 11,
      }));
    } catch (e: any) {
      if (e.name !== 'AbortError') setDestinations([]);
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }, [fetchReachability]);

  useEffect(() => {
    if (matchedTable) loadRandomOrigin(matchedTable);
  }, [matchedTable]);

  const originSet = useMemo(() => new Set(allHexes), [allHexes]);
  const [notOriginMsg, setNotOriginMsg] = useState('');

  const handleHexClick = useCallback(async (info: any) => {
    const hexId = info?.object?.hex_id;
    if (!hexId || !activeTable) return;
    if (hexId === originHex) return;
    if (!originSet.has(hexId)) {
      setNotOriginMsg(`${hexId} is a destination only \u2014 click a gray hexagon instead.`);
      setTimeout(() => setNotOriginMsg(''), 3000);
      return;
    }
    setNotOriginMsg('');
    setLoading(true);
    setLoadingMsg('Loading reachability...');
    try {
      const reachData = await fetchReachability(activeTable, hexId);
      const dests = parseDestinations(reachData);
      setOriginHex(hexId);
      setOriginLat(Number(reachData.origin_lat || 0));
      setOriginLon(Number(reachData.origin_lon || 0));
      setDestinations(dests);
      const maxVisible = dests.reduce((m, d) => Math.max(m, d.travel_time_secs), 0);
      setDriveTimeLimit(Math.ceil(maxVisible / 60) || sliderMax);
    } catch (e: any) {
      if (e.name !== 'AbortError') {}
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }, [activeTable, originHex, fetchReachability, sliderMax, originSet]);

  const handleSliderChange = useCallback((mins: number) => {
    setDriveTimeLimit(mins);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!activeTable || !originHex) return;
      setLoading(true);
      setLoadingMsg('Filtering...');
      try {
        const reachData = await fetchReachability(activeTable, originHex, mins * 60);
        setDestinations(parseDestinations(reachData));
      } catch (e: any) {
        if (e.name !== 'AbortError') {}
      } finally {
        setLoading(false);
        setLoadingMsg('');
      }
    }, 300);
  }, [activeTable, originHex, fetchReachability]);

  const basemap = useMemo(() => cartoBasemap(), []);
  const reachSet = useMemo(() => new Set(destinations.map(d => d.hex_id)), [destinations]);

  const bgLayer = useMemo(() => {
    if (allHexes.length === 0) return null;
    const bgData = allHexes.filter(h => !reachSet.has(h) && h !== originHex).map(h => ({ hex_id: h }));
    if (bgData.length === 0) return null;
    return new H3HexagonLayer({
      id: 'hex-bg',
      data: bgData,
      pickable: true,
      filled: true,
      extruded: false,
      getHexagon: (d: any) => d.hex_id,
      getFillColor: [160, 160, 175, 70] as [number, number, number, number],
      opacity: 0.5,
      updateTriggers: { data: [reachSet, originHex] },
    });
  }, [allHexes, reachSet, originHex]);

  const reachLayer = useMemo(() => {
    if (destinations.length === 0) return null;
    return new H3HexagonLayer({
      id: 'hex-reach',
      data: destinations,
      pickable: true,
      filled: true,
      extruded: false,
      getHexagon: (d: ReachDest) => d.hex_id,
      getFillColor: (d: ReachDest) => {
        const mins = d.travel_time_secs / 60;
        if (mins >= BUCKET_MINUTES * COLORS.length) return [...COLOR_OVER_MAX, 180] as [number, number, number, number];
        const bucket = Math.floor(mins / BUCKET_MINUTES);
        const idx = Math.min(bucket, COLORS.length - 1);
        return [...COLORS[idx], 180] as [number, number, number, number];
      },
      opacity: 0.7,
      updateTriggers: { getFillColor: [destinations] },
    });
  }, [destinations]);

  const originLayer = useMemo(() => {
    if (!originHex) return null;
    return new ScatterplotLayer({
      id: 'origin-marker',
      data: [{ lat: originLat, lon: originLon }],
      pickable: false,
      getPosition: (d: any) => [d.lon, d.lat],
      getFillColor: [255, 255, 255, 220],
      getLineColor: [41, 181, 232, 255],
      getRadius: 80,
      lineWidthMinPixels: 3,
      stroked: true,
      filled: true,
    });
  }, [originHex, originLat, originLon]);

  const layers = useMemo(
    () => [basemap, bgLayer, reachLayer, originLayer].filter(Boolean),
    [basemap, bgLayer, reachLayer, originLayer]
  );

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.travel_time_secs !== undefined) {
      return {
        html: `<b>${object.hex_id}</b><br/>Travel time: ${(object.travel_time_secs / 60).toFixed(1)} min<br/>Distance: ${(object.distance_meters / 1000).toFixed(1)} km`,
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
    if (object.hex_id) {
      return {
        html: `<b>${object.hex_id}</b><br/><i>Click to set as origin</i>`,
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
    return null;
  }, []);

  const localMaxMin = useMemo(() => {
    if (destinations.length === 0) return 0;
    return Math.ceil(destinations.reduce((m, d) => Math.max(m, d.travel_time_secs), 0) / 60);
  }, [destinations]);

  return (
    <div className="panel">
      <h2>Travel Time Explorer</h2>
      <p className="subtitle">Explore pre-computed travel time matrices with interactive H3 hexagonal visualization</p>

      {inventory.length === 0 && !loading && (
        <div style={{ padding: 16, background: 'rgba(0,0,0,0.02)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>No travel time matrices found. Use the ORS Control Panel to build one first.</div>
      )}

      {inventory.length > 0 && (
        <>
          <h3>Select Matrix</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Region</label>
              <select className="select" value={selRegion} onChange={e => setSelRegion(e.target.value)}>
                {regions.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Profile</label>
              <select className="select" value={selProfile} onChange={e => setSelProfile(e.target.value)}>
                {profiles.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Resolution</label>
              <select className="select" value={selRes} onChange={e => setSelRes(e.target.value)}>
                {resolutions.map(r => {
                  const num = parseInt(r.replace('RES', ''));
                  return <option key={r} value={r}>{r} — {RES_LABELS[num] || ''}</option>;
                })}
              </select>
            </div>
          </div>
          {matchedTable && (
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8, display: 'block' }}>
              {formatNumber(matchedTable.row_count)} pairs · {formatBytes(matchedTable.bytes)}
              {allHexes.length > 0 && ` · ${allHexes.length.toLocaleString()} hexagons`}
            </span>
          )}
        </>
      )}

      {originHex && (
        <>
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Origin: {originHex}</span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {destinations.length.toLocaleString()} reachable
                {allHexes.length > 0 && ` / ${allHexes.length.toLocaleString()} total`}
              </span>
            </div>
            <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Max travel time: <strong>{driveTimeLimit} min</strong>
              {localMaxMin > 0 && localMaxMin < sliderMax && (
                <span style={{ marginLeft: 8, color: 'var(--text-secondary)', opacity: 0.7 }}>
                  (origin max: {localMaxMin} min)
                </span>
              )}
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type="range" min={1}
                max={sliderMax}
                value={driveTimeLimit}
                onChange={e => handleSliderChange(Number(e.target.value))}
                style={{ width: '100%' }}
              />
              {localMaxMin > 0 && localMaxMin < sliderMax && (
                <div style={{
                  position: 'absolute',
                  left: `${((localMaxMin - 1) / (sliderMax - 1)) * 100}%`,
                  top: -2,
                  width: 2,
                  height: 20,
                  background: 'var(--text-secondary)',
                  opacity: 0.5,
                  pointerEvents: 'none',
                }} />
              )}
            </div>
            <div style={{ display: 'flex', gap: 0, height: 8, borderRadius: 4, overflow: 'hidden' }}>
              {COLORS.map((c, i) => (
                <div key={i} style={{ flex: 1, background: `rgb(${c.join(',')})` }} />
              ))}
              <div style={{ flex: 1, background: `rgb(${COLOR_OVER_MAX.join(',')})` }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-secondary)' }}>
              <span>0</span>
              <span>20m</span>
              <span>40m</span>
              <span>1h</span>
              <span>1.5h</span>
              <span>2h+</span>
            </div>
          </div>

          <div ref={mapContainerRef} style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>{loadingMsg}</div>}
            {mapDims && (
              <DeckGL
                width={mapDims.width}
                height={mapDims.height}
                viewState={viewState}
                onViewStateChange={({ viewState: vs }: any) => {
                  if (Number.isFinite(vs.longitude) && Number.isFinite(vs.latitude) && Number.isFinite(vs.zoom)) setViewState(vs);
                }}
                controller={true}
                layers={layers}
                onClick={handleHexClick}
                getTooltip={getTooltip}
                style={{ position: 'absolute', top: '0', left: '0', width: `${mapDims.width}px`, height: `${mapDims.height}px` }}
              />
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
            Click any gray hexagon to set it as the new origin
          </div>
          {notOriginMsg && (
            <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 4, padding: '6px 10px', background: 'rgba(245,158,11,0.1)', borderRadius: 6 }}>
              {notOriginMsg}
            </div>
          )}
        </>
      )}
    </div>
  );
}
