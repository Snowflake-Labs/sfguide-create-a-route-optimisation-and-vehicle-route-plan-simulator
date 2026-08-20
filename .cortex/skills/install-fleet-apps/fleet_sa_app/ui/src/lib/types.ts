import type { ComponentType, LazyExoticComponent } from 'react';
import type { AppRole } from './roles';

export type { AppRole };

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'tool_pending'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolName: string; output: Record<string, unknown> }
  | { type: 'tool_error'; toolName: string; error: string }
  | { type: 'status'; status: string; message: string }
  | { type: 'metadata'; threadId?: number; assistantMessageId?: number; runId?: string };

// Per-view grounding hint fed to the chat agent (config-authored in app-views.json).
// Thin routing + framing layer only - domain SQL / metric definitions live in the
// semantic views, never here. Every field is optional; an absent block leaves the
// agent context prefix unchanged.
export interface AgentKnowledge {
  // Cortex Analyst / MCP tool the agent should prefer when this view is active.
  preferredTool?: string;
  // Metrics/columns that matter on this view (plain-language phrases).
  keyMetrics?: string[];
  // Representative questions a user is likely to ask here.
  exampleQuestions?: string[];
  // Caveats the agent should know (e.g. how a metric is derived).
  gotchas?: string;
}

// Compact summary of one rendered map layer, surfaced to the chat agent so it can
// reason about what is actually on screen (counts, blank layers) instead of guessing.
// Carries only scalar metadata - never per-feature rows - so it stays cheap and safe.
export interface MapLayerDescriptor {
  // Stable layer id (spec id, or spec-layer-<index> fallback).
  id: string;
  // Layer kind: scatterplot | path | h3 | geojson | arc.
  type: string;
  // Rows fetched for this layer's query under the current scope/filters.
  featureCount: number;
  // Column driving per-feature color, when the layer colors by a data column.
  colorBy?: string;
  // True when the layer compiled to a visible deck.gl layer (non-empty rows).
  rendered: boolean;
  // True when a visibleWhen toggle is currently hiding the layer.
  gated?: boolean;
}

// Snapshot of the map area currently open, folded into panel context for the agent.
export interface MapStateDescriptor {
  layerCount: number;
  layers: MapLayerDescriptor[];
  // Ids of layers that show nothing right now (zero rows or gated off).
  emptyLayers: string[];
  // Framed extent as [minLng, minLat, maxLng, maxLat].
  bbox?: [number, number, number, number];
  // Active selection keys -> values (map anchor / clicked object).
  selection?: Record<string, unknown>;
  // Attributes of the feature the user clicked (bounded, scalar-only). This one
  // picked row is the deliberate exception to the layer-level "never per-feature
  // rows" rule; present only while a map-picked selection is active and still
  // matches the anchor value.
  selectedFeature?: { key: string; value: unknown; attrs: Record<string, string | number | boolean> };
  // Legend item labels, in order.
  legend?: string[];
}

export interface PanelContext {
  activeView: { id: string; label: string; description: string; agentKnowledge?: AgentKnowledge } | null;
  viewState: Record<string, unknown>;
  availableViews: Array<{ label: string; description: string }>;
  context: Record<string, unknown>;
  hasUnsavedChanges: boolean;
  // Present only when a map area is open; null otherwise.
  mapState?: MapStateDescriptor | null;
}

export interface ViewProps {
  viewState: Record<string, unknown>;
  onStateChange: (patch: Record<string, unknown>) => void;
  onSave: () => void;
  onDirty: (isDirty: boolean) => void;
}

export interface ViewDef {
  id: string;
  label: string;
  description: string;
  // Optional markdown shown in the per-view info overlay ("i" button).
  info?: string;
  component: LazyExoticComponent<ComponentType<ViewProps>>;
  hidden?: boolean;
  icon?: string;
  tags?: string[];
  category?: string;
  // Minimum role tiers allowed to see this view (simulated client-side filter).
  // Omitted => visible to all roles. Honors hierarchy admin > ops > user.
  roles?: AppRole[];
  // Optional per-view grounding hint surfaced to the chat agent via panel context.
  agentKnowledge?: AgentKnowledge;
}

// Zero-code retargeting surface (agnostic-view report section 6.3). Every field is
// a neutral token -> domain value map so a domain swap is a config edit, never a code
// change. Consumed by the UI display resolver (useDisplayConfig) + metric-cards.
export interface DisplayThreshold {
  good?: number;
  warn?: number;
  critical?: number;
  // When true a higher value is better (utilization), else lower is better (dwell).
  higherIsBetter?: boolean;
}

export interface DisplayStatusValue {
  label: string;
  color?: string;
}

export interface DisplayConfig {
  // Neutral noun/metric token -> domain label. Resolver interpolates {{labels.x}}.
  labels?: Record<string, string>;
  // Neutral measure token -> unit suffix (e.g. distance -> "km", speed -> "km/h").
  units?: Record<string, string>;
  // metric_name -> threshold bands for KPI coloring (mirrors DIM_METRIC_DEFINITION,
  // UI-overridable). Keyed by the neutral metric name.
  thresholds?: Record<string, DisplayThreshold>;
  // enum field -> value -> { label, color }. Drives status chips/legends.
  statusEnums?: Record<string, Record<string, DisplayStatusValue>>;
  // entity_type / icon key -> icon name (map markers, legends).
  icons?: Record<string, string>;
  // named window -> token (e.g. operations -> last_7_days). Per-persona defaults.
  defaultWindows?: Record<string, string>;
}

// Centralized view styling surface (app-config.json "style" block). Drives row
// heights ($kpi/$content/$map/$heroMap tokens in app-views.json), chart palette,
// and table density. All fields optional; consumers fall back to bundled defaults
// (see style-config.ts), so a config without "style" renders the legacy look.
export interface StyleConfig {
  // Token name -> pixel height (e.g. content -> 360, map -> 440).
  rowHeights?: Record<string, number>;
  // Chart series colors, in order.
  chart?: { palette?: string[] };
  // Table row caps: default for triage tables, board for denser boards.
  table?: { defaultMaxRows?: number; boardMaxRows?: number };
}

export interface InlineComponentDef<TProps = Record<string, unknown>> {
  toolName: string;
  component: ComponentType<TProps>;
  skeleton?: ComponentType;
  maxHeight?: number;
}

export interface ContextBarField {
  id: string;
  type: 'date_range' | 'entity_picker' | 'enum' | 'text';
  label: string;
  default: unknown;
  source?: string;
  labelField?: string;
  valueField?: string;
}

export interface UserPreferences {
  defaultViewId?: string;
  contextBarDefaults?: Record<string, unknown>;
  collapsedOverview?: boolean;
  [key: string]: unknown;
}

export interface AgentClientConfig {
  cortexEndpoint: string;
  model: string;
  baseSystemPrompt: string;
  tools: ToolDef[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'thinking' | 'error';
