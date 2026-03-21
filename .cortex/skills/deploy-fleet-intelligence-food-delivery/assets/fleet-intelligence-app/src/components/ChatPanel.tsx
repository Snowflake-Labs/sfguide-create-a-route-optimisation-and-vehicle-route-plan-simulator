import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ResponsiveContainer,
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import type { Working, ChatMessage, FileAttachment, FleetStats, ActiveStats, StatusFilter, MapFilter, MatrixSelection } from '../types';
import { parseAgentFilter } from '../types';

const QUICK_QUESTIONS = [
  'How many deliveries were made today?',
  "What's the busiest restaurant by order count?",
  'Show me the weather conditions over the last 24 hours',
  'Which couriers were affected by flooding?',
  'How many customer complaints are flood-related vs traffic-related?',
  "What's the average delay for flood-affected deliveries vs normal?",
  'Show angry customer calls from today',
  'Show all deliveries for courier SAN-0012 on the map',
  "What's the forecast for tomorrow?",
  'Which shift has the most delays?',
  'Show me Italian restaurants on the map',
];

const CHART_REGEX = /```chart\s*\n([\s\S]*?)\n```/g;

interface ChartSpec {
  type: 'line' | 'bar';
  title?: string;
  xKey: string;
  yKeys: { key: string; color?: string; label?: string }[];
  data: Record<string, any>[];
}

const CHART_COLORS = ['#FF6B35', '#29B5E8', '#00B000', '#E63946', '#FFB835', '#9B59B6', '#1ABC9C', '#F39C12'];

function AgentChart({ spec }: { spec: ChartSpec }) {
  const yKeys = spec.yKeys.map((yk, i) => ({
    ...yk,
    color: yk.color || CHART_COLORS[i % CHART_COLORS.length],
    label: yk.label || yk.key,
  }));

  const ChartComponent = spec.type === 'bar' ? BarChart : LineChart;

  return (
    <div className="agent-chart">
      {spec.title && <div className="agent-chart-title">{spec.title}</div>}
      <ResponsiveContainer width="100%" height={220}>
        <ChartComponent data={spec.data} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,107,53,0.15)" />
          <XAxis
            dataKey={spec.xKey}
            tick={{ fill: '#A0B1BA', fontSize: 10 }}
            stroke="rgba(255,107,53,0.25)"
            angle={-30}
            textAnchor="end"
            height={50}
          />
          <YAxis tick={{ fill: '#A0B1BA', fontSize: 10 }} stroke="rgba(255,107,53,0.25)" />
          <Tooltip
            contentStyle={{
              background: 'rgba(26,42,58,0.95)',
              border: '1px solid #FF6B35',
              borderRadius: 6,
              fontSize: 11,
              color: '#F5F5F5',
            }}
          />
          {yKeys.length > 1 && (
            <Legend
              wrapperStyle={{ fontSize: 10, color: '#A0B1BA' }}
            />
          )}
          {yKeys.map((yk) =>
            spec.type === 'bar' ? (
              <Bar key={yk.key} dataKey={yk.key} name={yk.label} fill={yk.color} radius={[3, 3, 0, 0]} />
            ) : (
              <Line
                key={yk.key}
                type="monotone"
                dataKey={yk.key}
                name={yk.label}
                stroke={yk.color}
                strokeWidth={2}
                dot={{ r: 3, fill: yk.color }}
                activeDot={{ r: 5 }}
              />
            )
          )}
        </ChartComponent>
      </ResponsiveContainer>
    </div>
  );
}

function parseCharts(content: string): { text: string; charts: ChartSpec[] } {
  const charts: ChartSpec[] = [];
  const text = content.replace(CHART_REGEX, (_match, json) => {
    try {
      const spec = JSON.parse(json) as ChartSpec;
      if (spec.data && spec.xKey && spec.yKeys) {
        charts.push(spec);
        return `\n[Chart: ${spec.title || 'Data Visualization'}]\n`;
      }
    } catch {}
    return '';
  });
  return { text, charts };
}

function autoDetectChart(results: Record<string, any>[] | undefined): ChartSpec | null {
  if (!results || results.length < 2 || results.length > 100) return null;
  const keys = Object.keys(results[0]);
  if (keys.length < 2) return null;

  const isNumeric = (v: any) => v !== null && v !== undefined && !isNaN(Number(v)) && typeof v !== 'boolean';
  const isTimelike = (k: string) => /time|date|hour|day|month|year|period|week|shift/i.test(k);
  const isCategory = (k: string) => /name|type|city|status|cuisine|vehicle|id|courier|restaurant|category/i.test(k);

  const numericKeys = keys.filter(k => results!.every(r => r[k] === null || isNumeric(r[k])));
  const nonNumericKeys = keys.filter(k => !numericKeys.includes(k));

  let xKey = '';
  const yKeys: { key: string; label: string }[] = [];

  const timeKey = keys.find(k => isTimelike(k) && !numericKeys.includes(k));
  const catKey = keys.find(k => isCategory(k) && !numericKeys.includes(k));
  const numTimeKey = keys.find(k => isTimelike(k) && numericKeys.includes(k));

  if (timeKey) {
    xKey = timeKey;
  } else if (numTimeKey) {
    xKey = numTimeKey;
  } else if (catKey) {
    xKey = catKey;
  } else if (nonNumericKeys.length > 0) {
    xKey = nonNumericKeys[0];
  } else if (numericKeys.length >= 2) {
    xKey = numericKeys[0];
  }

  if (!xKey) return null;

  const candidates = numericKeys.filter(k => k !== xKey);
  if (candidates.length === 0) return null;

  for (const k of candidates.slice(0, 4)) {
    yKeys.push({ key: k, label: k.replace(/_/g, ' ') });
  }

  const uniqueX = new Set(results!.map(r => String(r[xKey]))).size;
  const chartType: 'bar' | 'line' = (timeKey || numTimeKey || uniqueX > 8) ? 'line' : 'bar';

  const data = results!.map(r => {
    const row: Record<string, any> = {};
    row[xKey] = r[xKey];
    for (const yk of yKeys) {
      row[yk.key] = r[yk.key] !== null ? Number(r[yk.key]) : 0;
    }
    return row;
  });

  return {
    type: chartType,
    title: yKeys.length === 1 ? yKeys[0].label : undefined,
    xKey,
    yKeys,
    data,
  };
}

function MarkdownWithCharts({ content, workings }: { content: string; workings?: Working[] }) {
  const { text, charts } = useMemo(() => parseCharts(content), [content]);
  const autoChart = useMemo(() => {
    if (charts.length > 0) return null;
    const toolResult = workings?.find(w => w.type === 'tool_result' && w.results && w.results.length > 0);
    return toolResult ? autoDetectChart(toolResult.results) : null;
  }, [charts.length, workings]);

  return (
    <>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      {charts.map((spec, i) => (
        <AgentChart key={i} spec={spec} />
      ))}
      {autoChart && <AgentChart spec={autoChart} />}
    </>
  );
}

function fmt(n: number | undefined | null): string {
  if (!n) return '0';
  return n.toLocaleString('en-US');
}

interface CompactStatsProps {
  stats: FleetStats | null;
  activeStats: ActiveStats | null;
  statsLoading: boolean;
  selectedCity: string;
  statusFilter: StatusFilter;
  onStatusFilter: (f: StatusFilter) => void;
  onMapFilter: (f: MapFilter) => void;
  matrixSelection?: MatrixSelection | null;
}

function CompactStats({ stats, activeStats, statsLoading, selectedCity, statusFilter, onStatusFilter }: CompactStatsProps) {
  const [expanded, setExpanded] = useState(false);

  if (statsLoading || !stats) {
    return (
      <div className="compact-stats">
        <div className="compact-stats-loading">Loading fleet data...</div>
      </div>
    );
  }

  const cityStats = selectedCity === 'All Cities'
    ? null
    : stats.cities.find((c) => c.city === selectedCity);

  const isFiltered = selectedCity !== 'All Cities';
  const displayOrders = isFiltered ? (cityStats?.orders || 0) : stats.total_orders;
  const displayCouriers = isFiltered ? (cityStats?.couriers || 0) : stats.total_couriers;
  const displayAvgMins = isFiltered ? (cityStats?.avg_mins || 0) : stats.avg_delivery_mins;
  const displayKm = isFiltered ? (cityStats?.total_km || 0) : stats.total_km;

  const cityActive = activeStats && isFiltered
    ? activeStats.cities.find((c) => c.city === selectedCity)
    : null;
  const activeCount = isFiltered ? (cityActive?.active || 0) : (activeStats?.active || 0);
  const inTransitCount = isFiltered ? (cityActive?.in_transit || 0) : (activeStats?.in_transit || 0);
  const pickedUpCount = isFiltered ? (cityActive?.picked_up || 0) : (activeStats?.picked_up || 0);

  return (
    <div className="compact-stats">
      <button className="compact-stats-header" onClick={() => setExpanded(!expanded)}>
        <div className="compact-stats-row">
          <div className="compact-stat">
            <span className="compact-stat-value highlight">{fmt(displayOrders)}</span>
            <span className="compact-stat-label">total</span>
          </div>
          <div className="compact-stat">
            <span className="compact-stat-value active-value">{fmt(activeCount)}</span>
            <span className="compact-stat-label">active</span>
          </div>
          <div className="compact-stat">
            <span className="compact-stat-value">{displayAvgMins.toFixed(1)}</span>
            <span className="compact-stat-label">avg min</span>
          </div>
          <div className="compact-stat">
            <span className="compact-stat-value">{fmt(displayCouriers)}</span>
            <span className="compact-stat-label">couriers</span>
          </div>
        </div>
        <span className={`working-chevron ${expanded ? 'open' : ''}`}>&#9656;</span>
      </button>
      <div className="map-filter-bar">
        <button className={`filter-btn ${statusFilter === 'all' ? 'active' : ''}`} onClick={() => onStatusFilter('all')}>All</button>
        <button className={`filter-btn filter-active ${statusFilter === 'active' ? 'active' : ''}`} onClick={() => onStatusFilter('active')}>
          Active ({activeCount})
        </button>
        <button className={`filter-btn filter-transit ${statusFilter === 'in_transit' ? 'active' : ''}`} onClick={() => onStatusFilter('in_transit')}>
          In Transit ({inTransitCount})
        </button>
        <button className={`filter-btn filter-picked ${statusFilter === 'picked_up' ? 'active' : ''}`} onClick={() => onStatusFilter('picked_up')}>
          Picked Up ({pickedUpCount})
        </button>
      </div>
      {expanded && (
        <div className="compact-stats-detail">
          <div className="compact-stats-city-grid">
            {stats.cities.slice(0, 10).map((c) => {
              const ca = activeStats?.cities.find((ac) => ac.city === c.city);
              return (
                <div key={c.city} className={`compact-city-row ${c.city === selectedCity ? 'selected' : ''}`}>
                  <span className="compact-city-name">{c.city}</span>
                  <span className="compact-city-active">{ca?.active || 0}</span>
                  <span className="compact-city-orders">{fmt(c.orders)}</span>
                  <span className="compact-city-avg">{c.avg_mins.toFixed(1)}m</span>
                </div>
              );
            })}
          </div>
          {stats.cities.length > 10 && (
            <div className="compact-stats-more">+{stats.cities.length - 10} more cities</div>
          )}
        </div>
      )}
    </div>
  );
}

function WorkingItem({ working }: { working: Working }) {
  const [expanded, setExpanded] = useState(false);

  if (working.type === 'thinking') {
    const preview = working.text ? working.text.slice(0, 80) + (working.text.length > 80 ? '...' : '') : '';
    return (
      <div className="working-item working-thinking">
        <button className="working-toggle" onClick={() => setExpanded(!expanded)}>
          <span className={`working-chevron ${expanded ? 'open' : ''}`}>&#9656;</span>
          <span>Reasoning</span>
          {!expanded && preview && <span className="working-preview">{preview}</span>}
        </button>
        {expanded && <div className="working-thinking-content">{working.text}</div>}
      </div>
    );
  }

  if (working.type === 'tool_use') {
    return (
      <div className="working-item working-tool">
        <span className="working-check">&#10003;</span>
        <span>Queried: <strong>{working.tool_name || working.tool_type}</strong></span>
      </div>
    );
  }

  if (working.type === 'tool_result') {
    return (
      <div className="working-item working-tool-result">
        <button className="working-toggle" onClick={() => setExpanded(!expanded)}>
          <span className={`working-chevron ${expanded ? 'open' : ''}`}>&#9656;</span>
          <span>Result{working.has_results ? `: ${working.row_count} rows` : ''}</span>
        </button>
        {expanded && (
          <div className="working-result-content">
            {working.sql && <pre className="working-sql">{working.sql}</pre>}
            {working.sql_explanation && <p className="working-explanation">{working.sql_explanation}</p>}
          </div>
        )}
      </div>
    );
  }

  return null;
}

function WorkingsPanel({ workings, defaultCollapsed }: { workings: Working[]; defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? true);
  const meaningful = workings.filter((w) => w.type !== 'status' && w.type !== 'analyst_delta');
  if (meaningful.length === 0) return null;

  return (
    <div className="workings-panel">
      <button className="workings-header" onClick={() => setCollapsed(!collapsed)}>
        <span className={`working-chevron ${!collapsed ? 'open' : ''}`}>&#9656;</span>
        <span className="workings-label">Workings</span>
        <span className="workings-count">{meaningful.length}</span>
      </button>
      {!collapsed && (
        <div className="workings-list">
          {meaningful.map((working, idx) => (
            <WorkingItem key={idx} working={working} />
          ))}
        </div>
      )}
    </div>
  );
}

interface ChatPanelProps {
  agent: {
    messages: ChatMessage[];
    loading: boolean;
    sendMessage: (text: string, attachments?: FileAttachment[], onMapFilter?: (filterType: string, filterValue: string) => void) => void;
    clearChat: () => void;
    currentWorkings: Working[];
    streamingText: string;
    currentStatus: string;
    [key: string]: any;
  };
  stats: FleetStats | null;
  activeStats: ActiveStats | null;
  statsLoading: boolean;
  selectedCity: string;
  statusFilter: StatusFilter;
  onStatusFilter: (f: StatusFilter) => void;
  matrixSelection?: MatrixSelection | null;
}

export default function ChatPanel({ agent, stats, activeStats, statsLoading, selectedCity, statusFilter, onStatusFilter, onMapFilter, matrixSelection }: ChatPanelProps) {
  const { messages, loading, sendMessage, clearChat, currentWorkings, streamingText, currentStatus } = agent;
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevSelectionRef = useRef<string | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, currentWorkings, streamingText, currentStatus]);

  const handleMapFilterFromAgent = useCallback((filterType: string, filterValue: string) => {
    const parsed = parseAgentFilter(filterType, filterValue);
    onMapFilter(parsed);
  }, [onMapFilter]);

  useEffect(() => {
    const originHex = matrixSelection?.origin_hex || null;
    if (originHex && originHex !== prevSelectionRef.current && !loading) {
      const ctx = `[Matrix Context: Origin ${matrixSelection!.origin_hex} at Res ${matrixSelection!.resolution}, ` +
        `${matrixSelection!.destinations.length} reachable destinations, ` +
        `max travel time ${(matrixSelection!.max_travel_time_secs / 60).toFixed(1)} min, ` +
        `max distance ${(matrixSelection!.max_distance_meters / 1000).toFixed(1)} km, ` +
        `lat ${matrixSelection!.origin_lat.toFixed(4)}, lon ${matrixSelection!.origin_lon.toFixed(4)}]\n\n` +
        `I selected hexagon ${matrixSelection!.origin_hex} as the origin on the map. ` +
        `It can reach ${matrixSelection!.destinations.length} destinations with a max travel time of ${(matrixSelection!.max_travel_time_secs / 60).toFixed(0)} minutes. ` +
        `What can you tell me about this area?`;
      sendMessage(ctx, undefined, handleMapFilterFromAgent);
    }
    prevSelectionRef.current = originHex;
  }, [matrixSelection?.origin_hex, loading]);

  const handleSend = useCallback((text?: string) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    let enriched = msg;
    if (matrixSelection) {
      const ctx = `[Matrix Context: Origin ${matrixSelection.origin_hex} at Res ${matrixSelection.resolution}, ` +
        `${matrixSelection.destinations.length} reachable destinations, ` +
        `max travel time ${(matrixSelection.max_travel_time_secs / 60).toFixed(1)} min, ` +
        `max distance ${(matrixSelection.max_distance_meters / 1000).toFixed(1)} km, ` +
        `lat ${matrixSelection.origin_lat.toFixed(4)}, lon ${matrixSelection.origin_lon.toFixed(4)}]\n\n`;
      enriched = ctx + msg;
    }
    if (selectedCity && selectedCity !== 'All Cities') {
      enriched = `[City Context: ${selectedCity}]\n\n` + enriched;
    }
    sendMessage(enriched, undefined, handleMapFilterFromAgent);
    if (!text) setInput('');
  }, [input, loading, sendMessage, handleMapFilterFromAgent, matrixSelection, selectedCity]);

  return (
    <div className="chat-container">
      <CompactStats
        stats={stats}
        activeStats={activeStats}
        statsLoading={statsLoading}
        selectedCity={selectedCity}
        statusFilter={statusFilter}
        onStatusFilter={onStatusFilter}
      />
      <div className="chat-messages">
        {messages.length === 0 && !loading && (
          <div>
            <div style={{ fontSize: 13, color: 'var(--sb-text-secondary)', marginBottom: 12 }}>
              Ask the Fleet Intelligence Agent about deliveries, couriers, routes, and restaurant performance. Use the filters above to control what shows on the map.
            </div>
            <div className="quick-questions">
              {QUICK_QUESTIONS.map((q) => (
                <button
                  key={q}
                  className="quick-question"
                  onClick={() => handleSend(q)}
                  disabled={loading}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-message ${msg.role}`}>
            {msg.role === 'assistant' && (
              <div className="message-label">Fleet Intelligence Agent</div>
            )}
            {msg.role === 'assistant' && msg.workings && (
              <WorkingsPanel workings={msg.workings} defaultCollapsed={true} />
            )}
            {msg.role === 'assistant' ? (
              <div className="markdown-content">
                <MarkdownWithCharts content={msg.content} workings={msg.workings} />
              </div>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
            )}
          </div>
        ))}
        {loading && (
          <div className="chat-message assistant">
            <div className="message-label">Fleet Intelligence Agent</div>
            {currentWorkings.length > 0 && (
              <WorkingsPanel workings={currentWorkings} defaultCollapsed={false} />
            )}
            {currentStatus && !streamingText && (
              <div className="working-status-line">
                <span className="working-spinner" />
                <span>{currentStatus}</span>
              </div>
            )}
            {streamingText ? (
              <div className="markdown-content">
                <MarkdownWithCharts content={streamingText} />
                <span className="streaming-cursor" />
              </div>
            ) : (
              !currentWorkings.length && !currentStatus && (
                <div className="loading-dots"><span /><span /><span /></div>
              )
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div className="chat-input-container">
        {messages.length > 0 && (
          <button
            className="chat-clear"
            onClick={clearChat}
            disabled={loading}
            title="Clear chat history"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
        )}
        <input
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Ask about fleet operations..."
          disabled={loading}
        />
        <button className="chat-send" onClick={() => handleSend()} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
