import { useState, useEffect, useCallback } from 'react';
import type { RouteData, FleetStats, ChatMessage, Working, FileAttachment, ActiveStats, MapFilter } from '../types';
import { courierColor } from '../types';

export interface MapZoomTarget {
  center_lat: number;
  center_lon: number;
  zoom: number;
  area: string;
}

export function useRoutes(city: string, mapFilter: MapFilter, dateFilter: string = '', refreshKey: number = 0) {
  const [routes, setRoutes] = useState<RouteData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ city });
    if (mapFilter.type === 'status' && mapFilter.value) {
      params.set('status', mapFilter.value);
    } else if (mapFilter.type !== 'all' && mapFilter.value) {
      params.set('filter_type', mapFilter.type);
      params.set('filter_value', mapFilter.value);
    }
    if (dateFilter) params.set('date', dateFilter);
    fetch(`/api/routes?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((rows) => {
        const mapped: RouteData[] = rows.map((r: any) => {
          let coords: [number, number][] = [];
          try {
            const geo = typeof r.GEOMETRY_JSON === 'string' ? JSON.parse(r.GEOMETRY_JSON) : r.GEOMETRY_JSON;
            coords = geo?.coordinates || [];
          } catch {}
          return {
            order_id: r.ORDER_ID,
            courier_id: r.COURIER_ID,
            restaurant_name: r.RESTAURANT_NAME,
            customer_address: r.CUSTOMER_ADDRESS,
            coordinates: coords,
            distance_km: Number(r.DISTANCE_KM || 0),
            eta_mins: Number(r.ETA_MINS || 0),
            order_status: r.ORDER_STATUS || 'unknown',
            city: r.CITY || city,
            color: courierColor(r.COURIER_ID),
            delay_reason: r.DELAY_REASON || 'none',
            delay_minutes: Number(r.DELAY_MINUTES || 0),
            flood_affected: r.FLOOD_AFFECTED === true || r.FLOOD_AFFECTED === 'true',
          };
        });
        setRoutes(mapped);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Routes fetch error:', err.message);
        setRoutes([]);
        setLoading(false);
      });
  }, [city, mapFilter.type, mapFilter.value, dateFilter, refreshKey]);

  return { routes, loading };
}

export interface FleetAlert {
  type: 'flood' | 'weather' | 'incident_summary';
  id?: string;
  title?: string;
  severity?: string;
  area_geojson?: any;
  center_lat?: number;
  center_lon?: number;
  start_time?: string;
  end_time?: string;
  description?: string;
  water_level_m?: number;
  affected_roads?: number;
  condition?: string;
  station_count?: number;
  incidents?: Record<string, { count: number; avg_delay: number }>;
}

export function useAlerts(city: string, refreshKey: number = 0) {
  const [alerts, setAlerts] = useState<FleetAlert[]>([]);

  useEffect(() => {
    fetch(`/api/alerts?city=${encodeURIComponent(city)}`)
      .then(r => r.json())
      .then(data => setAlerts(Array.isArray(data) ? data : []))
      .catch(() => setAlerts([]));
  }, [city, refreshKey]);

  return alerts;
}

export function useActiveStats(refreshKey: number = 0) {
  const [activeStats, setActiveStats] = useState<ActiveStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch('/api/active-stats')
      .then((r) => r.json())
      .then((data) => { setActiveStats(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [refreshKey]);

  return { activeStats, loading };
}

export function useFleetStats(refreshKey: number = 0) {
  const [stats, setStats] = useState<FleetStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch('/api/fleet-stats')
      .then((r) => r.json())
      .then((data) => {
        setStats(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [refreshKey]);

  return { stats, loading };
}

export function useAgent() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentWorkings, setCurrentWorkings] = useState<Working[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [currentStatus, setCurrentStatus] = useState('');
  const [mapZoomTarget, setMapZoomTarget] = useState<MapZoomTarget | null>(null);

  const sendMessage = useCallback(
    async (text: string, attachments?: FileAttachment[], onMapFilter?: (filterType: string, filterValue: string) => void) => {
      const userMsg: ChatMessage = { role: 'user', content: text, attachments };
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);
      setCurrentWorkings([]);
      setStreamingText('');
      setCurrentStatus('');

      try {
        const res = await fetch('/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: text,
            attachments: attachments?.map((a) => ({
              name: a.name,
              type: a.type,
              mimeType: a.mimeType,
              base64: a.base64,
              extractedText: a.extractedText,
            })),
            history: messages.map((m) => ({
              role: m.role,
              content: [{ type: 'text', text: m.content }],
            })),
          }),
        });

        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let responseText = '';
        const workings: Working[] = [];
        let thinkingText = '';
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() || '';

          for (const line of parts) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              switch (data.type) {
                case 'status':
                  setCurrentStatus(data.message);
                  break;
                case 'thinking_delta':
                  thinkingText += data.text;
                  break;
                case 'thinking':
                  workings.push({ type: 'thinking', text: data.text || thinkingText });
                  setCurrentWorkings([...workings]);
                  thinkingText = '';
                  break;
                case 'tool_use':
                  workings.push({ type: 'tool_use', tool_name: data.tool_name, tool_type: data.tool_type });
                  setCurrentWorkings([...workings]);
                  break;
                case 'tool_result':
                  workings.push({
                    type: 'tool_result',
                    tool_name: data.tool_name,
                    status: data.status,
                    sql: data.sql,
                    sql_explanation: data.sql_explanation,
                    has_results: data.has_results,
                    row_count: data.row_count,
                    results: data.results,
                  });
                  setCurrentWorkings([...workings]);
                  break;
                case 'map_filter':
                  if (onMapFilter) onMapFilter(data.filter_type || 'all', data.filter_value || '');
                  break;
                case 'map_zoom':
                  setMapZoomTarget({
                    center_lat: data.center_lat,
                    center_lon: data.center_lon,
                    zoom: data.zoom || 12,
                    area: data.area || '',
                  });
                  break;
                case 'text_delta':
                  responseText += data.text;
                  setStreamingText(responseText);
                  break;
                case 'text':
                  if (!responseText) responseText = data.text;
                  setStreamingText(responseText);
                  break;
                case 'error':
                  throw new Error(data.message);
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }

        if (thinkingText && !workings.find((w) => w.type === 'thinking')) {
          workings.unshift({ type: 'thinking', text: thinkingText });
        }

        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: responseText || 'No response from agent.',
            workings: workings.length > 0 ? workings : undefined,
          },
        ]);
        setStreamingText('');
        setCurrentWorkings([]);
        setCurrentStatus('');
      } catch (err: any) {
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: `Connection error: ${err.message}` },
        ]);
        setStreamingText('');
        setCurrentWorkings([]);
        setCurrentStatus('');
      } finally {
        setLoading(false);
      }
    },
    [messages]
  );

  const clearChat = useCallback(() => {
    setMessages([]);
    setCurrentWorkings([]);
    setStreamingText('');
    setCurrentStatus('');
  }, []);

  return {
    messages,
    loading,
    sendMessage,
    clearChat,
    currentWorkings,
    streamingText,
    currentStatus,
    mapZoomTarget,
    clearMapZoom: () => setMapZoomTarget(null),
  } as const;
}
