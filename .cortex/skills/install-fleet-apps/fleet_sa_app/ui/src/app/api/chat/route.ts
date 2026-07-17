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
    const view = panelContext.activeView as {
      id: string;
      label: string;
      description: string;
      agentKnowledge?: {
        preferredTool?: string;
        keyMetrics?: string[];
        exampleQuestions?: string[];
        gotchas?: string;
      };
    };
    const parts = [`[Panel context: Currently showing "${view.label}" (${view.description}).`];
    const vs = panelContext.viewState as Record<string, unknown> | undefined;
    if (vs && Object.keys(vs).length > 0) {
      // Keys prefixed __memo_ carry bounded, pre-joined KPI/metric strings that an
      // area published for the agent (Gap 1). Render them under their own label so
      // headline metric values are not mislabeled as active filters.
      const entries = Object.entries(vs).filter(([, v]) => v != null);
      const memoEntries = entries.filter(([k]) => k.startsWith('__memo_'));
      const filterEntries = entries.filter(([k]) => !k.startsWith('__memo_'));
      const activeFilters = filterEntries.map(([k, v]) => `${k}=${v}`).join(', ');
      if (activeFilters) parts.push(`Active filters: ${activeFilters}.`);
      if (memoEntries.length) {
        const memoText = memoEntries
          .map(([k, v]) => {
            const group = k.slice('__memo_'.length);
            return memoEntries.length > 1 ? `${group}: ${v}` : String(v);
          })
          .join(' | ');
        parts.push(`On-screen metric values: ${memoText}.`);
      }
    }
    const ak = view.agentKnowledge;
    if (ak) {
      if (ak.preferredTool) parts.push(`Prefer the "${ak.preferredTool}" tool for questions about this view.`);
      if (ak.keyMetrics?.length) parts.push(`Key metrics here: ${ak.keyMetrics.join('; ')}.`);
      if (ak.exampleQuestions?.length) parts.push(`Typical questions: ${ak.exampleQuestions.join(' / ')}.`);
      if (ak.gotchas) parts.push(`Note: ${ak.gotchas}`);
    }
    parts.push('Use this context when the user asks about their data, campaigns, performance, or anything the view relates to. Do NOT use it only if the question is clearly about a different topic entirely. When you use the view context, start with "Looking at [view name] (filtered by [active filters]):" matching exactly what the context chip shows. Do NOT suggest or mention any other views in your response.]');
    contextPrefix = parts.join(' ') + '\n\n';
  }

  // Map awareness: summarize what the open map area is actually rendering (layer
  // counts, blank layers, framed extent, selection) so the agent answers about
  // what is on screen and diagnoses blank layers instead of inventing features.
  const mapState = panelContext?.mapState as {
    layerCount?: number;
    layers?: Array<{ id: string; type: string; featureCount: number; colorBy?: string; rendered: boolean; gated?: boolean }>;
    emptyLayers?: string[];
    bbox?: [number, number, number, number];
    selection?: Record<string, unknown>;
    selectedFeature?: { key: string; value: unknown; attrs: Record<string, string | number | boolean> };
    legend?: string[];
  } | undefined;
  if (mapState && (mapState.layerCount ?? 0) > 0 && Array.isArray(mapState.layers)) {
    const layerLines = mapState.layers.slice(0, 8).map((l) => {
      const bits = [`${l.type}`, `${l.featureCount} features`];
      if (l.colorBy) bits.push(`color by ${l.colorBy}`);
      if (l.gated) bits.push('HIDDEN (toggle off)');
      else if (!l.rendered || l.featureCount === 0) bits.push('BLANK (no data)');
      return `${l.id} (${bits.join(', ')})`;
    });
    const mapParts = [`[Map on screen: ${mapState.layerCount} layer(s). ${layerLines.join('; ')}.`];
    if (mapState.emptyLayers?.length) mapParts.push(`Blank/empty layers: ${mapState.emptyLayers.join(', ')}.`);
    if (mapState.bbox) {
      const b = mapState.bbox.map((n) => Number(n).toFixed(4));
      mapParts.push(`Viewport bbox (minLng,minLat,maxLng,maxLat): ${b.join(',')}.`);
    }
    if (mapState.selection && Object.keys(mapState.selection).length) {
      const sel = Object.entries(mapState.selection).map(([k, v]) => `${k}=${v}`).join(', ');
      mapParts.push(`Selected: ${sel}.`);
    }
    if (mapState.selectedFeature?.attrs && Object.keys(mapState.selectedFeature.attrs).length) {
      const a = Object.entries(mapState.selectedFeature.attrs).map(([k, v]) => `${k}=${v}`).join(', ');
      mapParts.push(`Selected feature attributes: ${a}.`);
    }
    if (mapState.legend?.length) mapParts.push(`Legend: ${mapState.legend.join(', ')}.`);
    mapParts.push('Answer only about what is actually rendered. If a layer the user asks about is blank/empty or hidden, diagnose the likely cause (active filter or selection, zero rows for the current region/vehicle/date scope, a toggle that is off, or an unset selection anchor) before answering; do not describe features that are not on the map. When the user refers to "this" or "the selected" feature, use the Selected feature attributes above; for any field, metric, or nearby data not listed there, query the semantic view or a routing tool rather than guessing - the attribute list is a bounded snapshot, not the full row.]');
    contextPrefix += mapParts.join(' ') + '\n\n';
  }
  if (availableViews.length > 0) {
    const viewLinks = availableViews
      .map((v) => `  [${v.label}](view:${v.id}) - ${v.description}`)
      .join('\n');
    contextPrefix += `[Available panel views - use the exact markdown link format below when your response would benefit from the user exploring data or taking action in the UI:\n${viewLinks}\n\nInclude a view link when: the question is about data that view surfaces, the user could take a useful action in the view, or the answer alone leaves the user without an obvious next step. Do not include links for general or conceptual questions. One or two links per response at most. Always use the markdown link format - never plain text view names.]\n\n`;
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
  // Map the active vehicle_type to the ORS routing profile the engine actually
  // builds, so the agent passes a profile that routes instead of one the engine
  // rejects. The engine builds 'cycling-electric' as its only cycling graph, so
  // ebike / any cycling vehicle resolve to it (raw 'ebike' would silently route
  // as a car; 'cycling-regular' would error with ORS 2003). Mirrors
  // fleet_tools/user/src/codes.ts VEHICLE_TYPE_TO_PROFILE.
  const vehicleToProfile: Record<string, string> = {
    car: 'driving-car', van: 'driving-car', 'driving-car': 'driving-car',
    hgv: 'driving-hgv', truck: 'driving-hgv', 'driving-hgv': 'driving-hgv',
    ebike: 'cycling-electric', 'e-bike': 'cycling-electric', bike: 'cycling-electric',
    bicycle: 'cycling-electric', cycle: 'cycling-electric',
    'cycling-regular': 'cycling-electric', 'cycling-mountain': 'cycling-electric',
    'cycling-road': 'cycling-electric', 'cycling-electric': 'cycling-electric',
  };
  const ctxBits: string[] = [];
  if (activeCtx.region) ctxBits.push(`region = ${activeCtx.region}`);
  if (activeCtx.vehicle_type) {
    const vt = String(activeCtx.vehicle_type).trim().toLowerCase();
    const orsProfile = vehicleToProfile[vt] ?? 'driving-car';
    ctxBits.push(`vehicle type = ${activeCtx.vehicle_type} (routing profile: ${orsProfile})`);
  }
  if (activeCtx.dataset_id) ctxBits.push(`dataset = ${activeCtx.dataset_id}`);
  if (activeCtx.date_range_start || activeCtx.date_range_end) {
    ctxBits.push(`date range = ${activeCtx.date_range_start ?? 'any'}..${activeCtx.date_range_end ?? 'any'}`);
  }
  let activeContextPrefix = '';
  if (ctxBits.length > 0) {
    activeContextPrefix =
      `[Active context: ${ctxBits.join('; ')}. ` +
      `When a routing tool needs a region or profile and the user did not name one, default to this region and pass the routing profile shown above (or null to use the active vehicle). ` +
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
