import { create } from 'zustand';
import { temporal } from 'zundo';
import type { Message, MessagePart, PanelContext, ChatStatus, AppRole } from './types';
import { viewRegistry } from './view-registry';

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
}

interface AppState {
  chat: ChatSlice;
  panel: PanelSlice;
  context: Record<string, unknown>;
  viewsVersion: number;
  viewContextEnabled: boolean;
  snowflakeFqn: string | null;
  abortController: AbortController | null;
  // Simulated role-evaluation state. `selectedRole` drives which views/capabilities
  // the UI surfaces; `detectedRole` is the user's real role from /api/whoami (hint only).
  selectedRole: AppRole;
  detectedRole: AppRole | null;
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
  updateViewState: (patch: Record<string, unknown>) => void;
  setDirty: (isDirty: boolean) => void;
  setContext: (key: string, value: unknown) => void;
  getPanelContext: () => PanelContext;
  bumpViewsVersion: () => void;
  setViewContextEnabled: (enabled: boolean) => void;
  dismissToolPending: (toolName: string, entityKey: string) => void;
  setSnowflakeFqn: (fqn: string) => void;
  setSelectedRole: (role: AppRole) => void;
  setDetectedRole: (role: AppRole) => void;
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
      },
      context: {},
      viewsVersion: 0,
      viewContextEnabled: true,
      snowflakeFqn: null,
      abortController: null,
      selectedRole: 'admin' as AppRole,
      detectedRole: null,

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
        // propose_write is now served via CDP_WORKFLOW_MCP — tool name is cdp_workflow_mcp__propose_write.
        // ConfirmAction renders from tool_result (pending_confirmation payload), not tool_pending.
        const isMcpProposeWrite = (n: string | undefined) =>
          !!n && (n === 'propose_write' || n.endsWith('__propose_write'));

        // Tools whose tool_result means data was written — bump views so the panel auto-refreshes.
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
              } catch {
                // skip malformed chunks
              }
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
          },
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

      setSelectedRole: (role: AppRole) => {
        set({ selectedRole: role });
        // Re-filter the view-picker (its memo depends on viewsVersion).
        get().bumpViewsVersion();
      },

      setDetectedRole: (role: AppRole) => {
        set({ detectedRole: role });
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
          return { activeView: null, viewState: {}, availableViews: [], context, hasUnsavedChanges: false };
        }
        let activeView = null;
        if (panel.activeViewId) {
          const def = viewRegistry.get(panel.activeViewId);
          activeView = {
            id: panel.activeViewId,
            label: def?.label || panel.activeViewId,
            description: def?.description || '',
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
        };
      },
    }),
    {
      partialize: (state) => ({ panel: state.panel }),
      limit: 50,
    },
  ),
);
