import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import {
  injectCursorBlinkCss, cartoBasemap, decodePolyline,
  MarkerPoint, PoiPoint, GeoData, ChatMsg,
  poiColor, POI_DISPLAY_NAMES, extractAgentGeoData, stripToolCallJson,
  SAMPLE_PROMPTS, EMPTY_GEO,
} from './agent-playground/helpers';

injectCursorBlinkCss();

export default function AgentPlayground() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [geoData, setGeoData] = useState<GeoData>(EMPTY_GEO);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });
  const streamingTextRef = useRef('');

  const clearConversation = useCallback(() => {
    setMessages([]);
    setInput('');
    setGeoData(EMPTY_GEO);
    streamingTextRef.current = '';
    setViewState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });
  }, []);

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
      streamingTextRef.current = '';

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
                if (eventType === 'token') {
                  streamingTextRef.current += parsed.text || '';
                  const accumulated = streamingTextRef.current;
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') { last.content = accumulated; last.streaming = true; }
                    else updated.push({ role: 'assistant', content: accumulated, streaming: true });
                    return updated;
                  });
                } else if (eventType === 'result') {
                  assistantContent = parsed.message || streamingTextRef.current || '';
                  if (parsed.tool_results) toolResults.push(...parsed.tool_results);
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') { last.content = assistantContent; last.toolResults = toolResults; last.streaming = false; }
                    else updated.push({ role: 'assistant', content: assistantContent, toolResults, streaming: false });
                    return updated;
                  });
                } else if (eventType === 'progress') {
                  const stepLabels: Record<string, string> = { calling_llm: 'Thinking...', executing_tool: 'Running tool', formatting: 'Generating response...' };
                  const label = stepLabels[parsed.step] || parsed.step || '';
                  const progressText = parsed.detail && !parsed.detail.startsWith('Iteration') ? `${label} ${parsed.detail}`.trim() : label || 'Thinking...';
                  if (streamingTextRef.current) break;
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant' && !last.streaming) last.content = progressText;
                    else if (!last || last.role !== 'assistant') updated.push({ role: 'assistant', content: progressText });
                    return updated;
                  });
                } else if (eventType === 'error') {
                  assistantContent = `Error: ${parsed.error || 'Unknown error'}`;
                  setMessages(prev => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') { last.content = assistantContent; last.streaming = false; }
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
        if (last?.role === 'assistant') { last.toolResults = toolResults; last.streaming = false; }
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

  const poiLayer = useMemo(() => {
    if (geoData.poiPoints.length === 0) return null;
    return new ScatterplotLayer({
      id: 'agent-poi',
      data: geoData.poiPoints,
      pickable: true,
      getPosition: (d: any) => d.position,
      getFillColor: (d: any) => d.color,
      getLineColor: [255, 255, 255, 200] as [number, number, number, number],
      getRadius: 50,
      radiusMinPixels: 5,
      radiusMaxPixels: 9,
      stroked: true,
      lineWidthMinPixels: 1,
    });
  }, [geoData.poiPoints]);

  const poiLegend = useMemo(() => {
    if (geoData.poiPoints.length === 0) return null;
    const counts: Record<string, { label: string; color: [number,number,number,number]; count: number }> = {};
    for (const p of geoData.poiPoints) {
      const label = POI_DISPLAY_NAMES[p.category] || p.category;
      if (!counts[label]) counts[label] = { label, color: p.color, count: 0 };
      counts[label].count++;
    }
    return Object.values(counts);
  }, [geoData.poiPoints]);

  const layers = useMemo(() => [basemap, geojsonLayer, startEndLayer, pointsLayer, poiLayer].filter(Boolean), [basemap, geojsonLayer, startEndLayer, pointsLayer, poiLayer]);

  const getTooltip = useCallback(({ object, layer }: any) => {
    if (!object) return null;
    if (layer?.id === 'agent-poi') {
      return { text: `${object.name}\n${POI_DISPLAY_NAMES[object.category] || object.category}`, style: { background: '#14141f', color: '#e8e8f0', fontSize: '12px', padding: '4px 8px', borderRadius: '4px', whiteSpace: 'pre-line' } };
    }
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <h2 style={{ fontSize: 20, margin: 0 }}>Agent Playground</h2>
        {messages.length > 0 && (
          <button onClick={clearConversation} disabled={streaming} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            New conversation
          </button>
        )}
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 10 }}>Chat with the routing agent — ask about directions, reachability, or place discovery</p>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Try an example</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {SAMPLE_PROMPTS.map((sp, i) => (
            <button
              key={i}
              onClick={() => setInput(sp.prompt)}
              disabled={streaming}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px',
                background: 'var(--surface, rgba(0,0,0,0.03))', border: '1px solid var(--border)',
                borderRadius: 20, cursor: 'pointer', fontSize: 12, color: 'var(--text)',
                transition: 'background 0.15s, border-color 0.15s', whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(41,181,232,0.1)'; e.currentTarget.style.borderColor = 'rgba(41,181,232,0.5)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface, rgba(0,0,0,0.03))'; e.currentTarget.style.borderColor = 'var(--border)'; }}
            >
              <span>{sp.icon}</span><span>{sp.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 380px', display: 'flex', flexDirection: 'column', maxHeight: 540 }}>
          <div style={{ flex: 1, overflowY: 'auto', marginBottom: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 8, background: 'rgba(0,0,0,0.02)', minHeight: 200 }}>
            {messages.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: 16, textAlign: 'center' }}>Select an example above or type your own question</div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ marginBottom: 8, textAlign: m.role === 'user' ? 'right' : 'left' }}>
                <div style={{ display: 'inline-block', maxWidth: '90%', padding: '8px 12px', borderRadius: 8, background: m.role === 'user' ? 'var(--accent)' : 'rgba(0,0,0,0.04)', color: m.role === 'user' ? '#fff' : 'var(--text)', fontSize: 13 }}>
                    {m.role === 'assistant'
                      ? <>
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                            p: ({children}) => <p style={{margin: '0 0 6px'}}>{children}</p>,
                            ul: ({children}) => <ul style={{margin: '4px 0', paddingLeft: 18}}>{children}</ul>,
                            ol: ({children}) => <ol style={{margin: '4px 0', paddingLeft: 18}}>{children}</ol>,
                            li: ({children}) => <li style={{marginBottom: 2}}>{children}</li>,
                            code: ({children}) => <code style={{background: 'rgba(0,0,0,0.1)', borderRadius: 3, padding: '1px 4px', fontFamily: 'monospace', fontSize: 12}}>{children}</code>,
                            pre: ({children}) => <pre style={{background: 'rgba(0,0,0,0.1)', borderRadius: 6, padding: '8px', overflowX: 'auto', fontSize: 12, margin: '4px 0'}}>{children}</pre>,
                            strong: ({children}) => <strong style={{fontWeight: 600}}>{children}</strong>,
                            a: ({href, children}) => <a href={href} target="_blank" rel="noopener noreferrer" style={{color: 'var(--accent)'}}>{children}</a>,
                            table: ({children}) => <table style={{borderCollapse: 'collapse', width: '100%', fontSize: 12, margin: '4px 0'}}>{children}</table>,
                            th: ({children}) => <th style={{border: '1px solid var(--border)', padding: '4px 8px', textAlign: 'left', background: 'rgba(0,0,0,0.05)'}}>{children}</th>,
                            td: ({children}) => <td style={{border: '1px solid var(--border)', padding: '4px 8px'}}>{children}</td>,
                          }}>{stripToolCallJson(m.content) || (streaming && !m.streaming ? '...' : '')}</ReactMarkdown>
                          {m.streaming && <span className="agent-cursor" />}
                        </>
                      : m.content}
                  </div>
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
          {poiLegend && poiLegend.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {poiLegend.map(entry => (
                <div key={entry.label} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text-secondary)' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: `rgb(${entry.color[0]},${entry.color[1]},${entry.color[2]})`, flexShrink: 0 }} />
                  <span>{entry.label} ({entry.count})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
