import type { MessagePart } from './types';
import { CHART_TOOL_NAME, isChartTool } from './tool-names';

export interface CortexEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface StreamCallbacks {
  onPart: (part: MessagePart) => void;
  onStatus: (status: string, message: string) => void;
  onMetadata: (metadata: { threadId?: number; assistantMessageId?: number; runId?: string }) => void;
  onError: (error: string) => void;
  onDone: () => void;
}

export async function parseCortexStream(
  response: Response,
  callbacks: StreamCallbacks,
): Promise<void> {
  if (!response.body) {
    callbacks.onError('No response body');
    callbacks.onDone();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentTextBuffer = '';

  // Vega-Lite spec strings already emitted as a chart part in this response.
  //
  // MEASURED, and it invalidates the obvious assumption: this host sends the SAME
  // chart TWICE - once as a `response.tool_result` named `data_to_chart` and again
  // as a `response.chart` event. `SEMANTIC_OPS.AGENT_TURN.TOOLS_USED` for the turn
  // "show me Visits by Facility Type" records both, in that order:
  //
  //   query_dwell, system_execute_sql, server_skill, data_to_chart, render_table,
  //   render_chart
  //
  // Before this file rendered charts at all that was harmless (one path produced a
  // JSON blob, the other a broken recharts translation). Now that BOTH names are
  // registered to a working renderer, emitting both would draw the same chart
  // twice. Deduplicated on the spec content, and since the tool_result arrives
  // FIRST (per the order above) the winning part is the one carrying the
  // tool_use_id that citation placement needs.
  const seenChartSpecs = new Set<string>();

  /** Register spec strings from a chart payload; returns false if all were seen. */
  function claimChartSpecs(specs: unknown[]): boolean {
    let fresh = false;
    for (const s of specs) {
      const key = typeof s === 'string' ? s : JSON.stringify(s ?? null);
      if (!seenChartSpecs.has(key)) {
        seenChartSpecs.add(key);
        fresh = true;
      }
    }
    return fresh;
  }

  function flushText() {
    if (currentTextBuffer) {
      callbacks.onPart({ type: 'text', content: currentTextBuffer });
      currentTextBuffer = '';
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';

      for (const chunk of chunks) {
        const event = parseSSEChunk(chunk);
        if (!event) continue;

        switch (event.event) {
          case 'response.text.delta': {
            const text = event.data.text as string;
            if (text) currentTextBuffer += text;
            break;
          }

          case 'response.text': {
            flushText();
            break;
          }

          case 'response.thinking.delta': {
            break;
          }

          case 'response.tool_use': {
            flushText();
            const toolUse = event.data;
            callbacks.onPart({
              type: 'tool_pending',
              toolName: (toolUse.name as string) || (toolUse.type as string) || 'unknown',
              input: (toolUse.input as Record<string, unknown>) || {},
              toolUseId: toolUseIdOf(toolUse),
            });
            break;
          }

          case 'response.tool_result': {
            const toolResult = event.data;
            const content = toolResult.content as Array<{ type: string; json?: unknown; text?: string }> | undefined;
            const toolResultName = (toolResult.name as string) || (toolResult.type as string) || 'unknown';
            const output = extractToolOutput(content);
            if (isChartTool(toolResultName)) {
              // Claim the specs so the duplicate `response.chart` event that
              // follows is dropped rather than drawn a second time.
              const charts = Array.isArray(output.charts) ? output.charts : [output];
              claimChartSpecs(charts);
            }
            callbacks.onPart({
              type: 'tool_result',
              toolName: toolResultName,
              output,
              toolUseId: toolUseIdOf(toolResult),
            });
            break;
          }

          case 'response.tool_result.analyst.delta': {
            const delta = event.data.delta as Record<string, unknown> | undefined;
            if (delta?.text) {
              currentTextBuffer += delta.text as string;
            }
            if (delta?.result_set) {
              flushText();
              callbacks.onPart({
                type: 'tool_result',
                toolName: 'render_table',
                output: transformResultSet(delta.result_set as ResultSet),
              });
            }
            break;
          }

          case 'response.table': {
            flushText();
            const resultSet = event.data.result_set as ResultSet | undefined;
            if (resultSet) {
              callbacks.onPart({
                type: 'tool_result',
                toolName: 'render_table',
                output: {
                  ...transformResultSet(resultSet),
                  title: event.data.title as string | undefined,
                },
              });
            }
            break;
          }

          case 'response.chart': {
            flushText();
            // The DUPLICATE of the data_to_chart tool_result above (measured -
            // see seenChartSpecs). Kept because a host that sends only this event
            // must still render, but skipped when the spec has already been
            // drawn. The field name is read defensively and falls back to the
            // whole event payload: sending `{charts: [undefined]}` here would
            // trade a duplicate chart for a missing one.
            const spec = event.data.chart_spec ?? event.data.chart ?? event.data.spec ?? event.data;
            if (!claimChartSpecs([spec])) break;
            callbacks.onPart({
              type: 'tool_result',
              toolName: CHART_TOOL_NAME,
              output: { charts: [spec] },
              toolUseId: toolUseIdOf(event.data),
            });
            break;
          }

          case 'response.status': {
            callbacks.onStatus(
              event.data.status as string,
              event.data.message as string || '',
            );
            break;
          }

          case 'metadata': {
            const meta = event.data.metadata as Record<string, unknown> | undefined;
            if (meta) {
              callbacks.onMetadata({
                threadId: meta.thread_id as number | undefined,
                assistantMessageId: meta.message_id as number | undefined,
                runId: meta.run_id as string | undefined,
              });
            }
            break;
          }

          case 'error': {
            flushText();
            callbacks.onError(event.data.message as string || 'Unknown error');
            break;
          }

          case 'response': {
            flushText();
            break;
          }
        }
      }
    }

    flushText();
  } catch (err) {
    flushText();
    callbacks.onError(err instanceof Error ? err.message : 'Stream read error');
  } finally {
    callbacks.onDone();
  }
}

/**
 * The host's id for a tool call, read defensively.
 *
 * The Cortex Agents API uses `tool_use_id`; some payloads carry it as `id`.
 * Read both rather than one, because the ONLY consumer is chart-citation
 * placement, and a missing id degrades to positional rendering (chart before
 * the prose) - never to a dropped chart.
 */
function toolUseIdOf(data: Record<string, unknown>): string | undefined {
  const raw = data.tool_use_id ?? data.id;
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

function parseSSEChunk(chunk: string): CortexEvent | null {
  let eventType = 'message';
  let dataStr = '';

  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataStr += line.slice(6);
    } else if (line.startsWith('data:')) {
      dataStr += line.slice(5);
    }
  }

  if (!dataStr) return null;

  try {
    return { event: eventType, data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

interface ResultSet {
  resultSetMetaData?: {
    rowType?: Array<{ name: string; type: string }>;
    numRows?: number;
  };
  data?: Array<Array<string>>;
}

function transformResultSet(rs: ResultSet): Record<string, unknown> {
  const columns = (rs.resultSetMetaData?.rowType || []).map((col) => ({
    key: col.name,
    label: col.name,
  }));

  const rows = (rs.data || []).map((row) => {
    const obj: Record<string, string> = {};
    columns.forEach((col, i) => {
      obj[col.key] = row[i] ?? '';
    });
    return obj;
  });

  return {
    columns,
    rows,
    totalRows: rs.resultSetMetaData?.numRows ?? rows.length,
  };
}

function extractToolOutput(
  content?: Array<{ type: string; json?: unknown; text?: string }>,
): Record<string, unknown> {
  if (!content || content.length === 0) return {};

  for (const item of content) {
    if (item.type === 'json' && item.json !== undefined && item.json !== null) {
      // SP VARIANT returns sometimes arrive double-encoded: json field is a JSON string, not an object
      if (typeof item.json === 'string') {
        try { return JSON.parse(item.json) as Record<string, unknown>; } catch { /* fall through */ }
      }
      if (typeof item.json === 'object') {
        return item.json as Record<string, unknown>;
      }
    }
    if (item.type === 'text' && item.text) {
      // Procedure tool results often arrive as JSON strings in a text field
      try {
        const parsed = JSON.parse(item.text);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        // not JSON - fall through to raw text
      }
      return { text: item.text };
    }
  }

  return {};
}

