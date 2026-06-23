'use client';

import { useState } from 'react';
import type { MessagePart } from '@/lib/types';
import { inlineRegistry } from '@/lib/inline-registry';
import { useAppStore } from '@/lib/store';
import { ApprovalAction } from '@/components/inline/approval-action';
import { ConfirmAction } from '@/components/inline/confirm-action';
import type { Operation } from '@/components/inline/confirm-action';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Tools whose tool_result is suppressed — agent text summarizes these.
// propose_write is NOT in this list: its tool_result is rendered as ConfirmAction.
const SUPPRESS_RESULT_SUFFIXES = ['execute_workflow', 'resume_workflow', 'cortex_analyst_text_to_sql'];
function isSuppressedTool(toolName: string): boolean {
  return SUPPRESS_RESULT_SUFFIXES.some((s) => toolName === s || toolName.endsWith('__' + s));
}

// Matches propose_write from MCP (cdp_workflow_mcp__propose_write) or bare name.
function isMcpProposeWrite(toolName: string | undefined): boolean {
  return !!toolName && (toolName === 'propose_write' || toolName.endsWith('__propose_write'));
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
  // instead of suppressing it — this is the mechanical HITL gate UI, no LLM involvement.
  if ((part.type === 'tool_result') &&
      isSuppressedTool(part.toolName) &&
      part.toolName !== undefined &&
      (part.toolName === 'execute_workflow' || part.toolName.endsWith('__execute_workflow'))) {
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
  // the agent narrates directly — the agent text is the user-facing output.
  if (!debug && (part.type === 'tool_result' || part.type === 'tool_error') &&
      isSuppressedTool(part.toolName)) {
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

  return (
    <div className="markdown-body" style={{ fontSize: '14px', lineHeight: '1.6' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (url.startsWith('view:') ? url : defaultUrlTransform(url))}
        components={{
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
        {content}
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
  if (!def) return <JsonViewer data={output} />;
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
          {JSON.stringify(data, null, 2)}
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
