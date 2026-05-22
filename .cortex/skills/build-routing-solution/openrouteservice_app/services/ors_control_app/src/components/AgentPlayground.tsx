import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer } from '@deck.gl/layers';
import {
  injectCursorBlinkCss, cartoBasemap,
  MarkerPoint, GeoData, ChatMsg,
  POI_DISPLAY_NAMES, extractAgentGeoData, stripToolCallJson,
  EMPTY_GEO,
  DemoScenario, AgentDemosConfig, FALLBACK_SCENARIOS,
  SavedPrompt, SAVED_PROMPTS_KEY, loadSavedPrompts, persistSavedPrompts,
  WorkflowStep,
} from './agent-playground/helpers';
import { useFitMap } from '../shared/useFitMap';
import RecenterButton from '../shared/RecenterButton';
import { useRegion } from '../hooks/useRegion';
import { coordsFromGeoJSON, type LngLat } from '../shared/mapFit';

injectCursorBlinkCss();

export default function AgentPlayground() {
  const { regionName } = useRegion();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [geoData, setGeoData] = useState<GeoData>(EMPTY_GEO);
  const [scenarios, setScenarios] = useState<DemoScenario[]>(FALLBACK_SCENARIOS);
  const [activeScenario, setActiveScenario] = useState<string>(FALLBACK_SCENARIOS[0]?.id || 'pharma');
  const [savedPrompts, setSavedPromptsState] = useState<SavedPrompt[]>([]);
  const [workflowSteps, setWorkflowSteps] = useState<WorkflowStep[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const SF_FALLBACK = { longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 };
  const fitCoords = useMemo<LngLat[]>(() => {
    const out: LngLat[] = [];
    if (geoData.geojson) out.push(...coordsFromGeoJSON(geoData.geojson));
    for (const p of geoData.points) if (p.position) out.push([p.position[0], p.position[1]]);
    for (const p of geoData.poiPoints) if (p.position) out.push([p.position[0], p.position[1]]);
    return out;
  }, [geoData]);
  const { containerRef, viewState, onViewStateChange, recenter } = useFitMap(fitCoords, { fallback: SF_FALLBACK, regionKey: regionName });
  const streamingTextRef = useRef('');

  const clearConversation = useCallback(() => {
    setMessages([]);
    setInput('');
    setGeoData(EMPTY_GEO);
    setWorkflowSteps([]);
    streamingTextRef.current = '';
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Load scenarios from /api/agent/config (served from ORS stage's agent-demos.json).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/agent/config')
      .then(r => (r.ok ? r.json() : null))
      .then((data: AgentDemosConfig | null) => {
        if (cancelled || !data || !Array.isArray(data.scenarios) || data.scenarios.length === 0) return;
        setScenarios(data.scenarios);
        if (data.default_scenario && data.scenarios.some(s => s.id === data.default_scenario)) {
          setActiveScenario(data.default_scenario);
        } else {
          setActiveScenario(data.scenarios[0].id);
        }
      })
      .catch(() => { /* keep fallback */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { setSavedPromptsState(loadSavedPrompts()); }, []);

  const addSavedPrompt = useCallback((prompt: string) => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const label = trimmed.length > 60 ? trimmed.slice(0, 57) + '...' : trimmed;
    const next: SavedPrompt = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, label, prompt: trimmed };
    setSavedPromptsState(prev => {
      const dedup = prev.filter(p => p.prompt !== trimmed);
      const updated = [next, ...dedup].slice(0, 12);
      persistSavedPrompts(updated);
      return updated;
    });
  }, []);

  const deleteSavedPrompt = useCallback((id: string) => {
    setSavedPromptsState(prev => {
      const updated = prev.filter(p => p.id !== id);
      persistSavedPrompts(updated);
      return updated;
    });
  }, []);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming) return;
    const userMsg: ChatMsg = { role: 'user', content: input.trim() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);
    setWorkflowSteps([]);

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
                } else if (eventType === 'workflow') {
                  setWorkflowSteps(prev => [...prev, parsed as WorkflowStep]);
                } else if (eventType === 'result') {
                  assistantContent = parsed.message || streamingTextRef.current || '';
                  if (parsed.tool_results) toolResults.push(...parsed.tool_results);
                  if (parsed.token_usage?.workflow_steps && Array.isArray(parsed.token_usage.workflow_steps)) {
                    setWorkflowSteps(parsed.token_usage.workflow_steps as WorkflowStep[]);
                  }
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
        {scenarios.length > 1 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            {scenarios.map(sc => (
              <button
                key={sc.id}
                onClick={() => setActiveScenario(sc.id)}
                disabled={streaming}
                title={sc.description}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px',
                  background: activeScenario === sc.id ? 'var(--accent)' : 'var(--surface, rgba(0,0,0,0.03))',
                  color: activeScenario === sc.id ? '#fff' : 'var(--text)',
                  border: activeScenario === sc.id ? '1px solid var(--accent)' : '1px solid var(--border)',
                  borderRadius: 20, cursor: 'pointer', fontSize: 12,
                  fontWeight: activeScenario === sc.id ? 600 : 400,
                }}
              >
                <span>{sc.icon}</span><span>{sc.label}</span>
              </button>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Try an example</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(scenarios.find(s => s.id === activeScenario)?.prompts || []).map((sp, i) => (
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
        {savedPrompts.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>My saved prompts</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {savedPrompts.map(sp => (
                <span key={sp.id} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 4px 4px 10px',
                  background: 'var(--surface, rgba(0,0,0,0.03))', border: '1px solid var(--border)',
                  borderRadius: 20, fontSize: 12, color: 'var(--text)',
                }}>
                  <button
                    onClick={() => setInput(sp.prompt)}
                    disabled={streaming}
                    style={{ background: 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                  >
                    {sp.label}
                  </button>
                  <button
                    onClick={() => deleteSavedPrompt(sp.id)}
                    aria-label="Remove saved prompt"
                    title="Remove"
                    style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 6px' }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
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
            <button
              onClick={() => addSavedPrompt(input)}
              disabled={!input.trim() || streaming}
              title="Save this prompt"
              style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 16 }}
            >☆</button>
            <button className="btn-primary" onClick={sendMessage} disabled={streaming || !input.trim()}>{streaming ? '...' : 'Send'}</button>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 300 }}>
          <div ref={containerRef} style={{ height: 500, borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden', position: 'relative', background: '#e8e8e8' }}>
            <DeckGL viewState={viewState} onViewStateChange={onViewStateChange} controller={true} layers={layers} getTooltip={getTooltip} style={{ width: '100%', height: '100%' }} />
            <RecenterButton onClick={recenter} disabled={!fitCoords.length} />
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

        <div style={{ flex: '0 0 220px', display: 'flex', flexDirection: 'column', maxHeight: 540, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'rgba(0,0,0,0.02)' }}>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, color: 'var(--text)' }}>Token Workflow</div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {workflowSteps.length === 0 && (
              <div style={{ color: 'var(--text-secondary)', fontSize: 11, textAlign: 'center', padding: 8 }}>
                {streaming ? 'Waiting for steps...' : 'No steps yet'}
              </div>
            )}
            {workflowSteps.map((step, i) => {
              const colorMap: Record<string, string> = {
                start: 'rgba(99, 102, 241, 0.85)',
                tool_start: 'rgba(245, 158, 11, 0.85)',
                tool_done: 'rgba(48, 209, 88, 0.85)',
                status: 'rgba(148, 163, 184, 0.85)',
                done: 'rgba(48, 209, 88, 0.95)',
              };
              const swatch = colorMap[step.type] || 'rgba(148, 163, 184, 0.7)';
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11, color: 'var(--text)' }}>
                  <span style={{ width: 8, height: 8, marginTop: 4, borderRadius: '50%', background: swatch, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 500, wordBreak: 'break-word' }}>{step.label || step.type}</div>
                    {step.tool && step.type !== 'tool_done' && (
                      <div style={{ color: 'var(--text-secondary)', fontSize: 10 }}>{step.tool}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
