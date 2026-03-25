import { useState, useRef, useEffect, useMemo } from 'react';
import { GeoJsonLayer, ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import MapView from '../../shared/MapView';
import { useRegion } from '../../hooks/useRegion';

interface Props { sourceDb: string; sourceSchema: string; config: Record<string, any>; }

interface Message { role: 'user' | 'assistant'; content: string; }

const ROUTE_COLORS: [number, number, number, number][] = [
  [41, 181, 232, 220], [255, 107, 53, 220], [46, 204, 113, 220],
  [155, 89, 182, 220], [241, 196, 15, 220], [231, 76, 60, 220],
];

function decodeGeometry(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let shift = 0, result = 0, byte: number;
    do { byte = encoded.charCodeAt(idx++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(idx++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

function extractLayers(toolResults: any[]): any[] {
  const layers: any[] = [];
  let routeIdx = 0;

  for (const tr of toolResults) {
    if (tr.status === 'FAILED') continue;

    const geom = tr.geometry || tr.geojson;

    if (geom?.type === 'LineString' || geom?.type === 'MultiLineString') {
      layers.push(new GeoJsonLayer({
        id: `route-geojson-${Date.now()}-${routeIdx}`,
        data: { type: 'Feature', geometry: geom, properties: {} },
        getLineColor: ROUTE_COLORS[routeIdx % ROUTE_COLORS.length],
        getLineWidth: 5,
        lineWidthMinPixels: 3,
      }));
      routeIdx++;
    } else if (geom?.type === 'Polygon' || geom?.type === 'MultiPolygon') {
      layers.push(new GeoJsonLayer({
        id: `isochrone-geojson-${Date.now()}`,
        data: { type: 'Feature', geometry: geom, properties: {} },
        getFillColor: [41, 181, 232, 60],
        getLineColor: [41, 181, 232, 200],
        getLineWidth: 2,
        lineWidthMinPixels: 1,
        filled: true,
        stroked: true,
      }));
    } else if (geom?.type === 'Point') {
      layers.push(new ScatterplotLayer({
        id: `point-${Date.now()}-${routeIdx}`,
        data: [{ position: geom.coordinates }],
        getPosition: (d: any) => d.position,
        getFillColor: [255, 107, 53, 220],
        getRadius: 200,
        radiusMinPixels: 6,
      }));
    }

    if (tr.routes && Array.isArray(tr.routes)) {
      for (const route of tr.routes) {
        const routeGeom = route.geometry || route.route_geometry;
        if (typeof routeGeom === 'string') {
          const coords = decodeGeometry(routeGeom);
          if (coords.length > 0) {
            layers.push(new PathLayer({
              id: `opt-route-${Date.now()}-${routeIdx}`,
              data: [{ path: coords }],
              getPath: (d: any) => d.path,
              getColor: ROUTE_COLORS[routeIdx % ROUTE_COLORS.length],
              getWidth: 5,
              widthMinPixels: 3,
            }));
            routeIdx++;
          }
        }
      }
    }

    if (tr.locations && Array.isArray(tr.locations)) {
      const pts = tr.locations
        .filter((l: any) => l.longitude && l.latitude)
        .map((l: any) => ({ position: [l.longitude, l.latitude], name: l.name }));
      if (pts.length > 0) {
        layers.push(new ScatterplotLayer({
          id: `waypoints-${Date.now()}`,
          data: pts,
          getPosition: (d: any) => d.position,
          getFillColor: [255, 255, 255, 220],
          getLineColor: [41, 181, 232, 255],
          getRadius: 100,
          radiusMinPixels: 5,
          lineWidthMinPixels: 2,
          stroked: true,
        }));
      }
    }

    if (tr.coordinates && Array.isArray(tr.coordinates) && tr.coordinates.length === 2) {
      layers.push(new ScatterplotLayer({
        id: `center-${Date.now()}`,
        data: [{ position: tr.coordinates }],
        getPosition: (d: any) => d.position,
        getFillColor: [255, 255, 255, 220],
        getLineColor: [41, 181, 232, 255],
        getRadius: 100,
        radiusMinPixels: 5,
        lineWidthMinPixels: 2,
        stroked: true,
      }));
    }
  }

  return layers;
}

export default function AgentPlayground({}: Props) {
  const { regionName, center, zoom } = useRegion();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [mapLayers, setMapLayers] = useState<any[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [messageId, setMessageId] = useState<string | undefined>();
  const [viewState, setViewState] = useState({ longitude: center.lng, latitude: center.lat, zoom });
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesRef.current?.scrollTo(0, messagesRef.current.scrollHeight);
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || sending) return;
    const userMsg = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setSending(true);

    try {
      const body: any = { message: userMsg };
      if (threadId) {
        body.thread_id = threadId;
        body.parent_message_id = messageId || '0';
      }
      setProgressText('Connecting...');
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult: any = null;
        let finalError: string | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          let currentEvent = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const dataStr = line.slice(6);
              try {
                const data = JSON.parse(dataStr);
                if (currentEvent === 'progress') {
                  const stepLabels: Record<string, string> = {
                    calling_llm: 'Thinking...',
                    executing_tool: `Running ${data.detail || 'tool'}...`,
                    formatting: 'Formatting results...',
                  };
                  setProgressText(stepLabels[data.step] || data.step);
                } else if (currentEvent === 'result') {
                  finalResult = data;
                } else if (currentEvent === 'error') {
                  finalError = data.error || 'Agent request failed';
                }
              } catch {}
              currentEvent = '';
            }
          }
        }

        setProgressText('');
        if (finalError) {
          setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${finalError}` }]);
        } else if (finalResult) {
          if (finalResult.thread_id) setThreadId(finalResult.thread_id);
          if (finalResult.message_id) setMessageId(finalResult.message_id);
          const text = finalResult.message || 'No response';
          setMessages(prev => [...prev, { role: 'assistant', content: text }]);
          if (finalResult.tool_results && finalResult.tool_results.length > 0) {
            const newLayers = extractLayers(finalResult.tool_results);
            if (newLayers.length > 0) {
              setMapLayers(newLayers);
              for (const tr of finalResult.tool_results) {
                if (tr.coordinates && Array.isArray(tr.coordinates)) {
                  setViewState({ longitude: tr.coordinates[0], latitude: tr.coordinates[1], zoom: 12 });
                  break;
                }
                if (tr.locations && Array.isArray(tr.locations) && tr.locations.length > 0) {
                  const loc = tr.locations[0];
                  if (loc.longitude && loc.latitude) {
                    setViewState({ longitude: loc.longitude, latitude: loc.latitude, zoom: 12 });
                    break;
                  }
                }
              }
            }
          }
        } else {
          setMessages(prev => [...prev, { role: 'assistant', content: 'No response from agent' }]);
        }
      } else {
        const rawText = await res.text();
        let result: any;
        try {
          result = JSON.parse(rawText);
        } catch {
          const isTimeout = rawText.toLowerCase().includes('upstream request timeout');
          const errMsg = isTimeout
            ? 'Request timed out — the query took too long. Please try a simpler question or try again.'
            : `Server error: ${rawText.slice(0, 200)}`;
          setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${errMsg}` }]);
          setSending(false);
          setProgressText('');
          return;
        }
        if (res.ok) {
          if (result.thread_id) setThreadId(result.thread_id);
          if (result.message_id) setMessageId(result.message_id);
          const text = result.message || 'No response';
          setMessages(prev => [...prev, { role: 'assistant', content: text }]);
          if (result.tool_results && result.tool_results.length > 0) {
            const newLayers = extractLayers(result.tool_results);
            if (newLayers.length > 0) setMapLayers(newLayers);
          }
        } else {
          setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${result.error || 'Agent request failed'}` }]);
        }
      }
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${e.message}` }]);
    }
    setSending(false);
    setProgressText('');
  };

  return (
    <div className="agent-playground">
      <div className="agent-chat-panel">
        <h2>Routing Agent</h2>
        <p>Ask natural language routing questions (powered by Cortex AI + OpenRouteService)</p>
        <div className="agent-messages" ref={messagesRef}>
          {messages.length === 0 && (
            <div className="agent-welcome">
              <p>Try asking:</p>
              <ul>
                <li>"Directions from Alexanderplatz to Brandenburg Gate by bike"</li>
                <li>"Show me a 15 minute cycling isochrone from Berlin Hauptbahnhof"</li>
                <li>"Optimize delivery to 5 restaurants from Kreuzberg depot with 2 vehicles"</li>
              </ul>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`agent-message ${m.role}`}>
              {m.content}
            </div>
          ))}
          {sending && <div className="agent-message assistant" style={{ opacity: 0.5 }}>{progressText || 'Thinking...'}</div>}
        </div>
        <div className="agent-input-row">
          <input className="agent-input" value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendMessage()}
            placeholder="Ask a routing question..." disabled={sending} />
          <button className="btn-primary" onClick={sendMessage} disabled={sending}>Send</button>
        </div>
      </div>
      <div className="agent-map-area">
        {mapLayers.length > 0 ? (
          <MapView layers={mapLayers} initialViewState={viewState} />
        ) : (
          <div className="placeholder-map">Agent responses with spatial data will appear on this map</div>
        )}
      </div>
    </div>
  );
}
