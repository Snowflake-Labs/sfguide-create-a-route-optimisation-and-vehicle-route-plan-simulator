// /api/agent/chat - Cortex Agent REST API (FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT).
// Streams responses via SSE. Translates Cortex Agent SSE protocol into
// our internal `workflow` / `token` / `result` events. Re-executes tool
// procedures locally for map geometry when the stream omits it.
// /api/agent/config - serves agent-demos.json from ORS_SPCS_STAGE.

import { Router } from 'express';
import { SNOWFLAKE_HOST, IS_SPCS } from '../constants.js';
import { runSql } from '../lib/sql.js';
import { getSpcsToken, escapeString } from '../lib/sanitize.js';

export function createAgentRouter(): Router {
  const router = Router();

  // ------------------------------------------------------------------
  // Tool procedure map for local re-execution (geometry recovery)
  // ------------------------------------------------------------------
  type ToolDef = { proc: string; params: string[]; defaults?: Record<string, string> };
  const TOOL_PROC_MAP: Record<string, ToolDef> = {
    tool_directions: {
      proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS',
      params: ['locations_description', 'profile'],
      defaults: { profile: 'driving-car' },
    },
    tool_isochrone: {
      proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE',
      params: ['location_description', 'range_minutes', 'profile'],
      defaults: { profile: 'driving-car', range_minutes: '10' },
    },
    tool_optimization: {
      proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION',
      params: ['delivery_locations', 'depot_location', 'num_vehicles', 'profile', 'region'],
      defaults: { profile: 'driving-car', region: 'California' },
    },
    tool_route_optimization: {
      proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION',
      params: ['delivery_locations', 'depot_location', 'num_vehicles', 'profile', 'region'],
      defaults: { profile: 'driving-car', region: 'California' },
    },
    tool_poi_in_isochrone: {
      proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_POI_IN_ISOCHRONE',
      params: ['location_description', 'range_minutes', 'poi_category', 'profile', 'max_results'],
      defaults: { profile: 'driving-car', range_minutes: '10', max_results: '25' },
    },
    tool_supply_chain: {
      proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_SUPPLY_CHAIN',
      params: ['profile'],
      defaults: { profile: 'driving-car' },
    },
    tool_pharma_optimization: {
      proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_OPTIMIZATION',
      params: ['profile'],
      defaults: { profile: 'driving-car' },
    },
    tool_pharma_catchment: {
      proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_PHARMA_CATCHMENT',
      params: ['pharmacy_description', 'range_minutes', 'profile'],
      defaults: { profile: 'driving-car', range_minutes: '10' },
    },
  };

  function sendSseEvent(res: any, event: string, data: any) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ------------------------------------------------------------------
  // /api/agent/config - serves agent-demos.json from ORS_SPCS_STAGE
  // ------------------------------------------------------------------
  const FALLBACK_AGENT_CONFIG = {
    version: '1.0',
    default_scenario: 'pharma',
    max_token_limit: 8000,
    scenarios: [
      {
        id: 'pharma',
        label: 'Pharma Supply Chain',
        icon: '\u{1F48A}',
        description: 'Pharmaceutical delivery planning',
        prompts: [
          { label: '1. Catchment', icon: '\u{1F3E5}', prompt: 'Show me the population health profile within 10 min drive of 498 Castro Street, San Francisco' },
        ],
      },
    ],
  };

  router.get('/api/agent/config', async (_req, res) => {
    try {
      const rows = await runSql(
        `SELECT $1 AS CONFIG FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json (FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.JSON_FORMAT')`,
        'OPENROUTESERVICE_APP', 'CORE',
      );
      if (rows?.[0]?.CONFIG) {
        const cfg = typeof rows[0].CONFIG === 'string' ? JSON.parse(rows[0].CONFIG) : rows[0].CONFIG;
        return res.json(cfg);
      }
    } catch (e: any) {
      console.log(`[agent/config] Stage load failed: ${e.message}, using fallback`);
    }
    res.json(FALLBACK_AGENT_CONFIG);
  });

  // ------------------------------------------------------------------
  // Helpers for parsing tool_result content blocks
  // ------------------------------------------------------------------
  function extractResultObj(c: any): any {
    let resultObj: any = null;
    if (c?.type === 'json' && c.json) {
      const raw = c.json;
      if (raw.result != null) {
        if (typeof raw.result === 'object') resultObj = raw.result;
        else if (typeof raw.result === 'string') {
          try { resultObj = JSON.parse(raw.result); } catch { resultObj = raw; }
        } else resultObj = raw;
      } else resultObj = raw;
    } else if (c?.type === 'text' && c.text) {
      try {
        const pt = JSON.parse(c.text);
        if (pt && typeof pt === 'object') {
          if (pt.result != null) {
            if (typeof pt.result === 'object') resultObj = pt.result;
            else if (typeof pt.result === 'string') {
              try { resultObj = JSON.parse(pt.result); } catch { resultObj = pt; }
            } else resultObj = pt;
          } else resultObj = pt;
        }
      } catch {}
    }
    return resultObj;
  }

  // ------------------------------------------------------------------
  // /api/agent/chat - Cortex Agent REST API call with SSE forwarding
  // ------------------------------------------------------------------
  router.post('/api/agent/chat', async (req, res) => {
    const { message, thread_id, parent_message_id, history } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      if (!IS_SPCS) throw new Error('Cortex Agent is only available in SPCS mode');
      const token = getSpcsToken();
      const agentUrl = `https://${SNOWFLAKE_HOST}/api/v2/databases/FLEET_INTELLIGENCE/schemas/ROUTING_AGENT/agents/ROUTING_AGENT:run`;

      const messages: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
      if (Array.isArray(history)) {
        for (const h of history) {
          if ((h.role === 'user' || h.role === 'assistant') && h.content) {
            const text = typeof h.content === 'string' ? h.content : '';
            if (text) messages.push({ role: h.role, content: [{ type: 'text', text }] });
          }
        }
      }
      messages.push({ role: 'user', content: [{ type: 'text', text: message }] });

      const body: any = { messages, stream: true };
      if (thread_id) {
        body.thread_id = Number(thread_id);
        body.parent_message_id = parent_message_id ? Number(parent_message_id) : 0;
      }

      console.log(`[Agent] Calling Cortex Agent API: "${message.slice(0, 100)}" thread=${thread_id || 'new'}`);
      sendSseEvent(res, 'workflow', { type: 'start', label: 'Agent started', ts: Date.now() });

      const agentRes = await fetch(agentUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Snowflake-Authorization-Token-Type': 'OAUTH',
        },
        body: JSON.stringify(body),
      });

      if (!agentRes.ok) {
        const errText = await agentRes.text();
        throw new Error(`Cortex Agent API ${agentRes.status}: ${errText.slice(0, 500)}`);
      }

      const reader = agentRes.body?.getReader();
      if (!reader) throw new Error('No readable body from Cortex Agent');
      const decoder = new TextDecoder();

      let fullText = '';
      let geometry: any = null;
      const toolResults: any[] = [];
      const toolsCalled: Array<{ name: string; input: any }> = [];
      const workflowSteps: any[] = [{ type: 'start', label: 'Agent started', ts: Date.now() }];
      let responseThreadId: number | undefined;
      let responseMessageId: number | undefined;
      let tokenUsage: any = null;
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const parsed = JSON.parse(data);
            switch (currentEvent) {
              case 'response.text.delta': {
                const text = parsed.text || '';
                if (text) {
                  fullText += text;
                  res.write(`event: token\ndata: ${JSON.stringify({ text })}\n\n`);
                }
                break;
              }
              case 'response.thinking.delta':
                break;
              case 'response.status': {
                const step = { type: 'status', label: parsed.message || parsed.status || 'Processing', ts: Date.now() };
                workflowSteps.push(step);
                sendSseEvent(res, 'workflow', step);
                break;
              }
              case 'response.tool_use': {
                const toolName = parsed.name || 'unknown';
                toolsCalled.push({ name: toolName, input: parsed.input });
                const step = { type: 'tool_start', label: `Calling ${toolName.replace('tool_', '')}`, tool: toolName, input: parsed.input, ts: Date.now() };
                workflowSteps.push(step);
                sendSseEvent(res, 'workflow', step);
                break;
              }
              case 'response.tool_result': {
                const toolName = parsed.name || 'unknown';
                const step = { type: 'tool_done', label: `${toolName.replace('tool_', '')} complete`, tool: toolName, ts: Date.now() };
                workflowSteps.push(step);
                sendSseEvent(res, 'workflow', step);
                if (parsed.content) {
                  for (const c of parsed.content) {
                    const resultObj = extractResultObj(c);
                    if (resultObj) {
                      toolResults.push(resultObj);
                      if (resultObj.geometry && !geometry) geometry = resultObj.geometry;
                    }
                  }
                }
                console.log(`[Agent] Tool result for ${toolName}: has_geometry=${!!geometry}, results=${toolResults.length}`);
                break;
              }
              case 'response.tool_result.status': {
                const step = { type: 'status', label: parsed.message || parsed.status || 'Tool executing', ts: Date.now() };
                workflowSteps.push(step);
                sendSseEvent(res, 'workflow', step);
                break;
              }
              case 'metadata': {
                if (parsed.metadata) {
                  if (parsed.metadata.message_id) responseMessageId = parsed.metadata.message_id;
                  if (parsed.metadata.run_id) {
                    const parts = String(parsed.metadata.run_id).split('-');
                    if (parts.length >= 1) responseThreadId = Number(parts[0]) || undefined;
                  }
                }
                break;
              }
              case 'response': {
                if (parsed.metadata) {
                  responseThreadId = parsed.metadata.thread_id ?? responseThreadId;
                  responseMessageId = parsed.metadata.assistant_message_id ?? responseMessageId;
                  tokenUsage = parsed.metadata.usage ?? tokenUsage;
                }
                if (parsed.content) {
                  for (const item of parsed.content) {
                    if (item.type === 'text' && !fullText) fullText += (fullText ? '\n' : '') + item.text;
                    if (item.type === 'tool_result' && item.tool_result?.content) {
                      for (const c of item.tool_result.content) {
                        const resultObj = extractResultObj(c);
                        if (resultObj) {
                          toolResults.push(resultObj);
                          if (resultObj.geometry && !geometry) geometry = resultObj.geometry;
                        }
                      }
                    }
                  }
                }
                break;
              }
              case 'error':
                throw new Error(parsed.message || 'Agent error');
              default: {
                if (!currentEvent && parsed.role === 'assistant' && parsed.content) {
                  for (const item of parsed.content) {
                    if (item.type === 'tool_result' && item.tool_result?.content) {
                      for (const c of item.tool_result.content) {
                        const resultObj = extractResultObj(c);
                        if (resultObj) {
                          toolResults.push(resultObj);
                          if (resultObj.geometry && !geometry) geometry = resultObj.geometry;
                        }
                      }
                    }
                    if (item.type === 'text' && !fullText) fullText += (fullText ? '\n' : '') + item.text;
                  }
                  if (parsed.metadata) {
                    responseThreadId = parsed.metadata.thread_id ?? responseThreadId;
                    responseMessageId = parsed.metadata.assistant_message_id ?? responseMessageId;
                    tokenUsage = parsed.metadata.usage ?? tokenUsage;
                  }
                }
                break;
              }
            }
          } catch (parseErr: any) {
            if (currentEvent === 'error') throw parseErr;
          }
          currentEvent = '';
        }
      }

      // Geometry recovery: re-execute tools locally if the agent stream
      // didn't carry full geometry (common for some response shapes).
      if (!geometry && toolsCalled.length > 0) {
        console.log(`[Agent] No geometry from agent stream, re-executing ${toolsCalled.length} tool(s) locally for map data`);
        for (const tc of toolsCalled) {
          const toolDef = TOOL_PROC_MAP[tc.name];
          if (!toolDef) continue;
          try {
            const args = tc.input || {};
            const sqlArgs = toolDef.params.map(p => {
              const val = args[p] ?? toolDef.defaults?.[p] ?? null;
              if (val == null) return 'NULL';
              if (typeof val === 'number') return String(val);
              return `'${escapeString(String(val))}'`;
            }).join(', ');
            const callSql = `CALL ${toolDef.proc}(${sqlArgs})`;
            console.log(`[Agent] Re-executing: ${callSql.slice(0, 200)}`);
            const rows = await runSql(callSql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
            if (rows && rows.length > 0) {
              const firstCol = Object.keys(rows[0])[0];
              let rawResult = rows[0][firstCol];
              if (typeof rawResult === 'string') {
                try { rawResult = JSON.parse(rawResult); } catch {}
              }
              if (rawResult && typeof rawResult === 'object') {
                toolResults.push(rawResult);
                if (rawResult.geometry && !geometry) geometry = rawResult.geometry;
              }
            }
          } catch (e: any) {
            console.error(`[Agent] Re-exec ${tc.name} failed: ${e.message}`);
          }
        }
      }

      const doneStep = { type: 'done', label: 'Complete', ts: Date.now() };
      workflowSteps.push(doneStep);
      sendSseEvent(res, 'workflow', doneStep);

      if (!fullText) fullText = 'No response from agent';
      const response: any = {
        message: fullText,
        tool_results: toolResults,
        token_usage: { workflow_steps: workflowSteps, ...(tokenUsage || {}) },
      };
      if (geometry) response.geometry = geometry;
      if (responseThreadId) response.thread_id = responseThreadId;
      if (responseMessageId) response.message_id = responseMessageId;

      sendSseEvent(res, 'result', response);
      res.end();
      console.log(`[Agent] Completed. Text=${fullText.length}chars, tools=${toolResults.length}, has_geometry=${!!geometry}, thread=${responseThreadId}`);
    } catch (err: any) {
      console.error(`[Agent] Chat endpoint error: ${err.message}`);
      sendSseEvent(res, 'error', { error: err.message || 'Unknown agent error' });
      res.end();
    }
  });

  return router;
}
