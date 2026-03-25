import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PathLayer, GeoJsonLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

function cartoBasemap() {
  return new TileLayer({ id: 'carto-basemap', data: '/api/tiles/{z}/{x}/{y}', minZoom: 0, maxZoom: 19, tileSize: 256, renderSubLayers: (props: any) => { const { boundingBox } = props.tile; return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]] }); } });
}

function decodeGeometry(encoded: string, precision = 5): [number, number][] {
  const coords: [number, number][] = [];
  let idx = 0, lat = 0, lng = 0;
  const factor = Math.pow(10, precision);
  while (idx < encoded.length) {
    let b: number, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

interface MapLayer { type: string; data: any; color?: number[]; }

function extractLayers(toolResults: any[]): MapLayer[] {
  const layers: MapLayer[] = [];
  for (const tr of toolResults) {
    try {
      if (tr.geometry) {
        if (typeof tr.geometry === 'string') {
          const coords = decodeGeometry(tr.geometry);
          if (coords.length > 1) layers.push({ type: 'path', data: coords, color: [41, 181, 232] });
        } else if (tr.geometry.type === 'FeatureCollection' || tr.geometry.type === 'Feature' || tr.geometry.type === 'Polygon' || tr.geometry.type === 'MultiPolygon') {
          layers.push({ type: 'geojson', data: tr.geometry, color: [41, 181, 232] });
        }
      }
      if (tr.coordinates || tr.location) {
        const c = tr.coordinates || tr.location;
        if (Array.isArray(c) && c.length === 2) layers.push({ type: 'point', data: c, color: [245, 158, 11] });
      }
      if (tr.routes) {
        for (const route of tr.routes) {
          if (route.geometry) {
            const coords = typeof route.geometry === 'string' ? decodeGeometry(route.geometry) : [];
            if (coords.length > 1) layers.push({ type: 'path', data: coords, color: [34, 197, 94] });
          }
        }
      }
    } catch {}
  }
  return layers;
}

interface ChatMsg { role: 'user' | 'assistant'; content: string; toolResults?: any[]; }

export default function AgentPlayground() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [mapLayers, setMapLayers] = useState<MapLayer[]>([]);
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
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg.content, history: messages }),
      });

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
                  const progressText = parsed.detail || parsed.step || 'Thinking...';
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
        const newLayers = extractLayers(toolResults);
        setMapLayers(newLayers);
        const allPts = newLayers.flatMap(l => l.type === 'point' ? [l.data] : l.type === 'path' ? l.data : []);
        if (allPts.length) {
          const lngs = allPts.map(p => p[0]);
          const lats = allPts.map(p => p[1]);
          setViewState(prev => ({ ...prev, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitude: (Math.min(...lats) + Math.max(...lats)) / 2, zoom: 12 }));
        }
      }

      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === 'assistant') last.toolResults = toolResults;
        return updated;
      });
    } catch (err: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    }
    setStreaming(false);
  }, [input, streaming, messages]);

  const basemap = useMemo(() => cartoBasemap(), []);

  const deckLayers = useMemo(() => {
    const result: any[] = [];
    mapLayers.forEach((ml, i) => {
      const c = ml.color || [41, 181, 232];
      if (ml.type === 'geojson') result.push(new GeoJsonLayer({ id: `geo-${i}`, data: ml.data, filled: true, stroked: true, getFillColor: [c[0], c[1], c[2], 60] as [number, number, number, number], getLineColor: [c[0], c[1], c[2], 200] as [number, number, number, number], lineWidthMinPixels: 2 }));
      else if (ml.type === 'path') result.push(new PathLayer({ id: `path-${i}`, data: [{ path: ml.data }], getPath: (d: any) => d.path, getColor: [c[0], c[1], c[2], 200] as [number, number, number, number], getWidth: 4, widthMinPixels: 2 }));
      else if (ml.type === 'point') result.push(new ScatterplotLayer({ id: `pt-${i}`, data: [{ position: ml.data }], getPosition: (d: any) => d.position, getFillColor: [c[0], c[1], c[2], 255] as [number, number, number, number], getRadius: 80, radiusMinPixels: 6 }));
    });
    return result;
  }, [mapLayers]);

  const layers = useMemo(() => [basemap, ...deckLayers].filter(Boolean), [basemap, deckLayers]);

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
            <DeckGL viewState={viewState} onViewStateChange={({ viewState: vs }: any) => setViewState(vs)} controller={true} layers={layers} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
