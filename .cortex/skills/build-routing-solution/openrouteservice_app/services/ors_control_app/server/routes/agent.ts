// /api/agent/chat - Cortex-backed routing agent with tool-call loop.
// Streams responses via SSE. Calls FLEET_INTELLIGENCE.ROUTING_AGENT.* tool
// procedures with one local fallback (tool_poi).

import { Router } from 'express';
import { SF_DATABASE, SNOWFLAKE_HOST, IS_SPCS } from '../constants.js';
import { runSql } from '../lib/sql.js';
import { getSpcsToken } from '../lib/sanitize.js';

export function createAgentRouter(): Router {
  const router = Router();

  const TOOL_PROCEDURE_MAP: Record<string, { identifier: string; params: string[] }> = {
    tool_directions: {
      identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS',
      params: ['locations_description', 'profile'],
    },
    tool_isochrone: {
      identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE',
      params: ['location_description', 'range_minutes', 'profile'],
    },
    tool_optimization: {
      identifier: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION',
      params: ['jobs_description', 'num_vehicles', 'profile'],
    },
    tool_poi: {
      identifier: '__local__',
      params: ['location_description', 'category', 'range_minutes', 'profile'],
    },
  };

  const POI_CATEGORY_MAP: Record<string, string[]> = {
    restaurant: ['restaurant', 'fast_food_restaurant', 'casual_eatery', 'fine_dining_restaurant', 'pizzaria', 'chicken_restaurant', 'sandwich_shop', 'sushi_restaurant', 'seafood_restaurant', 'steak_house', 'burger_restaurant'],
    cafe: ['cafe', 'coffee_shop', 'bakery', 'tea_house'],
    bar: ['bar', 'pub', 'nightclub', 'lounge'],
    hotel: ['hotel', 'motel', 'hostel', 'bed_and_breakfast'],
    shop: ['shopping_mall', 'convenience_store', 'supermarket', 'department_store', 'clothing_store'],
    hospital: ['hospital', 'medical_clinic', 'pharmacy', 'dentist'],
    school: ['school', 'university', 'college', 'kindergarten'],
    park: ['park', 'playground', 'sports_complex', 'golf_course'],
    gas_station: ['gas_station', 'charging_station'],
    parking: ['parking', 'parking_garage'],
  };

  async function executeToolPoi(input: Record<string, any>): Promise<any> {
    const { location_description, category, range_minutes, profile } = input;
    const cats = POI_CATEGORY_MAP[String(category || 'restaurant').toLowerCase()] || POI_CATEGORY_MAP['restaurant'];
    const isoResult = await executeToolLocally('tool_isochrone', { location_description, range_minutes: range_minutes ?? 10, profile });
    if (isoResult?.status === 'FAILED' || isoResult?.error) return isoResult;
    const geometry = isoResult?.geometry;
    if (!geometry) return { error: 'Isochrone returned no geometry', status: 'FAILED' };
    const catFilter = cats.map((c: string) => `'${c}'`).join(',');
    const geojsonStr = JSON.stringify(geometry).replace(/'/g, "''");
    const sql = `
      SELECT NAMES::VARIANT:primary::STRING AS NAME,
             BASIC_CATEGORY AS CATEGORY,
             ST_Y(GEOMETRY) AS LAT,
             ST_X(GEOMETRY) AS LNG
      FROM OVERTURE_MAPS__PLACES.CARTO.PLACE
      WHERE ST_WITHIN(GEOMETRY, TO_GEOGRAPHY('${geojsonStr}'))
        AND BASIC_CATEGORY IN (${catFilter})
      LIMIT 200`;
    try {
      const rows = await runSql(sql, 'OVERTURE_MAPS__PLACES', 'CARTO');
      const poi_list = (rows || []).map((r: any) => ({
        name: r.NAME || 'Unknown',
        category: r.CATEGORY || category,
        lat: Number(r.LAT),
        lng: Number(r.LNG),
      }));
      return { ...isoResult, poi_list, poi_count: poi_list.length };
    } catch (e: any) {
      return { ...isoResult, poi_list: [], poi_count: 0, poi_error: e.message?.slice(0, 200) };
    }
  }

  const ROUTING_SYSTEM_PROMPT = `You are a routing agent powered by OpenRouteService. You help users with:
  1. Driving/cycling/walking directions between locations
  2. Reachability analysis (isochrones) - areas reachable within X minutes
  3. Multi-stop delivery route optimization
  4. Finding points of interest (restaurants, cafes, bars, hotels, shops, etc.) within a reachable area

  You have access to four tools. To call a tool, respond with EXACTLY this JSON format and NOTHING else:
  {"tool_call": {"name": "TOOL_NAME", "input": {PARAMS}}}

  Available tools:
  1. tool_directions - Get directions between locations
     Input: {"locations_description": "string describing start/end/waypoints (required)", "profile": "string (default: driving-car)"}
  2. tool_isochrone - Get area reachable within specified minutes from a location
     Input: {"location_description": "string describing the center location (required)", "range_minutes": number (required), "profile": "string (default: driving-car)"}
  3. tool_optimization - Optimize delivery/pickup routes for multiple stops with one or more vehicles
     Input: {"jobs_description": "string describing all delivery/pickup locations including the depot/start address (required)", "num_vehicles": number (default: 1), "profile": "string (default: driving-car)"}
  4. tool_poi - Find points of interest within a reachable area from a location. Use when user asks to show/find specific place types within a travel time (e.g. "restaurants within 10 min drive").
     Input: {"location_description": "string describing the center location (required)", "category": "one of: restaurant, cafe, bar, hotel, shop, hospital, school, park, gas_station, parking (required)", "range_minutes": number (required), "profile": "string (default: driving-car)"}

  Transport profiles available: driving-car, cycling-electric (use for ANY cycling/bike request), driving-hgv (trucks only)

  CRITICAL RULES:
  1. ALWAYS call the appropriate tool for ANY routing question. NEVER answer from general knowledge.
  2. When you need to call a tool, respond ONLY with the JSON tool_call object. No other text.
  3. After receiving tool results, format them clearly: distances in km, durations in minutes.
  4. If a tool returns an error, report it clearly. Do NOT retry with a different profile.
  5. NEVER fabricate routing data.
  6. Use tool_poi (NOT tool_isochrone) when the user asks to find/show specific place types within a travel time.
  7. ONLY use these exact profile strings: driving-car, cycling-electric, driving-hgv. Never use cycling-regular, cycling-road, foot-walking or any other variant.`;

  const AGENT_PROFILE_ALIASES: Record<string, string> = {
    'bike': 'cycling-electric', 'bicycle': 'cycling-electric', 'cycling': 'cycling-electric',
    'cycle': 'cycling-electric', 'cycling-regular': 'cycling-electric', 'cycling-road': 'cycling-electric',
    'cycling-mountain': 'cycling-electric', 'foot-walking': 'driving-car', 'walk': 'driving-car',
    'walking': 'driving-car', 'foot': 'driving-car', 'car': 'driving-car',
    'drive': 'driving-car', 'driving': 'driving-car', 'truck': 'driving-hgv', 'hgv': 'driving-hgv',
  };
  const AGENT_VALID_PROFILES = new Set(['driving-car', 'driving-hgv', 'cycling-electric']);

  function normalizeAgentProfile(profile: string | undefined): string {
    if (!profile) return 'driving-car';
    const lower = profile.toLowerCase().trim();
    if (AGENT_VALID_PROFILES.has(lower)) return lower;
    return AGENT_PROFILE_ALIASES[lower] || 'driving-car';
  }

  function escAgentSql(val: any): string {
    if (val === undefined || val === null) return "''";
    return "'" + String(val).replace(/'/g, "''") + "'";
  }

  async function executeToolLocally(toolName: string, input: Record<string, any>): Promise<any> {
    if (toolName === 'tool_poi') return executeToolPoi(input);
    const mapping = TOOL_PROCEDURE_MAP[toolName];
    if (!mapping || mapping.identifier === '__local__') return { error: `Unknown tool: ${toolName}`, status: 'FAILED' };
    const args = mapping.params.map(p => {
      let val = input[p];
      if (p === 'profile') val = normalizeAgentProfile(val as string);
      if (val === undefined || val === null) return 'DEFAULT';
      if (typeof val === 'number') return String(val);
      return escAgentSql(val);
    });
    const sql = `CALL ${mapping.identifier}(${args.join(', ')})`;
    try {
      const rows = await runSql(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
      const result = rows?.[0];
      if (result) {
        const firstVal = Object.values(result)[0];
        if (typeof firstVal === 'string') {
          try { return JSON.parse(firstVal); } catch { return firstVal; }
        }
        return firstVal;
      }
      return { error: 'No result from tool execution', status: 'FAILED' };
    } catch (err: any) {
      return { error: `Tool execution failed: ${err.message}`, status: 'FAILED' };
    }
  }

  function escAgentSqlStr(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, ' ');
  }

  const AGENT_MODELS = ['claude-sonnet-4-5', 'mistral-large2'];
  let agentModel = AGENT_MODELS[0];

  async function callCortexCompleteStreaming(
    messages: Array<{role: string; content: string}>,
    onToken: (text: string) => void,
  ): Promise<string> {
    const token = getSpcsToken();
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    };
    const body = JSON.stringify({
      model: agentModel,
      messages,
      stream: true,
      max_tokens: 4096,
      temperature: 0,
    });
    const url = `https://${SNOWFLAKE_HOST}/api/v2/cortex/inference:complete`;
    console.log(`[Agent] Streaming CORTEX.COMPLETE model=${agentModel}, msgCount=${messages.length}`);
    const startMs = Date.now();
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Cortex streaming API ${res.status}: ${errText.slice(0, 300)}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No readable body from Cortex streaming response');
    const decoder = new TextDecoder();
    let fullText = '';
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
          const parsed = JSON.parse(data);
          const text = parsed.choices?.[0]?.delta?.content || '';
          if (text) { fullText += text; onToken(text); }
        } catch {}
      }
    }
    console.log(`[Agent] Streaming completed in ${Date.now() - startMs}ms, length=${fullText.length}`);
    if (!fullText) throw new Error('Cortex streaming returned empty response');
    return fullText;
  }

  async function callCortexComplete(messages: Array<{role: string; content: string}>): Promise<string> {
    const msgArray = messages.map(m => {
      return `{'role':'${m.role}','content':'${escAgentSqlStr(m.content)}'}`;
    }).join(',');
    const sql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('${agentModel}', [${msgArray}], {'max_tokens':4096,'temperature':0}) as RESPONSE`;
    console.log(`[Agent] Calling CORTEX.COMPLETE with model=${agentModel}, msgCount=${messages.length}, sqlLen=${sql.length}`);
    const startMs = Date.now();
    let rows: any[];
    try {
      rows = await runSql(sql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
    } catch (err: any) {
      console.error(`[Agent] CORTEX.COMPLETE failed (${Date.now() - startMs}ms): ${err.message}`);
      if (agentModel === AGENT_MODELS[0] && AGENT_MODELS.length > 1) {
        console.log(`[Agent] Retrying with fallback model ${AGENT_MODELS[1]}`);
        agentModel = AGENT_MODELS[1];
        const retrySql = sql.replace(AGENT_MODELS[0], agentModel);
        rows = await runSql(retrySql, 'FLEET_INTELLIGENCE', 'ROUTING_AGENT');
      } else {
        throw err;
      }
    }
    console.log(`[Agent] CORTEX.COMPLETE returned in ${Date.now() - startMs}ms`);
    if (!rows || rows.length === 0) throw new Error('No response from CORTEX.COMPLETE');
    const raw = rows[0].RESPONSE || rows[0][Object.keys(rows[0])[0]] || '';
    let content = '';
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      content = parsed.choices?.[0]?.messages || parsed.choices?.[0]?.message?.content || '';
    } catch {
      content = String(raw);
    }
    if (!content) {
      console.error(`[Agent] Empty content from CORTEX.COMPLETE. Raw: ${JSON.stringify(raw).slice(0, 500)}`);
      throw new Error('Empty response from LLM');
    }
    return content.trim();
  }

  function findMatchingBrace(s: string): number {
    let depth = 0; let inStr = false; let esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function parseToolCall(text: string): { name: string; input: Record<string, any> } | null {
    try {
      const match = text.match(/\{\s*"tool_call"\s*:/s);
      if (!match) return null;
      const jsonStr = text.slice(text.indexOf('{'));
      const braceEnd = findMatchingBrace(jsonStr);
      if (braceEnd < 0) return null;
      const parsed = JSON.parse(jsonStr.slice(0, braceEnd + 1));
      if (parsed.tool_call?.name && TOOL_PROCEDURE_MAP[parsed.tool_call.name]) {
        return { name: parsed.tool_call.name, input: parsed.tool_call.input || {} };
      }
    } catch {}
    return null;
  }

  async function callCortexAgentWithToolLoop(
    message: string, threadId?: string, parentMessageId?: string,
    onProgress?: (data: { step: string; detail?: string }) => void,
    onToken?: (text: string) => void,
  ): Promise<any> {
    if (!IS_SPCS) throw new Error('Cortex Agent is only available in SPCS mode');
    console.log(`[Agent] Starting tool loop for: "${message.slice(0, 100)}"`);
    const messages: Array<{role: string; content: string}> = [
      { role: 'system', content: ROUTING_SYSTEM_PROMPT },
      { role: 'user', content: message },
    ];
    const maxIterations = 5;
    const allToolResults: any[] = [];
    let toolsExecuted = false;

    for (let iter = 0; iter < maxIterations; iter++) {
      onProgress?.({ step: 'calling_llm', detail: iter === 0 ? 'Thinking...' : `Processing (step ${iter + 1})` });

      if (toolsExecuted && onToken) {
        onProgress?.({ step: 'formatting', detail: 'Generating response...' });
        try {
          const streamedText = await callCortexCompleteStreaming(messages, onToken);
          return { role: 'assistant', content: [{ type: 'text', text: streamedText }], _toolResults: allToolResults };
        } catch (streamErr: any) {
          console.warn(`[Agent] Streaming failed, falling back to blocking: ${streamErr.message}`);
          const fallback = await callCortexComplete(messages);
          onToken(fallback);
          return { role: 'assistant', content: [{ type: 'text', text: fallback }], _toolResults: allToolResults };
        }
      }

      const response = await callCortexComplete(messages);
      console.log(`[Agent] LLM response (iter ${iter}): ${response.slice(0, 200)}`);
      const toolCall = parseToolCall(response);

      if (!toolCall) {
        console.log(`[Agent] No tool call found, returning text response`);
        if (onToken) onToken(response);
        return { role: 'assistant', content: [{ type: 'text', text: response }], _toolResults: allToolResults };
      }

      const toolLabel = toolCall.name.replace('tool_', '');
      onProgress?.({ step: 'executing_tool', detail: toolLabel });
      console.log(`[Agent] Executing tool: ${toolCall.name}`);
      messages.push({ role: 'assistant', content: response });
      const toolResult = await executeToolLocally(toolCall.name, toolCall.input);
      allToolResults.push(toolResult);
      toolsExecuted = true;
      const resultStr = JSON.stringify(toolResult).slice(0, 30000);
      messages.push({ role: 'user', content: `Tool result from ${toolCall.name}:\n${resultStr}\n\nNow provide your final answer based on this data. Format distances in km and durations in minutes. Be concise.` });
    }
    return { role: 'assistant', content: [{ type: 'text', text: 'I was unable to complete the request after multiple attempts.' }], _toolResults: allToolResults };
  }

  function sendSseEvent(res: any, event: string, data: any) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  router.post('/api/agent/chat', async (req, res) => {
    const { message, thread_id, parent_message_id } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try {
      const onProgress = (data: { step: string; detail?: string }) => { sendSseEvent(res, 'progress', data); };
      const onToken = (text: string) => { res.write(`event: token\ndata: ${JSON.stringify({ text })}\n\n`); };
      const agentResult = await callCortexAgentWithToolLoop(message, thread_id, parent_message_id, onProgress, onToken);
      const content = agentResult?.content || [];
      let msg = '';
      let geometry: any = null;
      const toolResults: any[] = agentResult?._toolResults || [];
      for (const item of content) { if (item.type === 'text') msg += (msg ? '\n' : '') + item.text; }
      for (const tr of toolResults) { if (tr && typeof tr === 'object' && tr.geometry && !geometry) geometry = tr.geometry; }
      if (!msg) msg = agentResult?.message || 'No response from agent';
      const response: any = { message: msg, tool_results: toolResults };
      if (geometry) response.geometry = geometry;
      if (agentResult?.metadata?.thread_id) response.thread_id = agentResult.metadata.thread_id;
      if (agentResult?.metadata?.message_id) response.message_id = agentResult.metadata.message_id;
      sendSseEvent(res, 'result', response);
      res.end();
    } catch (err: any) {
      console.error(`[Agent] Chat endpoint error: ${err.message}`);
      sendSseEvent(res, 'error', { error: err.message || 'Unknown agent error' });
      res.end();
    }
  });

  return router;
}
