// /api/agent/chat - Cortex Agent REST API (FLEET_INTELLIGENCE.ROUTING_AGENT.ROUTING_AGENT).
// Streams responses via SSE. Translates Cortex Agent SSE protocol into
// our internal `workflow` / `token` / `result` events. Re-executes tool
// procedures locally for map geometry when the stream omits it.
// /api/agent/config - serves agent-demos.json from ORS_SPCS_STAGE.

import { Router } from 'express';
import { SNOWFLAKE_HOST, IS_SPCS } from '../constants.js';
import { runSql } from '../lib/sql.js';
import { getSpcsToken, escapeString } from '../lib/sanitize.js';
import { regionCatalogMatch } from '../lib/region-catalog-match.js';

export function createAgentRouter(): Router {
  const router = Router();

  // ------------------------------------------------------------------
  // Tool procedure map for local re-execution (geometry recovery).
  // Defaults are computed per-request so the active region/profile from the
  // UI flow through to the re-executed CALLs.
  // ------------------------------------------------------------------
  type ToolDef = { proc: string; params: string[]; defaults?: Record<string, string> };
  function buildToolProcMap(activeRegion: string, activeProfile: string): Record<string, ToolDef> {
    const region = activeRegion || 'SanFrancisco';
    const profile = activeProfile || 'driving-car';
    return {
      tool_directions: {
        proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DIRECTIONS',
        params: ['locations_description', 'profile'],
        defaults: { profile },
      },
      tool_isochrone: {
        proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ISOCHRONE',
        params: ['location_description', 'range_minutes', 'profile'],
        defaults: { profile, range_minutes: '10' },
      },
      tool_optimization: {
        proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION',
        params: ['delivery_locations', 'depot_location', 'num_vehicles', 'profile', 'region'],
        defaults: { profile, region },
      },
      tool_route_optimization: {
        proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_ROUTE_OPTIMIZATION',
        params: ['delivery_locations', 'depot_location', 'num_vehicles', 'profile', 'region'],
        defaults: { profile, region },
      },
      tool_poi_in_isochrone: {
        proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_POI_IN_ISOCHRONE',
        params: ['location_description', 'range_minutes', 'poi_category', 'profile', 'max_results'],
        defaults: { profile, range_minutes: '10', max_results: '25' },
      },
      tool_network_optimization: {
        proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_NETWORK_OPTIMIZATION',
        params: ['profile'],
        defaults: { profile },
      },
      tool_delivery_optimization: {
        proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_DELIVERY_OPTIMIZATION',
        params: ['profile'],
        defaults: { profile },
      },
      tool_catchment: {
        proc: 'FLEET_INTELLIGENCE.ROUTING_AGENT.TOOL_CATCHMENT',
        params: ['site_description', 'range_minutes', 'profile'],
        defaults: { profile, range_minutes: '10' },
      },
    };
  }

  function sendSseEvent(res: any, event: string, data: any) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // ------------------------------------------------------------------
  // /api/agent/config - serves agent-demos.json from ORS_SPCS_STAGE
  // ------------------------------------------------------------------
  const FALLBACK_AGENT_CONFIG = {
    version: '1.0',
    default_scenario: 'catchment',
    max_token_limit: 8000,
    scenarios: [
      {
        id: 'catchment',
        label: 'Catchment & Delivery',
        icon: '\u{1F4CD}',
        description: 'Catchment analysis and delivery planning',
        prompts: [
          { label: '1. Catchment', icon: '\u{1F4CD}', prompt: 'Show me the area profile within 10 min drive of 498 Castro Street, San Francisco' },
        ],
      },
    ],
  };

  async function loadStaticAgentDemos(): Promise<any> {
    try {
      const rows = await runSql(
        `SELECT $1 AS CONFIG FROM @OPENROUTESERVICE_APP.CORE.ORS_SPCS_STAGE/config/agent-demos.json (FILE_FORMAT => 'OPENROUTESERVICE_APP.CORE.JSON_FORMAT')`,
        'OPENROUTESERVICE_APP', 'CORE',
      );
      if (rows?.[0]?.CONFIG) {
        return typeof rows[0].CONFIG === 'string' ? JSON.parse(rows[0].CONFIG) : rows[0].CONFIG;
      }
    } catch (e: any) {
      console.log(`[agent/config] Stage load failed: ${e.message}, using fallback`);
    }
    return FALLBACK_AGENT_CONFIG;
  }

  router.get('/api/agent/config', async (_req, res) => {
    res.json(await loadStaticAgentDemos());
  });

  // ------------------------------------------------------------------
  // /api/agent/examples?region=...&vehicle=... - live AI_COMPLETE-generated
  // example chips for the Agent Playground. Falls back to agent-demos.json.
  // ------------------------------------------------------------------
  function profileFromVehicle(vt: string): string {
    const v = (vt || '').toLowerCase();
    if (!v) return 'driving-car';
    if (v.includes('hgv') || v.includes('truck') || v.includes('lorry') || v.includes('semi')) return 'driving-hgv';
    if (v.includes('ebike') || v.includes('e-bike') || v.includes('electric_bike')) return 'cycling-electric';
    if (v.includes('mountain')) return 'cycling-mountain';
    if (v.includes('bike') || v.includes('bicycle') || v.includes('cycle')) return 'cycling-regular';
    if (v.includes('walk') || v.includes('foot') || v.includes('pedestrian')) return 'foot-walking';
    if (v.includes('hike')) return 'foot-hiking';
    if (v.includes('wheelchair')) return 'wheelchair';
    return 'driving-car';
  }

  function extractFirstJson(text: string): any | null {
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  router.get('/api/agent/examples', async (req, res) => {
    const region = String(req.query.region || '').trim();
    const vehicle = String(req.query.vehicle || '').trim();
    const profile = profileFromVehicle(vehicle);

    if (!region) {
      return res.json(await loadStaticAgentDemos());
    }

    try {
      // Set tracking query tag for attribution.
      await runSql(
        `ALTER SESSION SET query_tag = '{"origin":"sf_sit-is-fleet","name":"oss-routing-agent","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}'`,
        'OPENROUTESERVICE_APP', 'CORE',
      );

      // Resolve region centroid from REGION_CATALOG (boundary preferred).
      const regionLit = escapeString(region);
      const mCentroid = regionCatalogMatch('rc', `'${regionLit}'`);
      const centroidRows = await runSql(
        `SELECT
            rc.REGION_NAME AS REGION_NAME,
            rc.COUNTRY AS COUNTRY,
            rc.CONTINENT AS CONTINENT,
            ST_X(ST_CENTROID(rc.BOUNDARY))::FLOAT AS CENTROID_LON,
            ST_Y(ST_CENTROID(rc.BOUNDARY))::FLOAT AS CENTROID_LAT,
            (rc.MIN_LAT + rc.MAX_LAT)/2.0 AS BBOX_LAT,
            (rc.MIN_LON + rc.MAX_LON)/2.0 AS BBOX_LON
         FROM OPENROUTESERVICE_APP.CORE.REGION_CATALOG rc
         WHERE rc.BOUNDARY IS NOT NULL
           AND ${mCentroid.predicate}
         ORDER BY ${mCentroid.rank}
         LIMIT 1`,
        'OPENROUTESERVICE_APP', 'CORE',
      );

      let regionLabel = region;
      let country = '';
      let continent = '';
      let centroidLat: number | null = null;
      let centroidLon: number | null = null;
      if (centroidRows?.[0]) {
        regionLabel = centroidRows[0].REGION_NAME || region;
        country = centroidRows[0].COUNTRY || '';
        continent = centroidRows[0].CONTINENT || '';
        centroidLat = centroidRows[0].CENTROID_LAT ?? centroidRows[0].BBOX_LAT ?? null;
        centroidLon = centroidRows[0].CENTROID_LON ?? centroidRows[0].BBOX_LON ?? null;
      }

      const isSF = /san[\s-]?francisco/i.test(region) || /^sf$/i.test(region);

      const promptText =
        `You are generating example prompts for a routing/fleet AI playground. ` +
        `The active map region is "${regionLabel}"${country ? ` (${country}${continent ? ', ' + continent : ''})` : ''}` +
        (centroidLat != null && centroidLon != null ? ` centred near lat ${centroidLat.toFixed(4)}, lon ${centroidLon.toFixed(4)}` : '') +
        `. The active vehicle type is "${vehicle || 'car'}" mapped to ORS profile "${profile}". ` +
        `\n\nGenerate 2 scenario tabs, each with 4-5 short example prompts that exercise these tools: ` +
        `tool_directions (point-to-point routing), tool_isochrone (drive/cycle/walk-time reachability polygons), ` +
        `tool_poi_in_isochrone (Overture Maps POI search inside an isochrone, e.g. pharmacies, restaurants, shops), ` +
        `tool_route_optimization (multi-vehicle VRP with depot + stops). ` +
        (isSF ? `You may also include the pre-configured demo tools: tool_network_optimization, tool_delivery_optimization, tool_catchment. ` : '') +
        `\n\nRules:` +
        `\n- Use REAL street addresses, neighbourhoods, or landmarks within "${regionLabel}". Do NOT invent SF addresses for non-SF regions.` +
        `\n- Each prompt must read like a natural-language question a dispatcher would ask.` +
        `\n- Reference the vehicle type / ORS profile where appropriate (e.g. cycling, HGV, walking).` +
        `\n- Use ONLY plain ASCII apostrophes (') and double quotes ("). No smart quotes.` +
        `\n- Each prompt label must start with "1. ", "2. ", etc.` +
        `\n- Each scenario needs an id (kebab-case), label, single emoji icon, short description, and 4-5 prompt entries.` +
        `\n\nReturn ONLY valid JSON, no markdown fences, in this exact shape:\n` +
        `{"default_scenario":"<id>","scenarios":[{"id":"...","label":"...","icon":"...","description":"...","prompts":[{"label":"1. ...","icon":"...","prompt":"..."}]}]}`;

      const cortexSql = `SELECT SNOWFLAKE.CORTEX.COMPLETE('claude-sonnet-4-5', '${escapeString(promptText)}') AS RESULT`;
      const cortexRows = await runSql(cortexSql, 'OPENROUTESERVICE_APP', 'CORE');
      const raw = cortexRows?.[0]?.RESULT;
      const parsed = typeof raw === 'string' ? extractFirstJson(raw) : (raw && typeof raw === 'object' ? raw : null);

      if (parsed && Array.isArray(parsed.scenarios) && parsed.scenarios.length > 0) {
        const cleaned = {
          version: '1.0',
          default_scenario: parsed.default_scenario || parsed.scenarios[0].id,
          max_token_limit: 8000,
          scenarios: parsed.scenarios.map((s: any, i: number) => ({
            id: String(s.id || `scenario-${i + 1}`),
            label: String(s.label || `Scenario ${i + 1}`),
            icon: String(s.icon || '\u{1F4CD}'),
            description: String(s.description || ''),
            prompts: Array.isArray(s.prompts)
              ? s.prompts.slice(0, 6).map((p: any, j: number) => ({
                  label: String(p.label || `${j + 1}. Example`),
                  icon: String(p.icon || '\u{1F4CD}'),
                  prompt: String(p.prompt || ''),
                })).filter((p: any) => p.prompt)
              : [],
          })).filter((s: any) => s.prompts.length > 0),
        };
        if (cleaned.scenarios.length > 0) {
          return res.json(cleaned);
        }
      }
      console.log(`[agent/examples] AI_COMPLETE returned unparseable JSON for region=${region} vehicle=${vehicle}, falling back`);
    } catch (e: any) {
      console.log(`[agent/examples] Generation failed for region=${region} vehicle=${vehicle}: ${e.message}`);
    }
    res.json(await loadStaticAgentDemos());
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
    const { message, thread_id, parent_message_id, history, region, vehicle_type, profile } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const activeRegion: string = (typeof region === 'string' && region) ? region : 'SanFrancisco';
    const activeProfile: string = (typeof profile === 'string' && profile) ? profile : profileFromVehicle(String(vehicle_type || ''));
    const activeVehicle: string = (typeof vehicle_type === 'string' && vehicle_type) ? vehicle_type : '';
    const TOOL_PROC_MAP = buildToolProcMap(activeRegion, activeProfile);
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
      // Inject a hidden first-turn context note so the LLM defaults tool args
      // to the active region + ORS profile chosen in the UI header.
      if (activeRegion || activeVehicle) {
        const ctx =
          `Context for this conversation: active map region = ${activeRegion || 'unknown'}; ` +
          `active vehicle type = ${activeVehicle || 'unknown'} (ORS profile = ${activeProfile}). ` +
          `When you call routing tools, default the 'region' argument to "${activeRegion}" ` +
          `and the 'profile' argument to "${activeProfile}" unless the user explicitly asks for a different region or transport mode. ` +
          `Geocode all place names within "${activeRegion}" by default.`;
        messages.push({ role: 'user', content: [{ type: 'text', text: ctx }] });
        messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Understood. I will default to the active region and profile.' }] });
      }
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
