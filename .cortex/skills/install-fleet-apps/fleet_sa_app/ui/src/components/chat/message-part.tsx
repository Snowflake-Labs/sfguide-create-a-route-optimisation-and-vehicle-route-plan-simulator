'use client';

import { useState } from 'react';
import type { MessagePart } from '@/lib/types';
import { inlineRegistry } from '@/lib/inline-registry';
import { matchesTool } from '@/lib/tool-names';
import { isSuppressedResult } from '@/lib/tool-visibility';
import { useAppStore } from '@/lib/store';
import { ApprovalAction } from '@/components/inline/approval-action';
import { ConfirmAction } from '@/components/inline/confirm-action';
import type { Operation } from '@/components/inline/confirm-action';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { stripCitationTags } from '@/lib/chart-citations';
import { roundForDisplay } from '@/lib/format-number';
import { remarkNumberFormat } from '@/lib/remark-number-format';

// Raw tool-result viewer: still a surface a user reads, so numbers are capped at
// the display precision here too. Applied as a JSON replacer rather than a string
// rewrite, so the payload keeps its shape and only the rendered precision changes.
function roundJsonNumbers(key: string, value: unknown): unknown {
  return typeof value === 'number' ? roundForDisplay(value, key) : value;
}

// Tools whose tool_result is suppressed - agent text summarizes these.
// propose_write is NOT in this list: its tool_result is rendered as ConfirmAction.
//
// The list and the payload-shape tests now live in lib/tool-visibility.ts, where
// the harness can drive them. Moved because the version inlined here keyed the
// analyst tools on their tool TYPE (`cortex_analyst_text_to_sql`) while the stream
// sends their NAMES (`query_dwell`, ...13 of them), so it never suppressed
// anything and every analytics turn dumped its whole semantic model into the
// transcript.
function isSuppressedTool(toolName: string, output?: unknown): boolean {
  return isSuppressedResult(toolName, output);
}

// Matches propose_write from MCP (cdp_workflow_mcp_propose_write) or bare name.
function isMcpProposeWrite(toolName: string | undefined): boolean {
  return matchesTool(toolName, 'propose_write');
}

function useDebugMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('debug') === '1';
}

export function MessagePartRenderer({ part }: { part: MessagePart }) {
  const debug = useDebugMode();
  const dismissToolPending = useAppStore((s) => s.dismissToolPending);
  const [confirmCancelled, setConfirmCancelled] = useState(false);

  // MCP propose_write: render ConfirmAction from the pending_confirmation payload.
  // This fires when the /api/mcp handler returns { status: "pending_confirmation", summary, write_payload }.
  if (part.type === 'tool_result' && isMcpProposeWrite(part.toolName)) {
    if (confirmCancelled) return null;
    const out = part.output as Record<string, unknown>;
    if (out?.status === 'pending_confirmation') {
      const wp = (out.write_payload ?? {}) as Record<string, unknown>;
      const fields = (typeof wp.fields === 'object' && wp.fields !== null)
        ? wp.fields as Record<string, unknown>
        : {};
      return (
        <ConfirmAction
          entity={String(wp.entity ?? '')}
          operation={wp.operation as Operation}
          record_id={wp.record_id ? String(wp.record_id) : undefined}
          fields={fields}
          description={out.summary ? String(out.summary) : undefined}
          onCancel={() => setConfirmCancelled(true)}
        />
      );
    }
    // Non-pending_confirmation propose_write results (errors) fall through to normal rendering.
  }

  // If an execute_workflow tool result contains pending_approval, render ApprovalAction
  // instead of suppressing it - this is the mechanical HITL gate UI, no LLM involvement.
  if ((part.type === 'tool_result') &&
      isSuppressedTool(part.toolName) &&
      part.toolName !== undefined &&
      matchesTool(part.toolName, 'execute_workflow')) {
    const pa = (part.output as Record<string, unknown>)?.pending_approval as Record<string, unknown> | undefined;
    if (pa?.instance_id) {
      return (
        <ApprovalAction
          instance_id={String(pa.instance_id)}
          prompt={pa.prompt ? String(pa.prompt) : undefined}
          message={pa.message ? String(pa.message) : undefined}
        />
      );
    }
  }

  // Suppress tool_result/tool_error for workflow and analytics tools whose results
  // the agent narrates directly - the agent text is the user-facing output.
  // The PAYLOAD is passed too, because the analyst tools are recognised by shape
  // (`semantic_model_key`) rather than by name - 13 names in a list would go stale
  // the moment a semantic view is added. `?debug=1` still shows everything.
  if (!debug && (part.type === 'tool_result' || part.type === 'tool_error') &&
      isSuppressedTool(part.toolName, part.type === 'tool_result' ? part.output : undefined)) {
    return null;
  }

  switch (part.type) {
    case 'text':
      return <TextPart content={part.content} />;
    case 'tool_pending':
      return <ToolPending toolName={part.toolName} />;
    case 'tool_result':
      return <ToolResult toolName={part.toolName} output={part.output} />;
    case 'tool_error':
      return <ToolError toolName={part.toolName} error={part.error} />;
    default:
      return null;
  }
}

function TextPart({ content }: { content: string }) {
  const showView = useAppStore((s) => s.showView);
  // Belt and braces: message-list already resolves `<chart>ID</chart>` citations
  // into chart parts, but this is the component that actually renders markdown,
  // and react-markdown carries no rehype-raw - so an unresolved tag would be
  // dropped by the parser with no trace. Strip here too, so any text reaching
  // the renderer through a path that skipped resolution cannot show a raw tag.
  const text = stripCitationTags(content);

  return (
    <div className="markdown-body" style={{ fontSize: '14px', lineHeight: '1.6' }}>
      <ReactMarkdown
        // remarkNumberFormat is the THIRD layer of the decimal policy, and the
        // only one that reaches the agent's own words. The React formatter cannot:
        // an answer's numbers arrive inside a markdown table the model wrote, so
        // a FLOAT sum from a semantic-view fact printed all 17 of its digits.
        remarkPlugins={[remarkGfm, remarkNumberFormat]}
        urlTransform={(url) => (url.startsWith('view:') ? url : defaultUrlTransform(url))}
        components={{
          // A markdown table is the agent's own output format for verb and
          // analyst results (agent-spec.json instructs it to use one), so this
          // is the grid most answers are read in. It needs a bounded, scrollable
          // ancestor: the CSS alone cannot scroll, because the element that
          // overflows and the element with a size are not the same one.
          table: ({ children }) => (
            <div className="markdown-table-scroll">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children }) => {
            if (href?.startsWith('view:') || href?.startsWith('#view:')) {
              const rawId = href.startsWith('view:') ? href.slice(5) : href.slice(6);
              const [viewId, qs] = rawId.split('?');
              const viewState = qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined;
              return (
                <span style={{ display: 'inline-block', margin: '4px 0 12px' }}>
                  <button
                    onClick={() => showView(viewId, viewState)}
                    style={{
                      background: 'var(--surface-secondary, #f0f4ff)',
                      border: '1px solid var(--border-accent, #bfdbfe)',
                      padding: '4px 10px',
                      borderRadius: '6px',
                      color: 'var(--text-accent, #2563eb)',
                      cursor: 'pointer',
                      fontSize: 'inherit',
                      fontWeight: 500,
                    }}
                    title="Open this view in the panel"
                  >
                    {children} →
                  </button>
                </span>
              );
            }
            return <a href={href}>{children}</a>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ToolPending({ toolName }: { toolName: string }) {
  const def = inlineRegistry.get(toolName);

  if (def?.skeleton) {
    const Skeleton = def.skeleton;
    return <Skeleton />;
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderRadius: '8px',
        backgroundColor: 'var(--surface-secondary, #f3f4f6)',
        fontSize: '13px',
        color: 'var(--text-secondary, #6b7280)',
      }}
    >
      <Spinner />
      <span>Running {toolName}...</span>
    </div>
  );
}

function ToolResult({ toolName, output }: { toolName: string; output: Record<string, unknown> }) {
  const def = inlineRegistry.get(toolName);
  // A registered component may still decline THIS payload (see
  // InlineComponentDef.shouldRender), in which case the result is shown rather
  // than replaced by a component that has nothing to draw.
  if (!def || (def.shouldRender && !def.shouldRender(output))) return <JsonViewer data={output} />;
  const Component = def.component;
  return (
    <div style={{ maxHeight: def.maxHeight, overflow: def.maxHeight ? 'auto' : undefined }}>
      <Component {...output} />
    </div>
  );
}

function ToolError({ toolName, error }: { toolName: string; error: string }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        borderRadius: '8px',
        backgroundColor: 'var(--surface-error, #fef2f2)',
        border: '1px solid var(--border-error, #fecaca)',
        fontSize: '13px',
      }}
    >
      <div style={{ fontWeight: 600, color: 'var(--text-error, #dc2626)', marginBottom: '4px' }}>
        {toolName} failed
      </div>
      <div style={{ color: 'var(--text-secondary, #6b7280)' }}>{error}</div>
    </div>
  );
}

function JsonViewer({ data }: { data: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ fontSize: '12px' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: '12px',
          color: 'var(--text-secondary, #6b7280)',
          padding: '4px 0',
        }}
      >
        {expanded ? '▼' : '▶'} Tool result
      </button>
      {expanded && (
        <pre
          style={{
            margin: '4px 0 0',
            padding: '8px',
            borderRadius: '6px',
            backgroundColor: 'var(--surface-secondary, #f3f4f6)',
            overflow: 'auto',
            maxHeight: '200px',
          }}
        >
          {JSON.stringify(data, roundJsonNumbers, 2)}
        </pre>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div
      style={{
        width: '14px',
        height: '14px',
        border: '2px solid var(--border-default, #e5e7eb)',
        borderTopColor: 'var(--text-accent, #2563eb)',
        borderRadius: '50%',
        animation: 'spin 0.6s linear infinite',
      }}
    />
  );
}
