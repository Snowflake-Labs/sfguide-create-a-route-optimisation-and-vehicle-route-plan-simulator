import { create } from 'zustand';
import { temporal } from 'zundo';
import type { Message, MessagePart, PanelContext, MapStateDescriptor, ChatStatus, AppRole, DisplayConfig, StyleConfig } from './types';
import { viewRegistry } from './view-registry';
import { registerDynamicView } from './load-views';
import { parseDynamicSpec } from './view-spec-schema';

// Build a graceful fallback message when a stream ends with no usable text part
// (e.g. the agent gave up after a failed/blocked tool call). Derives a short
// reason from the last tool error so the user is never left with a blank turn.
function synthesizeNoTextFallback(parts: MessagePart[]): string {
  let reason = '';
  for (const p of parts) {
    if (p.type === 'tool_error' && p.error) {
      reason = p.error;
    } else if (p.type === 'tool_result') {
      const err = (p.output as { error?: unknown })?.error;
      if (err) {
        reason =
          typeof err === 'string'
            ? err
            : String((err as { message?: unknown })?.message ?? '') || reason;
      }
    }
  }
  const base =
    "I wasn't able to produce a response for that. The analytics tools couldn't answer it as asked";
  return reason
    ? `${base}: ${reason}. Try rephrasing, or ask about what's currently shown on the dashboard.`
    : `${base}. Try rephrasing, or ask about what's currently shown on the dashboard.`;
}


interface ChatSlice {
  messages: Message[];
  status: ChatStatus;
  statusMessage: string | null;
  error: string | null;
  sessionId: string;
  suggestions: string[];
  threadId: number | undefined;
  parentMessageId: number | undefined;
}

interface PanelSlice {
  activeViewId: string | null;
  viewState: Record<string, unknown>;
  hasUnsavedChanges: boolean;
  // Summary of the map area currently open (null when no map is mounted).
  mapState: MapStateDescriptor | null;
}

interface AppState {
  chat: ChatSlice;
  panel: PanelSlice;
  context: Record<string, unknown>;
  viewsVersion: number;
  viewContextEnabled: boolean;
  snowflakeFqn: string | null;
  abortController: AbortController | null;
  // Zero-code retargeting surface from app-config.json (labels/units/thresholds).
  displayConfig: DisplayConfig | null;
  // Centralized view styling surface from app-config.json (row heights/palette/density).
  styleConfig: StyleConfig | null;
  // Simulated role-evaluation state. `selectedRole` drives which views/capabilities
  // the UI surfaces; `detectedRole` is the user's real role from /api/whoami (hint only).
  selectedRole: AppRole;
  detectedRole: AppRole | null;
  // Resolved FLEET_ADMIN_APP URL (admins only, from /api/admin-link); null hides
  // the header cross-link.
  adminAppUrl: string | null;
}

interface AppActions {
  sendMessage: (text: string) => Promise<void>;
  abortStreaming: () => void;
  addUserMessage: (text: string) => void;
  addAssistantMessage: () => string;
  appendAssistantPart: (messageId: string, part: MessagePart) => void;
  setChatStatus: (status: ChatStatus) => void;
  setChatError: (error: string | null) => void;
  setSuggestions: (suggestions: string[]) => void;
  showView: (viewId: string, state?: Record<string, unknown>) => void;
  showDynamicView: (raw: unknown, title?: string | null) => void;
  updateViewState: (patch: Record<string, unknown>) => void;
  setMapState: (mapState: MapStateDescriptor | null) => void;
  setDirty: (isDirty: boolean) => void;
  setContext: (key: string, value: unknown) => void;
  getPanelContext: () => PanelContext;
  bumpViewsVersion: () => void;
  setViewContextEnabled: (enabled: boolean) => void;
  dismissToolPending: (toolName: string, entityKey: string) => void;
  setSnowflakeFqn: (fqn: string) => void;
  setSelectedRole: (role: AppRole) => void;
  setDetectedRole: (role: AppRole) => void;
  setAdminAppUrl: (url: string | null) => void;
  setDisplayConfig: (cfg: DisplayConfig | null) => void;
  setStyleConfig: (cfg: StyleConfig | null) => void;
}

export type AppStore = AppState & AppActions;

let messageCounter = 0;
function generateId(): string {
  return `msg_${Date.now()}_${++messageCounter}`;
}

export const useAppStore = create<AppStore>()(
  temporal(
    (set, get) => ({
      chat: {
        messages: [],
        status: 'ready' as ChatStatus,
        statusMessage: null,
        error: null,
        sessionId: crypto.randomUUID(),
        suggestions: [],
        threadId: undefined,
        parentMessageId: undefined,
      },
      panel: {
        activeViewId: null,
        viewState: {},
        hasUnsavedChanges: false,
        mapState: null,
      },
      context: {},
      viewsVersion: 0,
      viewContextEnabled: true,
      snowflakeFqn: null,
      abortController: null,
      displayConfig: null,
      styleConfig: null,
      selectedRole: 'admin' as AppRole,
      detectedRole: null,
      adminAppUrl: null,

      addUserMessage: (text: string) => {
        const msg: Message = {
          id: generateId(),
          role: 'user',
          parts: [{ type: 'text', content: text }],
          timestamp: Date.now(),
        };
        set((s) => ({ chat: { ...s.chat, messages: [...s.chat.messages, msg] } }));
      },

      addAssistantMessage: () => {
        const msg: Message = {
          id: generateId(),
          role: 'assistant',
          parts: [],
          timestamp: Date.now(),
        };
        set((s) => ({ chat: { ...s.chat, messages: [...s.chat.messages, msg] } }));
        return msg.id;
      },

      appendAssistantPart: (messageId: string, part: MessagePart) => {
        // propose_write is now served via CDP_WORKFLOW_MCP - tool name is cdp_workflow_mcp__propose_write.
        // ConfirmAction renders from tool_result (pending_confirmation payload), not tool_pending.
        const isMcpProposeWrite = (n: string | undefined) =>
          !!n && (n === 'propose_write' || n.endsWith('__propose_write'));

        // Tools whose tool_result means data was written - bump views so the panel auto-refreshes.
        // Also bump when a confirmed propose_write lands (handled in message-part.tsx confirm flow directly).
        const WRITE_TOOLS = new Set(['execute_workflow', 'resume_workflow']);
        const isWriteTool = (n: string | undefined) =>
          !!n && (WRITE_TOOLS.has(n) || Array.from(WRITE_TOOLS).some(w => n.endsWith('__' + w)));

        // Bump view version when workflow tools complete so the panel reflects new entities immediately
        if (part.type === 'tool_result' && isWriteTool(part.toolName)) {
          get().bumpViewsVersion();
        }

        set((s) => ({
          chat: {
            ...s.chat,
            messages: s.chat.messages.map((m) => {
              if (m.id !== messageId) return m;
              let parts = m.parts;

              // When agent text arrives, push any pending propose_write tool_pending to after it
              // so the ConfirmAction (rendered from tool_result) always appears below agent text.
              if (part.type === 'text') {
                const pendingAfterText = parts.filter(
                  (p) => p.type === 'tool_pending' && isMcpProposeWrite((p as { type: string; toolName: string }).toolName),
                );
                parts = parts.filter(
                  (p) => !(p.type === 'tool_pending' && isMcpProposeWrite((p as { type: string; toolName: string }).toolName)),
                );
                return { ...m, parts: [...parts, part, ...pendingAfterText] };
              }

              // Replace pending with result for the same tool
              if (part.type === 'tool_result' || part.type === 'tool_error') {
                parts = parts.filter(
                  (p) => !(p.type === 'tool_pending' && p.toolName === part.toolName),
                );
              }

              return { ...m, parts: [...parts, part] };
            }),
          },
        }));
      },

      setChatStatus: (status: ChatStatus) => {
        set((s) => ({ chat: { ...s.chat, status } }));
      },

      setChatError: (error: string | null) => {
        set((s) => ({ chat: { ...s.chat, error, status: error ? 'error' : s.chat.status } }));
      },

      setSuggestions: (suggestions: string[]) => {
        set((s) => ({ chat: { ...s.chat, suggestions } }));
      },

      abortStreaming: () => {
        const controller = get().abortController;
        if (controller) controller.abort();
        set((s) => ({ chat: { ...s.chat, status: 'ready' as ChatStatus }, abortController: null }));
      },

      sendMessage: async (text: string) => {
        const { addUserMessage, addAssistantMessage, appendAssistantPart, setChatStatus, setChatError, setSuggestions, getPanelContext } = get();

        const controller = new AbortController();
        set({ abortController: controller });

        const history = get().chat.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({
            role: m.role,
            content: m.parts
              .filter((p) => p.type === 'text')
              .map((p) => (p as { type: 'text'; content: string }).content)
              .join('\n'),
          }))
          .filter((m) => m.content);

        addUserMessage(text);
        setChatStatus('submitted');
        setSuggestions([]);
        set((s) => ({ chat: { ...s.chat, statusMessage: null } }));

        try {
          const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              message: text,
              panelContext: getPanelContext(),
              history,
              threadId: get().chat.threadId,
              parentMessageId: get().chat.parentMessageId,
            }),
          });

          if (!res.ok) throw new Error(`Chat request failed: ${res.status}`);
          if (!res.body) throw new Error('No response body');

          setChatStatus('streaming');
          const assistantId = addAssistantMessage();
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') continue;

              try {
                const part = JSON.parse(data) as MessagePart;

                if (part.type === 'metadata') {
                  const meta = part as { type: 'metadata'; threadId?: number; assistantMessageId?: number };
                  set((s) => ({
                    chat: {
                      ...s.chat,
                      threadId: meta.threadId ?? s.chat.threadId,
                      parentMessageId: meta.assistantMessageId ?? s.chat.parentMessageId,
                    },
                  }));
                  continue;
                }

                if (part.type === 'status') {
                  const statusPart = part as { type: 'status'; status: string; message: string };
                  set((s) => ({ chat: { ...s.chat, statusMessage: statusPart.message } }));
                  continue;
                }

                appendAssistantPart(assistantId, part);

                if (part.type === 'tool_result' && part.toolName === 'show_view') {
                  const output = part.output as { viewId?: string; state?: Record<string, unknown> };
                  if (output.viewId) {
                    get().showView(output.viewId, output.state);
                  }
                }

                // render_view (synapse verb on ROUTING_MCP): the tool_result output is
                // the agent-emitted view spec. Validate + register as an ephemeral page.
                if (
                  part.type === 'tool_result' &&
                  (part.toolName === 'render_view' || part.toolName.endsWith('__render_view'))
                ) {
                  const output = part.output as { result?: unknown; title?: string } | undefined;
                  get().showDynamicView(output?.result ?? output, output?.title ?? null);
                }
              } catch {
                // skip malformed chunks
              }
            }
          }

          // Defensive: never leave the user staring at a blank turn. If the
          // stream ended with no non-empty text part, synthesize a graceful
          // message derived from the last tool error when present.
          {
            const msg = get().chat.messages.find((m) => m.id === assistantId);
            const hasText = !!msg?.parts.some(
              (p) => p.type === 'text' && p.content.trim() !== '',
            );
            if (msg && !hasText) {
              appendAssistantPart(assistantId, {
                type: 'text',
                content: synthesizeNoTextFallback(msg.parts),
              });
            }
          }

          set((s) => ({ chat: { ...s.chat, statusMessage: null } }));
          setChatStatus('ready');
        } catch (err) {
          setChatError(err instanceof Error ? err.message : 'Unknown error');
        }
      },

      showView: (viewId: string, state?: Record<string, unknown>) => {
        set((s) => ({
          panel: {
            ...s.panel,
            activeViewId: viewId,
            viewState: state ?? {},
            hasUnsavedChanges: false,
            // Drop the prior view's map summary so a table-only view does not
            // inherit stale map context; the map area re-reports on mount.
            mapState: null,
          },
        }));
      },

      // Validate + register an agent-emitted spec as the single ephemeral page,
      // then open it. Invalid specs surface a chat error instead of rendering
      // (or silently dropping) malformed/untrusted content.
      showDynamicView: (raw: unknown, title?: string | null) => {
        const parsed = parseDynamicSpec(raw);
        if (!parsed.ok) {
          set((s) => ({
            chat: { ...s.chat, error: `Generated view was invalid: ${parsed.errors[0]}` },
          }));
          return;
        }
        if (title && title.trim() !== '') {
          parsed.spec.label = title.slice(0, 200);
        }
        const id = registerDynamicView(parsed.spec);
        set((s) => ({
          viewsVersion: s.viewsVersion + 1,
          panel: { ...s.panel, activeViewId: id, viewState: {}, hasUnsavedChanges: false, mapState: null },
        }));
      },

      updateViewState: (patch: Record<string, unknown>) => {
        set((s) => ({
          panel: {
            ...s.panel,
            viewState: { ...s.panel.viewState, ...patch },
          },
        }));
      },

      // Map area reports a compact summary of what it rendered (layer counts,
      // blank layers, framed extent, selection) for the chat agent's context.
      setMapState: (mapState: MapStateDescriptor | null) => {
        set((s) => ({ panel: { ...s.panel, mapState } }));
      },

      setDirty: (isDirty: boolean) => {
        set((s) => ({ panel: { ...s.panel, hasUnsavedChanges: isDirty } }));
      },

      setContext: (key: string, value: unknown) => {
        set((s) => ({ context: { ...s.context, [key]: value } }));
      },

      bumpViewsVersion: () => {
        set((s) => ({ viewsVersion: s.viewsVersion + 1 }));
      },

      setViewContextEnabled: (enabled: boolean) => {
        set({ viewContextEnabled: enabled });
      },

      setSnowflakeFqn: (fqn: string) => {
        set({ snowflakeFqn: fqn });
      },

      setDisplayConfig: (cfg: DisplayConfig | null) => {
        set({ displayConfig: cfg });
      },

      setStyleConfig: (cfg: StyleConfig | null) => {
        set({ styleConfig: cfg });
      },

      setSelectedRole: (role: AppRole) => {
        set({ selectedRole: role });
        // Re-filter the view-picker (its memo depends on viewsVersion).
        get().bumpViewsVersion();
      },

      setDetectedRole: (role: AppRole) => {
        set({ detectedRole: role });
      },
      setAdminAppUrl: (url: string | null) => {
        set({ adminAppUrl: url });
      },

      dismissToolPending: (toolName: string, entityKey: string) => {
        set((s) => ({
          chat: {
            ...s.chat,
            messages: s.chat.messages.map((m) => ({
              ...m,
              parts: m.parts.filter((p) => {
                if (p.type !== 'tool_pending') return true;
                const tp = p as { type: 'tool_pending'; toolName: string; input?: Record<string, unknown> };
                if (tp.toolName !== toolName) return true;
                const key = tp.input ? `${tp.input.entity}:${tp.input.operation}` : null;
                return key !== entityKey;
              }),
            })),
          },
        }));
      },

      getPanelContext: (): PanelContext => {
        const { panel, context, viewContextEnabled, selectedRole } = get();
        if (!viewContextEnabled) {
          return { activeView: null, viewState: {}, availableViews: [], context, hasUnsavedChanges: false, mapState: null };
        }
        let activeView = null;
        if (panel.activeViewId) {
          const def = viewRegistry.get(panel.activeViewId);
          activeView = {
            id: panel.activeViewId,
            label: def?.label || panel.activeViewId,
            description: def?.description || '',
            agentKnowledge: def?.agentKnowledge,
          };
        }
        const availableViews = viewRegistry.list(selectedRole).map((v: { id: string; label: string; description: string }) => ({
          id: v.id,
          label: v.label,
          description: v.description,
        }));
        return {
          activeView,
          viewState: panel.viewState,
          availableViews,
          context,
          hasUnsavedChanges: panel.hasUnsavedChanges,
          mapState: panel.mapState,
        };
      },
    }),
    {
      partialize: (state) => ({ panel: state.panel }),
      limit: 50,
    },
  ),
);
