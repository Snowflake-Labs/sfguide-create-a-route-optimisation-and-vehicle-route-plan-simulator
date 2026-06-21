import type { ComponentType, LazyExoticComponent } from 'react';

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
