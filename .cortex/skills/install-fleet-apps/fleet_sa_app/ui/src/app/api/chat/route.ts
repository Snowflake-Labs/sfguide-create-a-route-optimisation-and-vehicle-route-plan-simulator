import { NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { getAgentConfig, buildCortexUrl, buildCortexRequestBody } from '@/lib/agent-config';
import { parseCortexStream } from '@/lib/cortex-stream';
import type { MessagePart } from '@/lib/types';

export async function POST(request: NextRequest) {
  const reqId = crypto.randomUUID().slice(0, 8);
  const start = Date.now();
  logger.info('api-req', { method: 'POST', path: '/api/chat', reqId });
  const body = await request.json();
  const userMessage = body.message as string;
  const threadId = body.threadId as number | undefined;
  const parentMessageId = body.parentMessageId as number | undefined;
  const history = (body.history || []) as Array<{ role: string; content: string }>;
  const panelContext = body.panelContext as Record<string, unknown> | undefined;

  const config = getAgentConfig();
  const url = buildCortexUrl(config);

  let contextPrefix = '';
  const availableViews = (panelContext?.availableViews || []) as Array<{ id: string; label: string; description: string }>;
  if (panelContext?.activeView) {
    const view = panelContext.activeView as { id: string; label: string; description: string };
    const parts = [`[Panel context: Currently showing "${view.label}" (${view.description}).`];
    const vs = panelContext.viewState as Record<string, unknown> | undefined;
    if (vs && Object.keys(vs).length > 0) {
      const activeFilters = Object.entries(vs)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (activeFilters) parts.push(`Active filters: ${activeFilters}.`);
    }
    parts.push('Use this context when the user asks about their data, campaigns, performance, or anything the view relates to. Do NOT use it only if the question is clearly about a different topic entirely. When you use the view context, start with "Looking at [view name] (filtered by [active filters]):" matching exactly what the context chip shows. Do NOT suggest or mention any other views in your response.]');
    contextPrefix = parts.join(' ') + '\n\n';
  }
  if (availableViews.length > 0) {
    const viewLinks = availableViews
      .map((v) => `  [${v.label}](view:${v.id}) — ${v.description}`)
      .join('\n');
    contextPrefix += `[Available panel views — use the exact markdown link format below when your response would benefit from the user exploring data or taking action in the UI:\n${viewLinks}\n\nInclude a view link when: the question is about data that view surfaces, the user could take a useful action in the view, or the answer alone leaves the user without an obvious next step. Do not include links for general or conceptual questions. One or two links per response at most. Always use the markdown link format — never plain text view names.]\n\n`;
  } else if (contextPrefix) {
    contextPrefix += '\n';
  }

  // Active dashboard context (region / vehicle / dataset / date range) so the
  // agent can state its scope and default routing args. The legacy control app
  // injected an equivalent hidden turn; the SA app discarded panelContext.context
  // until now. Routing verbs default region/profile to the active context when
  // the user does not name a place; the analytics views are already scoped, but
  // this lets the agent name its region and pick the right routing defaults.
  const activeCtx = (panelContext?.context || {}) as Record<string, unknown>;
  const ctxBits: string[] = [];
  if (activeCtx.region) ctxBits.push(`region = ${activeCtx.region}`);
  if (activeCtx.vehicle_type) ctxBits.push(`vehicle type = ${activeCtx.vehicle_type}`);
  if (activeCtx.dataset_id) ctxBits.push(`dataset = ${activeCtx.dataset_id}`);
  if (activeCtx.date_range_start || activeCtx.date_range_end) {
    ctxBits.push(`date range = ${activeCtx.date_range_start ?? 'any'}..${activeCtx.date_range_end ?? 'any'}`);
  }
  let activeContextPrefix = '';
  if (ctxBits.length > 0) {
    activeContextPrefix =
      `[Active context: ${ctxBits.join('; ')}. ` +
      `When a routing tool needs a region or profile and the user did not name one, default to this region and vehicle. ` +
      `State the active region when it is relevant to your answer. Do not override an explicit place the user names.]\n\n`;
  }

  const cortexMessages = [
    ...history.map((m: { role: string; content: string }) => ({
      role: m.role,
      content: [{ type: 'text', text: m.content }],
    })),
    {
      role: 'user',
      content: [{ type: 'text', text: activeContextPrefix + contextPrefix + userMessage }],
    },
  ];

  const cortexBody = buildCortexRequestBody(config, cortexMessages, threadId, parentMessageId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const cortexResponse = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${config.token}`,
            'X-Snowflake-Authorization-Token-Type': config.tokenType,
          },
          body: JSON.stringify(cortexBody),
        });

        if (!cortexResponse.ok) {
          const errorText = await cortexResponse.text();
          const errorPart: MessagePart = {
            type: 'tool_error',
            toolName: 'system',
            error: `Cortex API error ${cortexResponse.status}: ${errorText}`,
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPart)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        await parseCortexStream(cortexResponse, {
          onPart: (part: MessagePart) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`));
          },
          onStatus: (status: string, message: string) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'status', status, message })}\n\n`),
            );
          },
          onMetadata: (metadata) => {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'metadata', ...metadata })}\n\n`),
            );
          },
          onError: (error: string) => {
            const errorPart: MessagePart = { type: 'tool_error', toolName: 'system', error };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPart)}\n\n`));
          },
          onDone: () => {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
      } catch (err) {
        logger.error('chat-stream-error', { reqId, ms: Date.now() - start }, err);
        const errorPart: MessagePart = {
          type: 'tool_error',
          toolName: 'system',
          error: err instanceof Error ? err.message : 'Connection failed',
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorPart)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  logger.info('api-res', { method: 'POST', path: '/api/chat', status: 200, ms: Date.now() - start, reqId, streaming: true });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
