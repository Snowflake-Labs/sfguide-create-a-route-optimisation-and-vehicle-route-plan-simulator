import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TileLayer, H3HexagonLayer } from '@deck.gl/geo-layers';
import type { ReachabilityData } from '../types';

const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';
const SF_VIEW = { longitude: -122.44, latitude: 37.76, zoom: 12, pitch: 0, bearing: 0 };
const TARGET_REGION = 'SanFrancisco';
const TARGET_PROFILE = 'cycling-electric';
const RESOLUTIONS = [7, 8, 9];
const INTRO_DB = 'OPENROUTESERVICE_SETUP';
const INTRO_SCHEMA = 'PUBLIC';

const COLORS: [number, number, number][] = [
  [103, 0, 161],
  [137, 8, 165],
  [170, 30, 149],
  [199, 55, 118],
  [221, 85, 83],
  [237, 121, 47],
  [245, 160, 12],
];

type Mode = 'idle' | 'origin_set' | 'route_shown' | 'reachability';

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

function parseDestinations(data: any): ReachabilityData[] {
  return (data.destinations || []).map((r: any) => ({
    hex_id: r.HEX_ID,
    lat: Number(r.LAT),
    lon: Number(r.LON),
    travel_time_secs: Number(r.TRAVEL_TIME_SECONDS || 0),
    distance_meters: Number(r.TRAVEL_DISTANCE_METERS || 0),
    ring: Number(r.RING || 0),
  }));
}

export default function Intro() {
  const [viewState, setViewState] = useState(SF_VIEW);
  const [loading, setLoading] = useState(true);
  const [loadingMsg, setLoadingMsg] = useState('Loading...');

  const [showGrid, setShowGrid] = useState(true);
  const [showTrips, setShowTrips] = useState(true);
  const [showPings, setShowPings] = useState(false);
  const [tripCount, setTripCount] = useState(100);

  const [resolution, setResolution] = useState(7);
  const [hexData, setHexData] = useState<any[]>([]);
  const [trips, setTrips] = useState<any[]>([]);
  const [hexLoading, setHexLoading] = useState(true);
  const [tripsLoading, setTripsLoading] = useState(true);

  const [dataAvailable, setDataAvailable] = useState(false);
  const [tableName, setTableName] = useState('');
  const [inventoryTables, setInventoryTables] = useState<any[]>([]);
  const [allHexes, setAllHexes] = useState<string[]>([]);
  const [destinations, setDestinations] = useState<ReachabilityData[]>([]);
  const [cachedDests, setCachedDests] = useState<ReachabilityData[]>([]);
  const [originHex, setOriginHex] = useState('');
  const [originLat, setOriginLat] = useState(0);
  const [originLon, setOriginLon] = useState(0);

  const [mode, setMode] = useState<Mode>('idle');
  const [targetHex, setTargetHex] = useState('');
  const [targetLat, setTargetLat] = useState(0);
  const [targetLon, setTargetLon] = useState(0);
  const [routeTime, setRouteTime] = useState(0);
  const [routeDist, setRouteDist] = useState(0);

  const abortRef = useRef<AbortController | null>(null);

  const originSet = useMemo(() => new Set(allHexes), [allHexes]);

  const fetchReachability = useCallback(async (table: string, origin: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const tbl = encodeURIComponent(table);
    const res = await fetch(`/api/matrix/reachability?table=${tbl}&origin=${origin}`, { signal: ctrl.signal });
    return res.json();
  }, []);

  const resetMode = useCallback(() => {
    setMode('idle');
    setOriginHex('');
    setOriginLat(0);
    setOriginLon(0);
    setDestinations([]);
    setCachedDests([]);
    setTargetHex('');
    setTargetLat(0);
    setTargetLon(0);
    setRouteTime(0);
    setRouteDist(0);
  }, []);

  useEffect(() => {
    async function loadInventory() {
      try {
        const invRes = await fetch('/api/matrix/viewer-inventory');
        const invData = await invRes.json();
        setInventoryTables(invData.tables || []);
      } catch {
        setInventoryTables([]);
      }
    }
    loadInventory();
  }, []);

  useEffect(() => {
    async function loadTrips() {
      try {
        const res2 = await fetch('/api/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sql: `SELECT TRIP_ID, O_LNG, O_LAT, D_LNG, D_LAT, ROUND(DISTANCE_M, 0) AS DISTANCE_M, ROUND(DURATION_S, 0) AS DURATION_S, ROUTE_GEOJSON::STRING AS ROUTE_GEOJSON FROM INTRO_TRIPS ORDER BY TRIP_ID`,
            database: INTRO_DB,
            schema: INTRO_SCHEMA,
          }),
        });
        const b2 = await res2.json();
        const r2 = Array.isArray(b2) ? b2 : (b2.result ?? []);
        setTrips(Array.isArray(r2) ? r2 : []);
      } catch {
        setTrips([]);
      }
      setTripsLoading(false);
    }
    loadTrips();
  }, []);

  useEffect(() => {
    async function loadHexes() {
      resetMode();
      setHexLoading(true);
      setLoading(true);
      setLoadingMsg('Loading hexagons...');

      const resTag = `RES${resolution}`;
      const match = inventoryTables.find((t: any) =>
        t.region === TARGET_REGION && t.profile === TARGET_PROFILE && t.resolution === resTag
      );

      if (match) {
        setTableName(match.table_name);
        setDataAvailable(true);
        try {
          const tbl = encodeURIComponent(match.table_name);
          const hexesRes = await fetch(`/api/matrix/all-hexes?table=${tbl}`);
          const hexesData = await hexesRes.json();
          setAllHexes(hexesData.hexes || []);
          setHexData((hexesData.hexes || []).map((h: string) => ({ H3_INDEX: h })));
        } catch {
          setAllHexes([]);
          setHexData([]);
        }
      } else {
        setTableName('');
        setDataAvailable(false);
        try {
          const res1 = await fetch('/api/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sql: `SELECT VALUE::STRING AS H3_INDEX FROM TABLE(FLATTEN(H3_COVERAGE_STRINGS(TO_GEOGRAPHY('POLYGON((-122.520 37.700, -122.350 37.700, -122.350 37.820, -122.520 37.820, -122.520 37.700))'), ${resolution})))`,
              database: INTRO_DB,
              schema: INTRO_SCHEMA,
            }),
          });
          const b1 = await res1.json();
          const r1 = Array.isArray(b1) ? b1 : (b1.result ?? []);
          setHexData(Array.isArray(r1) ? r1 : []);
          setAllHexes([]);
        } catch {
          setHexData([]);
          setAllHexes([]);
        }
      }
      setHexLoading(false);
      setLoading(false);
      setLoadingMsg('');
    }
    if (inventoryTables.length > 0) {
      loadHexes();
    }
  }, [resolution, inventoryTables, resetMode]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') resetMode();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [resetMode]);

  const handleClick = useCallback(async (info: any) => {
    const hexId = info?.object?.hex_id || info?.object?.H3_INDEX;
    console.log('[click]', { hexId, dataAvailable, tableName, mode, originSetSize: originSet.size, obj: info?.object });
    if (!hexId || !dataAvailable || !tableName) return;
    if (!originSet.has(hexId)) return;

    if (mode === 'idle') {
      setOriginHex(hexId);
      setMode('origin_set');
      setLoading(true);
      setLoadingMsg('Loading reachability...');
      try {
        const reachData = await fetchReachability(tableName, hexId);
        const dests = parseDestinations(reachData);
        setOriginLat(Number(reachData.origin_lat || 0));
        setOriginLon(Number(reachData.origin_lon || 0));
        setCachedDests(dests);
        setDestinations([]);
      } catch (e: any) {
        if (e.name !== 'AbortError') {}
      } finally {
        setLoading(false);
        setLoadingMsg('');
      }
      return;
    }

    if (mode === 'origin_set') {
      if (hexId === originHex) {
        resetMode();
        return;
      }
      const found = cachedDests.find(d => d.hex_id === hexId);
      if (found) {
        setTargetHex(hexId);
        setTargetLat(found.lat);
        setTargetLon(found.lon);
        setRouteTime(found.travel_time_secs);
        setRouteDist(found.distance_meters);
        setMode('route_shown');
      }
      return;
    }

    if (mode === 'route_shown') {
      setTargetHex('');
      setLoading(true);
      setLoadingMsg('Loading reachability...');
      try {
        const reachData = await fetchReachability(tableName, hexId);
        const dests = parseDestinations(reachData);
        setOriginHex(hexId);
        setOriginLat(Number(reachData.origin_lat || 0));
        setOriginLon(Number(reachData.origin_lon || 0));
        setDestinations(dests);
        setCachedDests(dests);
        setMode('reachability');
      } catch (e: any) {
        if (e.name !== 'AbortError') {}
      } finally {
        setLoading(false);
        setLoadingMsg('');
      }
      return;
    }

    if (mode === 'reachability') {
      setLoading(true);
      setLoadingMsg('Loading reachability...');
      try {
        const reachData = await fetchReachability(tableName, hexId);
        const dests = parseDestinations(reachData);
        setOriginHex(hexId);
        setOriginLat(Number(reachData.origin_lat || 0));
        setOriginLon(Number(reachData.origin_lon || 0));
        setDestinations(dests);
        setCachedDests(dests);
      } catch (e: any) {
        if (e.name !== 'AbortError') {}
      } finally {
        setLoading(false);
        setLoadingMsg('');
      }
    }
  }, [dataAvailable, tableName, mode, originHex, cachedDests, originSet, fetchReachability, resetMode]);

  const isFullLoading = hexLoading || tripsLoading;
  const basemap = useMemo(() => cartoBasemap(), []);

  const visibleTrips = useMemo(() => trips.slice(0, tripCount), [trips, tripCount]);
  const maxDist = useMemo(() => Math.max(1, ...trips.map((t: any) => Number(t.DISTANCE_M || 0))), [trips]);

  const reachSet = useMemo(() => new Set(destinations.map(d => d.hex_id)), [destinations]);

  const hexLayer = useMemo(() => {
    if (!showGrid || !hexData.length) return null;
    if (dataAvailable && allHexes.length > 0) {
      const bgData = allHexes
        .filter(h => !reachSet.has(h) && h !== originHex && h !== targetHex)
        .map(h => ({ hex_id: h }));
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
        updateTriggers: { data: [reachSet, originHex, targetHex] },
      });
    }
    const valid = hexData.filter((d: any) => d.H3_INDEX && typeof d.H3_INDEX === 'string' && d.H3_INDEX.length >= 15);
    if (!valid.length) return null;
    return new H3HexagonLayer({
      id: 'sf-h3-grid',
      data: valid,
      pickable: false,
      filled: true,
      extruded: false,
      getHexagon: (d: any) => d.H3_INDEX,
      getFillColor: [160, 160, 175, 40] as [number, number, number, number],
      getLineColor: [120, 120, 140, 160] as [number, number, number, number],
      getLineWidth: 2,
      lineWidthMinPixels: 2,
      stroked: true,
      opacity: 0.6,
    });
  }, [hexData, showGrid, dataAvailable, allHexes, reachSet, originHex, targetHex]);

  const originHexLayer = useMemo(() => {
    if (!originHex || !showGrid || mode === 'idle') return null;
    return new H3HexagonLayer({
      id: 'origin-hex-highlight',
      data: [{ hex_id: originHex }],
      pickable: true,
      filled: true,
      extruded: false,
      getHexagon: (d: any) => d.hex_id,
      getFillColor: [41, 181, 232, 200] as [number, number, number, number],
      opacity: 0.9,
    });
  }, [originHex, showGrid, mode]);

  const targetHexLayer = useMemo(() => {
    if (!targetHex || !showGrid || mode !== 'route_shown') return null;
    return new H3HexagonLayer({
      id: 'target-hex-highlight',
      data: [{ hex_id: targetHex }],
      pickable: true,
      filled: true,
      extruded: false,
      getHexagon: (d: any) => d.hex_id,
      getFillColor: [34, 197, 94, 200] as [number, number, number, number],
      opacity: 0.9,
    });
  }, [targetHex, showGrid, mode]);

  const reachLayer = useMemo(() => {
    if (!dataAvailable || destinations.length === 0 || !showGrid || mode !== 'reachability') return null;
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
  }, [dataAvailable, destinations, showGrid, mode]);

  const reachOriginMarker = useMemo(() => {
    if (!originHex || !dataAvailable || !showGrid || mode !== 'reachability') return null;
    return new ScatterplotLayer({
      id: 'reach-origin-marker',
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
  }, [originHex, originLat, originLon, dataAvailable, showGrid, mode]);

  const tripLayer = useMemo(() => {
    if (!showTrips || !visibleTrips.length) return null;
    const parsed = visibleTrips
      .map((t: any) => {
        try {
          const gj = JSON.parse(t.ROUTE_GEOJSON);
          const coords = gj?.coordinates || gj;
          if (!Array.isArray(coords) || coords.length < 2) return null;
          return { ...t, path: coords.map((c: number[]) => [Number(c[0]), Number(c[1])]) };
        } catch { return null; }
      })
      .filter(Boolean);
    return new PathLayer({
      id: 'intro-trips',
      data: parsed,
      pickable: true,
      getPath: (d: any) => d.path,
      getColor: (d: any) => {
        const t = Math.min(Number(d.DISTANCE_M) / maxDist, 1);
        const idx = Math.min(Math.floor(t * COLORS.length), COLORS.length - 1);
        return [...COLORS[idx], 180] as [number, number, number, number];
      },
      getWidth: 2,
      widthMinPixels: 1,
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getColor: [maxDist] },
    });
  }, [visibleTrips, showTrips, maxDist]);

  const tripOriginLayer = useMemo(() => {
    if (!showTrips || !visibleTrips.length) return null;
    const parsed = visibleTrips.filter((t: any) => t.O_LNG && t.O_LAT);
    return new ScatterplotLayer({
      id: 'trip-origins',
      data: parsed,
      pickable: false,
      getPosition: (d: any) => [Number(d.O_LNG), Number(d.O_LAT)],
      getFillColor: [255, 255, 255, 220],
      getLineColor: [41, 181, 232, 255],
      getRadius: 40,
      radiusMinPixels: 3,
      stroked: true,
      lineWidthMinPixels: 1,
    });
  }, [visibleTrips, showTrips]);

  const tripDestLayer = useMemo(() => {
    if (!showTrips || !visibleTrips.length) return null;
    const parsed = visibleTrips.filter((t: any) => t.D_LNG && t.D_LAT);
    return new ScatterplotLayer({
      id: 'trip-destinations',
      data: parsed,
      pickable: false,
      getPosition: (d: any) => [Number(d.D_LNG), Number(d.D_LAT)],
      getFillColor: [255, 255, 255, 220],
      getLineColor: [34, 197, 94, 255],
      getRadius: 40,
      radiusMinPixels: 3,
      stroked: true,
      lineWidthMinPixels: 1,
    });
  }, [visibleTrips, showTrips]);

  const gpsPingsLayer = useMemo(() => {
    if (!showPings || !visibleTrips.length) return null;
    const points: { pos: [number, number]; tripId: number; dist: number }[] = [];
    for (const t of visibleTrips) {
      try {
        const gj = JSON.parse((t as any).ROUTE_GEOJSON);
        const coords = gj?.coordinates || gj;
        if (!Array.isArray(coords)) continue;
        for (const c of coords) {
          points.push({ pos: [Number(c[0]), Number(c[1])], tripId: Number((t as any).TRIP_ID), dist: Number((t as any).DISTANCE_M || 0) });
        }
      } catch { /* skip */ }
    }
    return new ScatterplotLayer({
      id: 'gps-pings',
      data: points,
      pickable: false,
      getPosition: (d: any) => d.pos,
      getFillColor: (d: any) => {
        const norm = Math.min(d.dist / maxDist, 1);
        const idx = Math.min(Math.floor(norm * COLORS.length), COLORS.length - 1);
        return [...COLORS[idx], 200] as [number, number, number, number];
      },
      getRadius: 8,
      radiusMinPixels: 1.5,
      radiusMaxPixels: 6,
      updateTriggers: { getFillColor: [maxDist] },
    });
  }, [visibleTrips, showPings, maxDist]);

  const layers = useMemo(
    () => [basemap, tripLayer, tripOriginLayer, tripDestLayer, gpsPingsLayer, hexLayer, reachLayer, originHexLayer, targetHexLayer, reachOriginMarker].filter(Boolean),
    [basemap, tripLayer, tripOriginLayer, tripDestLayer, gpsPingsLayer, hexLayer, reachLayer, originHexLayer, targetHexLayer, reachOriginMarker]
  );

  const getTooltip = useCallback(({ object }: any) => {
    if (!object) return null;
    if (object.TRIP_ID) {
      return {
        html: `<b>Trip ${object.TRIP_ID}</b><br/>Distance: ${(Number(object.DISTANCE_M) / 1000).toFixed(1)} km<br/>Duration: ${(Number(object.DURATION_S) / 60).toFixed(1)} min`,
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
    if (object.travel_time_secs !== undefined) {
      return {
        html: `<b>${object.hex_id}</b><br/>Travel time: ${(object.travel_time_secs / 60).toFixed(1)} min<br/>Distance: ${(object.distance_meters / 1000).toFixed(1)} km`,
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
    if (object.hex_id) {
      const hint = mode === 'idle'
        ? 'Click to select as origin'
        : mode === 'origin_set'
          ? 'Click to select as destination'
          : mode === 'route_shown'
            ? 'Click to show reachability'
            : 'Click for new reachability';
      return {
        html: `<b>${object.hex_id}</b><br/><i>${hint}</i>`,
        style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
      };
    }
    return null;
  }, [mode]);

  const modeHint = mode === 'idle'
    ? 'Click a hex to select origin'
    : mode === 'origin_set'
      ? 'Click another hex to select destination · Click origin to deselect · Esc to reset'
      : mode === 'route_shown'
        ? 'Click any hex to show full reachability · Esc to reset'
        : 'Click another hex for new reachability · Esc to reset';

  const maxDistKm = (maxDist / 1000).toFixed(0);
  const n = tripCount;
  const pingsMin = n * 2;
  const pingsHour = pingsMin * 60;
  const pingsDay = pingsHour * 8;
  const pingsMonth = pingsDay * 30;
  const fmt = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}K` : String(v);
  const cost = (v: number) => `$${Math.round(v / 1000)}`;

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: '0 0 8px 0' }}>Intro</h2>
          <div style={{ display: 'flex', gap: 16 }}>
            <label className="check-label">
              <input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} /> H3 Grid
            </label>
            <label className="check-label">
              <input type="checkbox" checked={showTrips} onChange={e => setShowTrips(e.target.checked)} /> Trips
            </label>
            <label className="check-label">
              <input type="checkbox" checked={showPings} onChange={e => setShowPings(e.target.checked)} /> GPS Pings
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          {mode !== 'idle' && (
            <button
              onClick={resetMode}
              style={{
                padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer', fontSize: 12,
              }}
            >
              Reset
            </button>
          )}
          <div style={{ background: 'var(--surface, #1e1e2e)', border: '1px solid var(--border, #333)', borderRadius: 8, padding: '10px 14px', fontSize: 12, lineHeight: 1.8, minWidth: 220, color: 'var(--text-secondary, #aaa)' }}>
            <div><strong style={{ color: '#ef4444' }}>{fmt(n)}</strong> Vehicles</div>
            <div><strong style={{ color: '#ef4444' }}>{fmt(pingsMin)}</strong> GPS pings / minute</div>
            <div><strong style={{ color: '#ef4444' }}>{fmt(pingsHour)}</strong> GPS pings / hour</div>
            <div><strong style={{ color: '#ef4444' }}>{fmt(pingsDay)}</strong> GPS pings / day <span style={{ color: '#22c55e' }}>({cost(pingsDay)} routing cost)</span></div>
            <div><strong style={{ color: '#ef4444' }}>{fmt(pingsMonth)}</strong> GPS pings / month <span style={{ color: '#22c55e' }}>({cost(pingsMonth)} routing cost)</span></div>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          H3 Hexagon Resolution: <strong>{resolution}</strong>
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>7</span>
          <input
            type="range" min={7} max={9} step={1}
            value={resolution}
            onChange={e => setResolution(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>9</span>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          Number of trips: <strong>{tripCount}</strong>
        </label>
        <input
          type="range" min={1} max={500}
          value={tripCount}
          onChange={e => setTripCount(Number(e.target.value))}
          style={{ width: '100%' }}
        />
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 0, height: 8, borderRadius: 4, overflow: 'hidden' }}>
            {COLORS.map((c, i) => (
              <div key={i} style={{ flex: 1, background: `rgb(${c.join(',')})` }} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-secondary)' }}>
            <span>0 km</span>
            <span>{(Number(maxDistKm) / 2).toFixed(0)} km</span>
            <span>{maxDistKm} km</span>
          </div>
        </div>
      </div>

      {dataAvailable && showGrid && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          {modeHint}
          {mode === 'origin_set' && (
            <span> · Origin: <strong style={{ color: '#29b5e8' }}>{originHex}</strong></span>
          )}
          {mode === 'route_shown' && (
            <span> · <span style={{ color: '#29b5e8' }}>Origin: {originHex}</span> · <span style={{ color: '#22c55e' }}>Dest: {targetHex}</span></span>
          )}
          {mode === 'reachability' && destinations.length > 0 && (
            <span> · Origin: <strong>{originHex}</strong> · {destinations.length.toLocaleString()} reachable</span>
          )}
        </div>
      )}

      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {(loading || isFullLoading) && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>
            {loadingMsg || 'Loading...'}
          </div>
        )}
        <DeckGL
          viewState={viewState}
          onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
          controller={{ doubleClickZoom: false }}
          layers={layers}
          onClick={handleClick}
          getTooltip={getTooltip}
          style={{ width: '100%', height: '100%' }}
        />
        {mode === 'route_shown' && targetHex && (
          <div style={{
            position: 'absolute', top: 16, right: 16,
            background: 'rgba(20,20,31,0.92)', color: '#e8e8f0',
            padding: '14px 18px', borderRadius: 10, fontSize: 13,
            zIndex: 20, minWidth: 220, lineHeight: 1.8,
            border: '1px solid rgba(255,255,255,0.1)',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>Point-to-Point Route</div>
            <div>
              <span style={{ color: '#29b5e8' }}>Origin:</span>{' '}
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{originHex}</span>
            </div>
            <div>
              <span style={{ color: '#22c55e' }}>Destination:</span>{' '}
              <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{targetHex}</span>
            </div>
            <div style={{ marginTop: 6, borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: 6 }}>
              <div>Travel time: <strong>{(routeTime / 60).toFixed(1)} min</strong></div>
              <div>Distance: <strong>{(routeDist / 1000).toFixed(1)} km</strong></div>
            </div>
            <button
              onClick={resetMode}
              style={{
                marginTop: 8, padding: '4px 12px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.2)',
                background: 'transparent', color: '#e8e8f0', cursor: 'pointer', fontSize: 11,
              }}
            >
              Reset
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
