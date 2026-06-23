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

export interface PanelContext {
  activeView: { id: string; label: string; description: string } | null;
  viewState: Record<string, unknown>;
  availableViews: Array<{ label: string; description: string }>;
  context: Record<string, unknown>;
  hasUnsavedChanges: boolean;
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
  component: LazyExoticComponent<ComponentType<ViewProps>>;
  hidden?: boolean;
  icon?: string;
  tags?: string[];
  category?: string;
  // Minimum role tiers allowed to see this view (simulated client-side filter).
  // Omitted => visible to all roles. Honors hierarchy admin > ops > user.
  roles?: AppRole[];
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
