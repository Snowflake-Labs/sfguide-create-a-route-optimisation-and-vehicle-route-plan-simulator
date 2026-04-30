import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TileLayer, H3HexagonLayer } from '@deck.gl/geo-layers';
import type { MatrixInventoryItem, ReachabilityData } from '../types';
import { RES_LABELS } from '../types';

const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';

function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap',
    data: CARTO_LIGHT,
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

const COLORS: [number, number, number][] = [
  [103, 0, 161],
  [137, 8, 165],
  [170, 30, 149],
  [199, 55, 118],
  [221, 85, 83],
  [237, 121, 47],
  [245, 160, 12],
];

export default function MatrixViewer() {
  const [inventory, setInventory] = useState<MatrixInventoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');
  const [destinations, setDestinations] = useState<ReachabilityData[]>([]);
  const [allHexes, setAllHexes] = useState<string[]>([]);
  const [originHex, setOriginHex] = useState('');
  const [originLat, setOriginLat] = useState(0);
  const [originLon, setOriginLon] = useState(0);
  const [globalMaxTime, setGlobalMaxTime] = useState(0);
  const [driveTimeLimit, setDriveTimeLimit] = useState(60);
  const [sliderMax, setSliderMax] = useState(60);
  const [activeTable, setActiveTable] = useState('');
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 10, pitch: 0, bearing: 0 });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hasLoadedOnce = useRef(false);

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
    if (regions.length > 0 && !selRegion) {
      const sf = regions.find(r => r.toUpperCase() === 'SANFRANCISCO');
      setSelRegion(sf || regions[0]);
    }
  }, [regions]);

  const prevRegionRef = useRef(selRegion);
  useEffect(() => {
    if (selRegion && selRegion !== prevRegionRef.current) {
      prevRegionRef.current = selRegion;
      hasLoadedOnce.current = false;
    }
  }, [selRegion]);

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

  const parseDestinations = (data: any): ReachabilityData[] =>
    (data.destinations || []).map((r: any) => ({
      hex_id: r.HEX_ID,
      travel_time_secs: Number(r.TRAVEL_TIME_SECONDS || 0),
      distance_meters: Number(r.TRAVEL_DISTANCE_METERS || 0),
    }));

  const loadRandomOrigin = useCallback(async (table: MatrixInventoryItem) => {
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
      setGlobalMaxTime(gMax);
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
      if (!hasLoadedOnce.current) {
        setViewState(prev => ({
          ...prev,
          longitude: originData.origin_lon,
          latitude: originData.origin_lat,
          zoom: 11,
        }));
        hasLoadedOnce.current = true;
      }
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
      setNotOriginMsg(`${hexId} is a destination only — no origin data available. Click a gray hexagon instead.`);
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
      getHexagon: (d: ReachabilityData) => d.hex_id,
      getFillColor: (d: ReachabilityData) => {
        const bucket = Math.floor(d.travel_time_secs / 300);
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
    const maxSecs = destinations.reduce((m, d) => Math.max(m, d.travel_time_secs), 0);
    return Math.ceil(maxSecs / 60);
  }, [destinations]);

  return (
    <div className="panel">
      <h2>Travel Time Matrix Viewer</h2>
      <p className="subtitle">Explore pre-computed travel time matrices with interactive H3 hexagonal visualization</p>

      {inventory.length === 0 && (
        <div className="empty-state">No travel time matrices found. Use the Matrix Builder tab to build one first.</div>
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
                {resolutions.map(r => <option key={r} value={r}>{r} — {RES_LABELS[parseInt(r.replace('RES', ''))] || ''}</option>)}
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
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)' }}>
              {COLORS.map((_, i) => <span key={i}>{i * 5}m</span>)}
              <span>{COLORS.length * 5}m+</span>
            </div>
          </div>

          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>{loadingMsg}</div>}
            <DeckGL
              viewState={viewState}
              onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
              controller={true}
              layers={layers}
              onClick={handleHexClick}
              getTooltip={getTooltip}
              style={{ width: '100%', height: '100%' }}
            />
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
