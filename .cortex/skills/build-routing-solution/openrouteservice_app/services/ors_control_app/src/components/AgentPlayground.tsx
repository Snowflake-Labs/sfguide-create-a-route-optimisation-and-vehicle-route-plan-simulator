import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, GeoJsonLayer, BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';

const CURSOR_BLINK_CSS = `
@keyframes agent-cursor-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
.agent-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: currentColor;
  margin-left: 1px;
  vertical-align: text-bottom;
  animation: agent-cursor-blink 0.8s step-end infinite;
}
`;

if (typeof document !== 'undefined') {
  const existing = document.getElementById('agent-cursor-style');
  if (!existing) {
    const style = document.createElement('style');
    style.id = 'agent-cursor-style';
    style.textContent = CURSOR_BLINK_CSS;
    document.head.appendChild(style);
  }
}

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
interface PoiPoint { position: [number, number]; name: string; category: string; color: [number, number, number, number]; }
interface GeoData { geojson: any | null; points: MarkerPoint[]; poiPoints: PoiPoint[]; center: [number, number] | null; zoom: number; }

const POI_CATEGORY_COLORS: Record<string, [number, number, number, number]> = {
  restaurant: [255, 99, 71, 230],
  fast_food_restaurant: [255, 99, 71, 230],
  casual_eatery: [255, 99, 71, 230],
  fine_dining_restaurant: [255, 99, 71, 230],
  pizzaria: [255, 99, 71, 230],
  chicken_restaurant: [255, 99, 71, 230],
  sandwich_shop: [255, 99, 71, 230],
  sushi_restaurant: [255, 99, 71, 230],
  seafood_restaurant: [255, 99, 71, 230],
  steak_house: [255, 99, 71, 230],
  burger_restaurant: [255, 99, 71, 230],
  cafe: [138, 43, 226, 230],
  coffee_shop: [138, 43, 226, 230],
  bakery: [138, 43, 226, 230],
  tea_house: [138, 43, 226, 230],
  bar: [255, 165, 0, 230],
  pub: [255, 165, 0, 230],
  nightclub: [255, 165, 0, 230],
  lounge: [255, 165, 0, 230],
  hotel: [0, 191, 255, 230],
  motel: [0, 191, 255, 230],
  hostel: [0, 191, 255, 230],
  bed_and_breakfast: [0, 191, 255, 230],
  shop: [50, 205, 50, 230],
  shopping_mall: [50, 205, 50, 230],
  supermarket: [50, 205, 50, 230],
  hospital: [255, 20, 147, 230],
  medical_clinic: [255, 20, 147, 230],
  pharmacy: [255, 20, 147, 230],
  park: [34, 139, 34, 230],
  playground: [34, 139, 34, 230],
  gas_station: [255, 215, 0, 230],
  parking: [169, 169, 169, 230],
};

function poiColor(category: string): [number, number, number, number] {
  return POI_CATEGORY_COLORS[category] || [100, 149, 237, 230];
}

const POI_DISPLAY_NAMES: Record<string, string> = {
  restaurant: 'Restaurants', fast_food_restaurant: 'Restaurants', casual_eatery: 'Restaurants',
  fine_dining_restaurant: 'Restaurants', pizzaria: 'Restaurants', chicken_restaurant: 'Restaurants',
  sandwich_shop: 'Restaurants', sushi_restaurant: 'Restaurants', seafood_restaurant: 'Restaurants',
  steak_house: 'Restaurants', burger_restaurant: 'Restaurants',
  cafe: 'Cafes', coffee_shop: 'Cafes', bakery: 'Cafes', tea_house: 'Cafes',
  bar: 'Bars', pub: 'Bars', nightclub: 'Bars', lounge: 'Bars',
  hotel: 'Hotels', motel: 'Hotels', hostel: 'Hotels', bed_and_breakfast: 'Hotels',
  shop: 'Shops', shopping_mall: 'Shops', supermarket: 'Shops',
  hospital: 'Healthcare', medical_clinic: 'Healthcare', pharmacy: 'Healthcare',
  park: 'Parks', playground: 'Parks',
  gas_station: 'Gas Stations',
  parking: 'Parking',
};

const VEHICLE_ROUTE_COLORS: [number,number,number,number][] = [
  [66, 133, 244, 220],
  [255, 152, 0, 220],
  [76, 175, 80, 220],
  [156, 39, 176, 220],
  [233, 30, 99, 220],
];

const SKILL_COLORS: Record<number, [number,number,number,number]> = {
  1: [66, 133, 244, 240],
  2: [255, 152, 0, 240],
  3: [76, 175, 80, 240],
};

const SKILL_LABELS: Record<number, string> = {
  1: 'Cold Chain / Vaccines',
  2: 'Controlled Substances',
  3: 'Standard Medicines',
};

function skillColor(skill: number): [number,number,number,number] {
  return SKILL_COLORS[skill] || [100, 149, 237, 240];
}

function extractAgentGeoData(toolResults: any[]): GeoData {
  const features: any[] = [];
  const markerPoints: MarkerPoint[] = [];
  const poiPoints: PoiPoint[] = [];

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
      // TOOL_OPTIMIZATION / TOOL_PHARMA_DEMO: routes array
      if (tr.routes && Array.isArray(tr.routes)) {
        for (const route of tr.routes) {
          const vehicleIdx = ((route.vehicle ?? 1) - 1);
          const routeColor = VEHICLE_ROUTE_COLORS[vehicleIdx % VEHICLE_ROUTE_COLORS.length];
          if (route.geometry && typeof route.geometry === 'string') {
            const coords = decodePolyline(route.geometry);
            if (coords.length > 0) features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { vehicle: route.vehicle ?? 1, routeColor } });
          } else if (route.geometry && Array.isArray(route.geometry)) {
            features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.geometry }, properties: { vehicle: route.vehicle ?? 1, routeColor } });
          }
        }
      }
      // Job stop markers from pharma demo or optimization
      if (tr.jobs && Array.isArray(tr.jobs)) {
        for (const job of tr.jobs) {
          if (job.longitude != null && job.latitude != null) {
            const skill = job.skill ?? job.skills?.[0] ?? 0;
            poiPoints.push({
              position: [Number(job.longitude), Number(job.latitude)],
              name: job.name || job.address || 'Stop',
              category: SKILL_LABELS[skill] || job.skill_label || 'Delivery Stop',
              color: skill ? skillColor(skill) : [100, 149, 237, 240],
            });
          }
        }
      }
      // Population health points from pharma catchment tool
      if (tr.population_points && Array.isArray(tr.population_points)) {
        for (const pt of tr.population_points) {
          if (pt.longitude != null && pt.latitude != null) {
            const risk = pt.risk_score ?? 0;
            const color: [number,number,number,number] = risk >= 55 ? [231, 76, 60, 220] : risk >= 35 ? [230, 126, 34, 200] : [46, 204, 113, 180];
            poiPoints.push({
              position: [Number(pt.longitude), Number(pt.latitude)],
              name: `${pt.neighborhood} (pop. ${pt.population?.toLocaleString()})\nDiabetes: ${pt.diabetes_pct}%  Hypertension: ${pt.hypertension_pct}%\nElderly: ${pt.pct_elderly}%  No car: ${Math.round(100 - (pt.car_ownership_pct ?? 50))}%\nRisk score: ${risk}/100`,
              category: risk >= 55 ? 'High Health Risk' : risk >= 35 ? 'Medium Health Risk' : 'Lower Health Risk',
              color,
            });
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

  for (const tr of toolResults) {
    if (!tr || typeof tr !== 'object') continue;
    if (Array.isArray(tr.poi_list)) {
      for (const poi of tr.poi_list) {
        if (poi.lng != null && poi.lat != null) {
          poiPoints.push({
            position: [Number(poi.lng), Number(poi.lat)],
            name: poi.name || 'Unknown',
            category: poi.category || '',
            color: poiColor(poi.category || ''),
          });
        }
      }
    }
  }

  if (features.length === 0 && markerPoints.length === 0 && poiPoints.length === 0) return { geojson: null, points: markerPoints, poiPoints, center: null, zoom: 12 };

  const allCoords: [number, number][] = [...markerPoints.map(p => p.position), ...poiPoints.map(p => p.position)];
  for (const f of features) {
    const geom = f.geometry;
    if (!geom) continue;
    if (geom.type === 'Point') allCoords.push(geom.coordinates);
    else if (geom.type === 'LineString') allCoords.push(...geom.coordinates);
    else if (geom.type === 'MultiLineString') geom.coordinates.forEach((l: any) => allCoords.push(...l));
    else if (geom.type === 'Polygon') allCoords.push(...geom.coordinates[0]);
    else if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p: any) => allCoords.push(...p[0]));
  }

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

  return { geojson: features.length > 0 ? { type: 'FeatureCollection', features } : null, points: markerPoints, poiPoints, center, zoom };
}

function stripToolCallJson(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/\{[\s\S]*?"tool_call"[\s\S]*?\}/g, '').trim();
}

interface ChatMsg { role: 'user' | 'assistant'; content: string; toolResults?: any[]; streaming?: boolean; }
interface SavedPrompt { id: string; label: string; icon: string; prompt: string; }
interface TokenUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number; summarised?: boolean; summary_text?: string; messages_summarised?: number; messages_raw?: number; }

const SAVED_PROMPTS_KEY = 'agent_playground_saved_prompts';

function loadSavedPrompts(): SavedPrompt[] {
  try { return JSON.parse(localStorage.getItem(SAVED_PROMPTS_KEY) || '[]'); } catch { return []; }
}
function persistSavedPrompts(prompts: SavedPrompt[]) {
  try { localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(prompts)); } catch {}
}

const SAMPLE_PROMPTS: { label: string; icon: string; prompt: string }[] = [
  {
    label: '1. Catchment analysis',
    icon: '🏥',
    prompt: 'Show me the population health profile within a 10 minute drive of Walgreens on Castro Street, San Francisco',
  },
  {
    label: '2. Drug demand',
    icon: '💊',
    prompt: 'Based on that catchment population, what drugs would this pharmacy need most? Consider the diabetes, hypertension, cardiovascular and respiratory rates.',
  },
  {
    label: '3. Patient directions',
    icon: '🗺️',
    prompt: 'Give me driving directions from 742 Valencia Street, San Francisco to Walgreens on Castro Street',
  },
  {
    label: '4. Cycling access',
    icon: '🚲',
    prompt: 'Show me a 5 minute cycling isochrone from Walgreens Castro for patients without cars',
  },
  {
    label: '5. Supply chain plan',
    icon: '🚚',
    prompt: 'Plan the full pharmaceutical supply chain delivery from the depot to all SF pharmacies using 3 specialist vehicles',
  },
  {
    label: '6. Nearby cafes',
    icon: '☕',
    prompt: 'Show me cafes within a 10 minute drive from Union Square, San Francisco',
  },
  {
    label: '7. Multi-stop route',
    icon: '📍',
    prompt: 'Get driving directions from Fisherman\'s Wharf to Pier 39, then to the Embarcadero, then to AT&T Park, San Francisco',
  },
];

const EMPTY_GEO: GeoData = { geojson: null, points: [], poiPoints: [], center: null, zoom: 12 };

export default function AgentPlayground() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [geoData, setGeoData] = useState<GeoData>(EMPTY_GEO);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [viewState, setViewState] = useState({ longitude: -122.43, latitude: 37.77, zoom: 11, pitch: 0, bearing: 0 });
  const streamingTextRef = useRef('');
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>(loadSavedPrompts);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [saveLabel, setSaveLabel] = useState('');
  const [saveIcon, setSaveIcon] = useState('📌');

  const openSaveDialog = useCallback(() => {
    if (!input.trim()) return;
    setSaveLabel('');
    setSaveIcon('📌');
    setSaveDialogOpen(true);
  }, [input]);

  const confirmSave = useCallback(() => {
    if (!saveLabel.trim() || !input.trim()) return;
    const newPrompt: SavedPrompt = { id: Date.now().toString(), label: saveLabel.trim(), icon: saveIcon, prompt: input.trim() };
    setSavedPrompts(prev => { const updated = [...prev, newPrompt]; persistSavedPrompts(updated); return updated; });
    setSaveDialogOpen(false);
  }, [saveLabel, saveIcon, input]);

  const deletePrompt = useCallback((id: string) => {
    setSavedPrompts(prev => { const updated = prev.filter(p => p.id !== id); persistSavedPrompts(updated); return updated; });
  }, []);

  const clearConversation = useCallback(() => {
    setMessages([]);
    setInput('');
    setGeoData(EMPTY_GEO);
    setTokenUsage(null);
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
                  if (parsed.token_usage) setTokenUsage(prev => {
                    const incoming = parsed.token_usage;
                    if (!prev) return incoming;
                    return { prompt_tokens: prev.prompt_tokens + incoming.prompt_tokens, completion_tokens: prev.completion_tokens + incoming.completion_tokens, total_tokens: prev.total_tokens + incoming.total_tokens, summarised: incoming.summarised || prev.summarised };
                  });
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
      getLineColor: (f: any) => {
        const rc = f.properties?.routeColor;
        return rc ? rc : [41, 181, 232, 220];
      },
      getFillColor: (f: any) => {
        const rc = f.properties?.routeColor;
        return rc ? [rc[0], rc[1], rc[2], 50] : [41, 181, 232, 50];
      },
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
      const label = p.category || POI_DISPLAY_NAMES[p.category] || p.category;
      if (!counts[label]) counts[label] = { label, color: p.color, count: 0 };
      counts[label].count++;
    }
    return Object.values(counts);
  }, [geoData.poiPoints]);

  const routeLegend = useMemo(() => {
    if (!geoData.geojson) return null;
    const vehicles: Record<number, [number,number,number,number]> = {};
    for (const f of geoData.geojson.features) {
      const v = f.properties?.vehicle;
      if (v != null) vehicles[v] = f.properties.routeColor || VEHICLE_ROUTE_COLORS[(v-1) % VEHICLE_ROUTE_COLORS.length];
    }
    if (Object.keys(vehicles).length < 2) return null;
    return Object.entries(vehicles).map(([v, color]) => ({ vehicle: Number(v), color }));
  }, [geoData.geojson]);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {tokenUsage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} title={`Prompt: ${tokenUsage.prompt_tokens} | Completion: ${tokenUsage.completion_tokens}${tokenUsage.summarised ? ` | ${tokenUsage.messages_summarised} msgs summarised, ${tokenUsage.messages_raw} raw` : ''}`}>
                <span style={{ fontWeight: 500 }}>{tokenUsage.total_tokens.toLocaleString()}</span>
                <span>tokens</span>
              </div>
              <div style={{ width: 60, height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, (tokenUsage.total_tokens / 8000) * 100)}%`, height: '100%', borderRadius: 2, background: tokenUsage.total_tokens > 6000 ? '#e74c3c' : tokenUsage.total_tokens > 4000 ? '#f39c12' : 'var(--accent)', transition: 'width 0.3s' }} />
              </div>
              {tokenUsage.summarised && (
                <span
                  style={{ fontSize: 10, background: 'rgba(41,181,232,0.15)', color: 'var(--accent)', padding: '1px 5px', borderRadius: 4, cursor: 'help' }}
                  title={tokenUsage.summary_text ? `Summary: ${tokenUsage.summary_text}` : 'Context was summarised to fit token limit'}
                >{tokenUsage.messages_summarised} msgs compressed</span>
              )}
            </div>
          )}
          {messages.length > 0 && (
            <button onClick={clearConversation} disabled={streaming} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              New conversation
            </button>
          )}
        </div>
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

      {savedPrompts.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.05em' }}>My saved prompts</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {savedPrompts.map(sp => (
              <div key={sp.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 0, background: 'rgba(41,181,232,0.08)', border: '1px solid rgba(41,181,232,0.3)', borderRadius: 20, overflow: 'hidden' }}>
                <button
                  onClick={() => setInput(sp.prompt)}
                  disabled={streaming}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px 5px 10px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap' }}
                >
                  <span>{sp.icon}</span><span>{sp.label}</span>
                </button>
                <button
                  onClick={() => deletePrompt(sp.id)}
                  style={{ padding: '5px 8px 5px 4px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1 }}
                  title="Delete"
                >✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

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
              onClick={openSaveDialog}
              disabled={!input.trim() || streaming}
              title="Save as example"
              style={{ padding: '0 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: input.trim() ? 'pointer' : 'default', opacity: input.trim() ? 1 : 0.4, fontSize: 15 }}
            >💾</button>
            <button className="btn-primary" onClick={sendMessage} disabled={streaming || !input.trim()}>{streaming ? '...' : 'Send'}</button>
          </div>

          {saveDialogOpen && (
            <div style={{ marginTop: 8, padding: '10px 12px', background: 'rgba(41,181,232,0.06)', border: '1px solid rgba(41,181,232,0.3)', borderRadius: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text)' }}>Save this prompt</div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                <input
                  value={saveIcon}
                  onChange={e => setSaveIcon(e.target.value)}
                  style={{ width: 36, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, textAlign: 'center' }}
                  maxLength={2}
                />
                <input
                  value={saveLabel}
                  onChange={e => setSaveLabel(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') confirmSave(); if (e.key === 'Escape') setSaveDialogOpen(false); }}
                  placeholder="Short label e.g. Castro pharmacy check"
                  autoFocus
                  style={{ flex: 1, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-primary" onClick={confirmSave} disabled={!saveLabel.trim()} style={{ fontSize: 12, padding: '4px 12px' }}>Save</button>
                <button onClick={() => setSaveDialogOpen(false)} style={{ fontSize: 12, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          )}
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
          {routeLegend && routeLegend.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {routeLegend.map(entry => (
                <div key={entry.vehicle} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
                  <div style={{ width: 18, height: 4, borderRadius: 2, background: `rgb(${entry.color[0]},${entry.color[1]},${entry.color[2]})`, flexShrink: 0 }} />
                  <span>Vehicle {entry.vehicle}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
