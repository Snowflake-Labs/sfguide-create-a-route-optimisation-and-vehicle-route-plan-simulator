import type { MessagePart } from './types';

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
            });
            break;
          }

          case 'response.tool_result': {
            const toolResult = event.data;
            const content = toolResult.content as Array<{ type: string; json?: unknown; text?: string }> | undefined;
            const toolResultName = (toolResult.name as string) || (toolResult.type as string) || 'unknown';
            const output = extractToolOutput(content);
            callbacks.onPart({
              type: 'tool_result',
              toolName: toolResultName,
              output,
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
            callbacks.onPart({
              type: 'tool_result',
              toolName: 'render_chart',
              output: { chartSpec: event.data.chart_spec as string },
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
        // not JSON — fall through to raw text
      }
      return { text: item.text };
    }
  }

  return {};
}

