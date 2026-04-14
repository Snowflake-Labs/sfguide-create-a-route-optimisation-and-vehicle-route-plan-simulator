import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

function cartoBasemap() {
  return new TileLayer({ id: 'carto-basemap', data: '/api/tiles/{z}/{x}/{y}', minZoom: 0, maxZoom: 19, tileSize: 256, renderSubLayers: (props: any) => { const { boundingBox } = props.tile; return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] }); } });
}

function decodePolyline(encoded: string): [number, number][] {
  if (typeof encoded !== 'string') return [];
  const coords: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  try {
    while (index < encoded.length) {
      let b, shift = 0, result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lng / 1e5, lat / 1e5]);
    }
  } catch {}
  return coords;
}

interface MarkerPoint { position: [number, number]; color: [number, number, number, number]; label: string; }
interface GeoData { geojson: any | null; points: MarkerPoint[]; center: [number, number] | null; zoom: number; }

function extractAgentGeoData(toolResults: any[]): GeoData {
  const features: any[] = [];
  const markerPoints: MarkerPoint[] = [];

  for (const tr of toolResults) {
    if (!tr || typeof tr !== 'object' || tr.status === 'FAILED') continue;
    try {
      // TOOL_DIRECTIONS / TOOL_ISOCHRONE: tr.geometry is a raw GeoJSON geometry object
      if (tr.geometry && typeof tr.geometry === 'object' && tr.geometry.type) {
        const geomType = tr.geometry.type;
        if (geomType === 'LineString' || geomType === 'MultiLineString') {
          features.push({ type: 'Feature', geometry: tr.geometry, properties: { distance: tr.distance_km, duration: tr.duration_mins } });
        } else if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
          features.push({ type: 'Feature', geometry: tr.geometry, properties: { area: tr.area_km2, range: tr.range_minutes } });
        } else if (geomType === 'Feature') {
          features.push(tr.geometry);
        } else if (geomType === 'FeatureCollection') {
          features.push(...(tr.geometry.features || []));
        }
      }
      // TOOL_OPTIMIZATION: routes array with encoded polyline geometry
      if (tr.routes && Array.isArray(tr.routes)) {
        for (const route of tr.routes) {
          if (route.geometry && typeof route.geometry === 'string') {
            const coords = decodePolyline(route.geometry);
            if (coords.length > 0) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
          }
        }
      }
      // Isochrone center point
      if (tr.center && tr.center.longitude != null && tr.center.latitude != null) {
        markerPoints.push({ position: [tr.center.longitude, tr.center.latitude], color: [245, 158, 11, 255], label: tr.center.name || 'Center' });
      }
      // Optimization depot point
      if (tr.depot && tr.depot.longitude != null && tr.depot.latitude != null) {
        markerPoints.push({ position: [tr.depot.longitude, tr.depot.latitude], color: [245, 158, 11, 255], label: tr.depot.name || 'Depot' });
      }
    } catch {}
  }

  const allCoords: [number, number][] = [...markerPoints.map(p => p.position)];
  for (const f of features) {
    const geom = f.geometry;
    if (!geom) continue;
    if (geom.type === 'Point') allCoords.push(geom.coordinates);
    else if (geom.type === 'LineString') allCoords.push(...geom.coordinates);
    else if (geom.type === 'MultiLineString') geom.coordinates.forEach((l: any) => allCoords.push(...l));
    else if (geom.type === 'Polygon') allCoords.push(...geom.coordinates[0]);
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => allCoords.push(...p[0]));
  }

  if (features.length === 0 && markerPoints.length === 0) return { geojson: null, points: markerPoints, center: null, zoom: 12 };

  let center: [number, number] | null = null;
  let zoom = 12;
  if (allCoords.length > 0) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of allCoords) {
      if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    }
    center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
    const span = Math.max(maxLon - minLon, maxLat - minLat);
    if (span > 1) zoom = 8; else if (span > 0.5) zoom = 9; else if (span > 0.1) zoom = 11; else if (span > 0.02) zoom = 13; else zoom = 14;
  }

  return { geojson: features.length > 0 ? { type: 'FeatureCollection', features } : null, points: markerPoints, center, zoom };
}

interface ChatMsg { role: 'user' | 'assistant'; content: string; toolResults?: any[]; }

const EMPTY_GEO: GeoData = { geojson: null, points: [], center: null, zoom: 12 };

export default function AgentPlayground() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [geoData, setGeoData] = useState<GeoData>(EMPTY_GEO);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return;
    const userMsg: ChatMsg = { role: 'user', content: input.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg.content, history: messages }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      let assistantContent = '';
      const toolResults: any[] = [];
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (reader) {
        let done = false;
        let buffer = '';
        while (!done) {
          const { value, done: d } = await reader.read();
          done = d;
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() || '';
            for (const block of blocks) {
              let eventType = '';
              let dataStr = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('event: ')) eventType = line.slice(7).trim();
                else if (line.startsWith('data: ')) dataStr = line.slice(6);
              }
              if (!dataStr) continue;
              try {
                const parsed = JSON.parse(dataStr);
                if (eventType === 'result') {
                  assistantContent = parsed.message || '';
                  if (parsed.tool_results) toolResults.push(...parsed.tool_results);
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') { last.content = assistantContent; last.toolResults = toolResults; }
                    else updated.push({ role: 'assistant', content: assistantContent, toolResults });
                    return updated;
                  });
                } else if (eventType === 'progress') {
                  const stepLabels: Record<string, string> = { calling_llm: 'Thinking...', executing_tool: 'Running tool', formatting: 'Processing' };
                  const label = stepLabels[parsed.step] || parsed.step || '';
                  const progressText = parsed.detail && !parsed.detail.startsWith('Iteration') ? `${label} ${parsed.detail}`.trim() : label || 'Thinking...';
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') last.content = progressText;
                    else updated.push({ role: 'assistant', content: progressText });
                    return updated;
                  });
                } else if (eventType === 'error') {
                  assistantContent = `Error: ${parsed.error || 'Unknown error'}`;
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') last.content = assistantContent;
                    else updated.push({ role: 'assistant', content: assistantContent });
                    return updated;
                  });
                }
              } catch {}
            }
          }
        }
      }

      if (toolResults.length) {
        const geo = extractAgentGeoData(toolResults);
        setGeoData(geo);
        if (geo.center) setViewState(prev => ({ ...prev, longitude: geo.center![0], latitude: geo.center![1], zoom: geo.zoom }));
      }

      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === 'assistant') last.toolResults = toolResults;
        return updated;
      });
    } catch (err: any) {
      const errMsg = err.name === 'AbortError' ? 'Request timed out. The agent may be taking too long.' : `Error: ${err.message}`;
      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === 'assistant') last.content = errMsg;
        else updated.push({ role: 'assistant', content: errMsg });
        return updated;
      });
    }
    setStreaming(false);
  }, [input, streaming, messages]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const geojsonLayer = useMemo(() => {
    if (!geoData.geojson) return null;
    return new GeoJsonLayer({
      id: 'agent-geojson',
      data: geoData.geojson,
      pickable: true,
      stroked: true,
      filled: true,
      lineWidthMinPixels: 3,
      getLineColor: [41, 181, 232, 220] as [number, number, number, number],
      getFillColor: [41, 181, 232, 50] as [number, number, number, number],
      getLineWidth: 3,
      pointRadiusMinPixels: 6,
      getPointRadius: 80,
      pointType: 'circle',
    });
  }, [geoData.geojson]);

  const startEndLayer = useMemo(() => {
    if (!geoData.geojson) return null;
    const markers: MarkerPoint[] = [];
    for (const f of geoData.geojson.features) {
      const geom = f.geometry;
      if (geom?.type === 'LineString' && geom.coordinates.length > 1) {
        markers.push({ position: geom.coordinates[0], color: [48, 209, 88, 255], label: 'Start' });
        markers.push({ position: geom.coordinates[geom.coordinates.length - 1], color: [255, 59, 48, 255], label: 'End' });
      }
    }
    if (markers.length === 0) return null;
    return new ScatterplotLayer({
      id: 'agent-start-end',
      data: markers,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: (d: any) => d.color,
      getLineColor: [255, 255, 255, 200] as [number, number, number, number],
      getRadius: 80,
      radiusMinPixels: 7,
      radiusMaxPixels: 12,
      stroked: true,
      lineWidthMinPixels: 2,
    });
  }, [geoData.geojson]);

  const pointsLayer = useMemo(() => {
    if (geoData.points.length === 0) return null;
    return new ScatterplotLayer({
      id: 'agent-points',
      data: geoData.points,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: (d: any) => d.color,
      getLineColor: [255, 255, 255, 200] as [number, number, number, number],
      getRadius: 80,
      radiusMinPixels: 6,
      radiusMaxPixels: 10,
      stroked: true,
      lineWidthMinPixels: 2,
    });
  }, [geoData.points]);

  const layers = useMemo(() => [basemap, geojsonLayer, startEndLayer, pointsLayer].filter(Boolean), [basemap, geojsonLayer, startEndLayer, pointsLayer]);

  const getTooltip = useCallback(({ object, layer }: any) => {
    if (!object) return null;
    if (layer?.id === 'agent-start-end' || layer?.id === 'agent-points') {
      return { text: object.label, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px' } };
    }
    if (layer?.id === 'agent-geojson' && object.properties) {
      const props = object.properties;
      const parts: string[] = [];
      if (props.distance != null) parts.push(`Distance: ${props.distance} km`);
      if (props.duration != null) parts.push(`Duration: ${props.duration} min`);
      if (props.range != null) parts.push(`Range: ${props.range} min`);
      if (props.area != null) parts.push(`Area: ${props.area} km\u00b2`);
      if (parts.length === 0) return null;
      return { text: parts.join('\n'), style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '6px 10px', borderRadius: '4px', whiteSpace: 'pre-line' } };
    }
    return null;
  }, []);

  return (
    <div className="panel">
      <h2 style={{ fontSize: 20, marginBottom: 4 }}>Agent Playground</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>Chat with the routing agent</p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 380px', display: 'flex', flexDirection: 'column', maxHeight: 600 }}>
          <div style={{ flex: 1, overflowY: 'auto', marginBottom: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 8, background: 'rgba(0,0,0,0.02)', minHeight: 200 }}>
            {messages.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16, textAlign: 'center' }}>Ask anything about routing, isochrones, or directions...</div>}
            {messages.map((m, i) => (
              <div key={i} style={{ marginBottom: 8, textAlign: m.role === 'user' ? 'right' : 'left' }}>
                <div style={{ display: 'inline-block', maxWidth: '90%', padding: '8px 12px', borderRadius: 8, background: m.role === 'user' ? 'var(--accent)' : 'rgba(0,0,0,0.04)', color: m.role === 'user' ? '#fff' : 'var(--text)', fontSize: 13, whiteSpace: 'pre-wrap' }}>{m.content || (streaming && m.role === 'assistant' ? '...' : '')}</div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="select" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && sendMessage()} placeholder="Type a message..." style={{ flex: 1 }} />
            <button className="btn-primary" onClick={sendMessage} disabled={streaming || !input.trim()}>{streaming ? '...' : 'Send'}</button>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 300 }}>
          <div style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
