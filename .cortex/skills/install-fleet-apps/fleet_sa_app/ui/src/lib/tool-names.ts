// How a streamed Cortex tool name is matched to a bare verb name, and how a
// verb's result envelope is peeled. Both live here because both were previously
// guessed, independently, at seven call sites.
//
// MEASURED, not assumed. `FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN.TOOLS_USED`
// records the name this client actually received, and for the MCP server
// `OPENROUTESERVICE_APP.ROUTING.ROUTING_MCP` it is:
//
//     routing_mcp_render_map
//
// ONE underscore between the server prefix and the verb, not two. Every site in
// this app except the `show_view` branch matched on `'__'`, so `lastIndexOf('__')`
// returned -1 and the lookup failed - silently, because an unregistered tool is a
// legal state that falls through to the raw JSON viewer. That is why a healthy
// `render_map` (VERB_ATTEMPT outcome 'ok') rendered as a collapsed JSON blob, and
// why `render_view` and MCP `propose_write` had never fired at all.

/**
 * True when a streamed tool name refers to `bare`.
 *
 * Deliberately prefix-AGNOSTIC rather than stripping a known `routing_mcp_`:
 * the prefix is derived from the MCP server object name, so hardcoding it means
 * renaming or adding a server silently breaks rendering again. Matching the
 * suffix survives both separator conventions (`_` and `__`) and any prefix.
 *
 * Tradeoff, accepted: a genuinely DIFFERENT tool literally named
 * `something_render_map` would now collide with `render_map`. No registered name
 * is a suffix of another today, and a rare false match is strictly better than
 * the current guaranteed total failure.
 */
export function matchesTool(toolName: string | undefined, bare: string): boolean {
  if (!toolName) return false;
  return toolName === bare || toolName.endsWith('_' + bare);
}

/**
 * The name the CHART tool actually arrives under.
 *
 * MEASURED from live turns via `SEMANTIC_OPS.AGENT_TURN.TOOLS_USED`: the host
 * declares the tool as `data_to_chart` (see app/agent-spec.json `tools[].name`)
 * and streams its result as a `response.tool_result` with `name:
 * "data_to_chart"` and an output of `{ charts: [ "<vega-lite spec json>" ] }`.
 *
 * The inline registry only knew `render_chart`, so the `data_to_chart` result
 * matched nothing and rendered as a collapsed JSON blob - an unregistered tool is
 * a LEGAL state, so the miss was silent. Same class as the
 * `routing_mcp_render_map` separator bug above.
 *
 * The host ALSO emits a duplicate `response.chart` event for the same chart, which
 * cortex-stream used to map to `render_chart` - so that name did fire, and drew a
 * broken recharts translation rather than nothing. TOOLS_USED for one turn records
 * `data_to_chart` AND `render_chart`. Both names are therefore registered, and
 * cortex-stream deduplicates on spec content so the chart is drawn once.
 */
export const CHART_TOOL_NAME = 'data_to_chart';

/** Every name a chart result can arrive under: the tool_result name plus the name
 *  the duplicate `response.chart` event was historically mapped to. */
export const CHART_TOOL_ALIASES = [CHART_TOOL_NAME, 'render_chart'] as const;

/** True when a streamed tool name is a chart result under any known alias. */
export function isChartTool(toolName: string | undefined): boolean {
  return CHART_TOOL_ALIASES.some((n) => matchesTool(toolName, n));
}

/** Hops allowed when peeling a result envelope. Bounds a pathological or
 *  self-referential payload; 4 is well clear of the 2 levels observed. */
const MAX_UNWRAP_HOPS = 4;

/** Keys that identify a spec body, i.e. tell us to STOP peeling. `layers` is an
 *  inline map spec, `config`/`component` the area-shaped form a render_view
 *  page area uses. Without this an envelope whose payload legitimately contains
 *  its own `result` field would be peeled one hop too far. */
const SPEC_KEYS = ['layers', 'config', 'component', 'areas'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Peel a verb result envelope down to the spec body.
 *
 * A synapse verb returning `{result: spec}` reaches this client DOUBLE-wrapped:
 * the observed `render_map` payload was
 *
 *     { "result": "{\n  \"result\": { ...spec... }\n}" }
 *
 * - an outer object whose `result` is a pretty-printed JSON STRING of the inner
 * envelope. `extractToolOutput` in cortex-stream peels exactly one layer, so
 * consumers doing `props.result ?? props` were handed a string, and
 * `parseMapSpec` (which does parse a top-level string) then produced
 * `{result:{...}}` - an object with no `layers`, rejected as a malformed spec.
 *
 * Each hop either JSON-parses a string or unwraps a SOLE `result` key. Stops on
 * a spec body, on a non-envelope object, or when the hop budget runs out; always
 * returns something for the caller's own validator to reject by name.
 */
export function unwrapVerbResult(raw: unknown): unknown {
  let cur = raw;
  for (let hop = 0; hop < MAX_UNWRAP_HOPS; hop++) {
    if (typeof cur === 'string') {
      const text = cur.trim();
      // Only attempt a parse when it plausibly IS JSON, so a genuine string
      // payload is returned as-is rather than swallowed by a caught throw.
      if (!text.startsWith('{') && !text.startsWith('[')) return cur;
      try {
        cur = JSON.parse(text);
      } catch {
        return cur;
      }
      continue;
    }
    if (!isPlainObject(cur)) return cur;
    // A spec body wins over the envelope rule: stop before peeling too far.
    if (SPEC_KEYS.some((k) => cur !== null && (cur as Record<string, unknown>)[k] !== undefined)) {
      return cur;
    }
    if (cur.result === undefined) return cur;
    cur = cur.result;
  }
  return cur;
}
