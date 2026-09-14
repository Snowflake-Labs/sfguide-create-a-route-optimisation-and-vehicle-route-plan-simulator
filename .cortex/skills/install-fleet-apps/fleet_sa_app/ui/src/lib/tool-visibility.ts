// Which tool results the chat shows, and which the agent's own prose already
// covers.
//
// WHY THIS IS A MODULE. This logic lived as a three-name array inside
// message-part.tsx, where it could not be tested and one of its three entries had
// never matched anything. It is now pure and exported so the harness can drive it
// against real captured payloads.
//
// THE BUG IT FIXES. The array read:
//
//   ['execute_workflow', 'resume_workflow', 'cortex_analyst_text_to_sql']
//
// `cortex_analyst_text_to_sql` is the tool TYPE. The agent spec declares THIRTEEN
// analyst tools whose NAMES are `query_dwell`, `query_fleet_ops`, `query_labor`
// and so on, and cortex-stream resolves `name || type`, so the name always wins.
// `matchesTool('query_dwell', 'cortex_analyst_text_to_sql')` is false for every
// one of them, so that entry never suppressed a single result: each analytics turn
// dumped its ENTIRE semantic model - custom instructions, SQL best practices,
// every dimension and metric - into the transcript as a collapsed JSON blob.
// Redundant as well as noisy, since the analyst rows already render as a table via
// the `response.tool_result.analyst.delta` branch.
//
// SHAPE, NOT NAME. The obvious fix is to list the 13 names, in config or in code.
// Rejected: that list goes stale the moment a semantic view is added, and the
// staleness is silent - exactly the failure mode being fixed. An analyst result is
// instead recognised by its PAYLOAD, which carries `semantic_model_key` /
// `semantic_view_fqn` however the tool is named. A new query_* tool is covered on
// the day it is added, with no edit here.

import { matchesTool } from './tool-names';

/** Tools whose result the agent narrates, matched by NAME.
 *
 *  Only names that are FIXED belong here. `cortex_analyst_text_to_sql` is kept
 *  because a host that sends the type rather than the name should still be
 *  suppressed, but it is not load-bearing - `isAnalystModelDump` is what actually
 *  covers the analyst tools. */
export const SUPPRESS_RESULT_SUFFIXES = [
  'execute_workflow',
  'resume_workflow',
  'cortex_analyst_text_to_sql',
  // The host's SQL executor. Its rows reach the user either as a rendered table
  // or as the agent's own markdown; the raw {query_id, sql, result_set} envelope
  // is duplicate.
  'system_execute_sql',
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * True when a payload is a Cortex Analyst semantic-model response.
 *
 * Keyed on `semantic_model_key` / `semantic_view_fqn` / `semantic_model_path`,
 * which the response carries regardless of what the tool is called - so this
 * cannot go stale as semantic views are added. The `sql_best_practices` + `tables`
 * pair is a fallback for a response that omits the keys.
 */
export function isAnalystModelDump(output: unknown): boolean {
  if (!isObject(output)) return false;
  if (typeof output.semantic_model_key === 'string') return true;
  if (typeof output.semantic_view_fqn === 'string') return true;
  if (typeof output.semantic_model_path === 'string') return true;
  return typeof output.sql_best_practices === 'string' && output.tables !== undefined;
}

/** True when a payload is the host SQL executor's envelope. */
export function isSqlExecutionResult(output: unknown): boolean {
  return isObject(output) && output.result_set !== undefined
    && (typeof output.sql === 'string' || typeof output.query_id === 'string');
}

/** True when the chat should not render this tool result at all. */
export function isSuppressedResult(toolName: string | undefined, output?: unknown): boolean {
  if (toolName && SUPPRESS_RESULT_SUFFIXES.some((s) => matchesTool(toolName, s))) return true;
  return isAnalystModelDump(output) || isSqlExecutionResult(output);
}

/**
 * The name to RECORD for a tool result, for `AGENT_TURN.TOOLS_USED`.
 *
 * A fired agent skill arrives as `server_skill` for every skill, so the turn
 * record proved that A skill fired and never WHICH - which is exactly why
 * "did the agent select the CoWork skill" could not be answered from SQL after the
 * skill front matter was repaired. The payload carries `skill_name`, so the
 * recorded name becomes `server_skill:dwell-facilities`.
 *
 * Prefixed rather than replaced so existing queries that filter on
 * `server_skill` keep working with a STARTSWITH, and returns the bare name
 * unchanged when there is nothing to attribute.
 */
export function attributeTool(toolName: string, output?: unknown): string {
  if (!matchesTool(toolName, 'server_skill')) return toolName;
  if (!isObject(output)) return toolName;
  const raw = output.skill_name ?? output.skillName;
  if (typeof raw !== 'string' || !raw.trim()) return toolName;
  // Bounded: this lands in an ARRAY column alongside up to MAX_TOOLS entries.
  return `${toolName}:${raw.trim().slice(0, 60)}`;
}
