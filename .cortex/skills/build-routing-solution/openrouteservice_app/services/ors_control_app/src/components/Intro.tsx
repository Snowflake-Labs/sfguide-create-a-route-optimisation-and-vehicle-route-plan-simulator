import { useState, useEffect, useMemo, useCallback } from 'react';
import DeckGL from '@deck.gl/react';
import { PathLayer, BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TileLayer, H3HexagonLayer } from '@deck.gl/geo-layers';

const CARTO_LIGHT = '/api/tiles/{z}/{x}/{y}';
const SF_VIEW = { longitude: -122.44, latitude: 37.76, zoom: 12, pitch: 0, bearing: 0 };
const INTRO_DB = 'OPENROUTESERVICE_APP';
const INTRO_SCHEMA = 'CORE';

const COLORS: [number, number, number][] = [
  [103, 0, 161],
  [137, 8, 165],
  [170, 30, 149],
  [199, 55, 118],
  [221, 85, 83],
  [237, 121, 47],
  [245, 160, 12],
];

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

export default function Intro() {
  const [showGrid, setShowGrid] = useState(true);
  const [showTrips, setShowTrips] = useState(true);
  const [showPings, setShowPings] = useState(false);
  const [tripCount, setTripCount] = useState(100);
  const [viewState, setViewState] = useState(SF_VIEW);
  const [resolution, setResolution] = useState(7);

  const [hexData, setHexData] = useState<any[]>([]);
  const [trips, setTrips] = useState<any[]>([]);
  const [hexLoading, setHexLoading] = useState(true);
  const [tripsLoading, setTripsLoading] = useState(true);

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
      setHexLoading(true);
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
      } catch {
        setHexData([]);
      }
      setHexLoading(false);
    }
    loadHexes();
  }, [resolution]);

  const loading = hexLoading || tripsLoading;
  const basemap = useMemo(() => cartoBasemap(), []);

  const visibleTrips = useMemo(() => trips.slice(0, tripCount), [trips, tripCount]);
  const maxDist = useMemo(() => Math.max(1, ...trips.map((t: any) => Number(t.DISTANCE_M || 0))), [trips]);

  const hexLayer = useMemo(() => {
    if (!showGrid || !hexData.length) return null;
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
  }, [hexData, showGrid]);

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

  const originLayer = useMemo(() => {
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

  const destLayer = useMemo(() => {
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
    () => [basemap, hexLayer, gpsPingsLayer, tripLayer, originLayer, destLayer].filter(Boolean),
    [basemap, hexLayer, gpsPingsLayer, tripLayer, originLayer, destLayer]
  );

  const getTooltip = useCallback(({ object }: any) => {
    if (!object?.TRIP_ID) return null;
    return {
      html: `<b>Trip ${object.TRIP_ID}</b><br/>Distance: ${(Number(object.DISTANCE_M) / 1000).toFixed(1)} km<br/>Duration: ${(Number(object.DURATION_S) / 60).toFixed(1)} min`,
      style: { backgroundColor: '#14141f', color: '#e8e8f0', padding: '8px', borderRadius: '4px', fontSize: '12px' },
    };
  }, []);

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
        <div style={{ background: 'var(--surface, #1e1e2e)', border: '1px solid var(--border, #333)', borderRadius: 8, padding: '10px 14px', fontSize: 12, lineHeight: 1.8, minWidth: 220, color: 'var(--text-secondary, #aaa)' }}>
          <div><strong style={{ color: '#ef4444' }}>{fmt(n)}</strong> Vehicles</div>
          <div><strong style={{ color: '#ef4444' }}>{fmt(pingsMin)}</strong> GPS pings / minute</div>
          <div><strong style={{ color: '#ef4444' }}>{fmt(pingsHour)}</strong> GPS pings / hour</div>
          <div><strong style={{ color: '#ef4444' }}>{fmt(pingsDay)}</strong> GPS pings / day <span style={{ color: '#22c55e' }}>({cost(pingsDay)} routing cost)</span></div>
          <div><strong style={{ color: '#ef4444' }}>{fmt(pingsMonth)}</strong> GPS pings / month <span style={{ color: '#22c55e' }}>({cost(pingsMonth)} routing cost)</span></div>
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

      <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
        {loading && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', zIndex: 10, fontSize: 14 }}>Loading...</div>}
        <DeckGL
          viewState={viewState}
          onViewStateChange={({ viewState: vs }: any) => setViewState(vs)}
          controller={true}
          layers={layers}
          getTooltip={getTooltip}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
}
