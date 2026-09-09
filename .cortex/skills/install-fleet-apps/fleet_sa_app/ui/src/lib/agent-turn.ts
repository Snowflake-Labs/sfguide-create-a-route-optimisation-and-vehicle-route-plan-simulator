/**
 * Agent turn recorder.
 *
 * WHY THIS EXISTS
 * Nothing on the Snowflake side records what the agent was ASKED. The synapse
 * envelope audits verb calls (VERB_ATTEMPT) and CORTEX_AGENT_USAGE_HISTORY
 * records one row per turn with duration, tokens and credits - but neither holds
 * the question, the answer, or which tools the agent chose. So a question the
 * agent answered badly, or answered from a Cortex Analyst tool with no verb call
 * at all, left no trace anywhere. This route is the only place all of it exists
 * at once.
 *
 * Feeds FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN, which VW_AGENT_TURNS joins to
 * the platform history on REQUEST_ID.
 *
 * THE CORRELATION ID IS BEST-EFFORT BY DESIGN
 * We generate a TURN_ID unconditionally and store the platform REQUEST_ID only if
 * the response exposes one. Two reasons not to depend on it:
 *   1. The header name is not contractual. We read several candidates rather than
 *      assume one, and a miss must not lose the row - a turn with a null
 *      REQUEST_ID still carries its question, tools and latency, it just cannot
 *      be joined to the platform's cost figures.
 *   2. There is no equivalent for the verb side at all. A stored procedure cannot
 *      see the agent request (the agent-invoked CALL does not even appear in
 *      QUERY_HISTORY), which is why VW_AGENT_TURN_VERBS joins on actor plus time
 *      window and flags ambiguity instead of pretending to an exact link.
 *
 * FAILURE IS ALWAYS SWALLOWED
 * Observability must never break the thing it observes. Every path here catches
 * and logs. A missing AGENT_TURN row costs a line in a report; a chat request
 * that 500s because a logging insert failed costs the user their answer.
 */
import { run } from '@/lib/snowflake';
import { logger } from '@/lib/logger';

/** Cap on stored text. Questions and answers are unbounded in principle. */
const MAX_TEXT = 8000;
/** Cap on distinct tool names recorded for one turn. */
const MAX_TOOLS = 40;

export interface AgentTurnRecord {
  turnId: string;
  requestId: string | null;
  startedAt: number;
  endedAt: number;
  agentName: string | null;
  actor: string | null;
  interface: string;
  question: string | null;
  answer: string | null;
  toolsUsed: string[];
  toolErrors: string[];
  activeView: string | null;
  region: string | null;
  vehicleType: string | null;
  datasetId: string | null;
  firstPartMs: number | null;
  outcome: string;
  errorMessage: string | null;
}

/**
 * Pull the platform request id out of the Cortex response.
 *
 * Deliberately tries several header names: the id is not part of a documented
 * contract we can rely on, and the cost of guessing wrong is a null column
 * rather than a broken turn. Whichever one actually lines up with
 * CORTEX_AGENT_USAGE_HISTORY.REQUEST_ID is confirmed by measuring the join rate
 * in VW_AGENT_TURNS after deploy, not by assumption here.
 */
export function extractRequestId(headers: Headers): string | null {
  const candidates = [
    'x-snowflake-request-id',
    'x-snowflake-query-id',
    'x-request-id',
    'sf-request-id',
  ];
  for (const name of candidates) {
    const v = headers.get(name);
    if (v && v.trim() !== '') return v.trim();
  }
  return null;
}

function clip(s: string | null, max = MAX_TEXT): string | null {
  if (s === null) return null;
  const t = s.trim();
  if (t === '') return null;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Insert one turn. Fire-and-forget: callers must NOT await this on the response
 * path.
 *
 * INSERT ... SELECT rather than VALUES, because the two ARRAY columns need
 * PARSE_JSON and a VALUES clause cannot contain function calls. The JSON is
 * passed as a BIND, never interpolated into the statement - a tool name or a
 * question containing an apostrophe would otherwise break the parse (and
 * questions are free text from a user, so that is a matter of time, not luck).
 */
export async function recordAgentTurn(rec: AgentTurnRecord): Promise<void> {
  try {
    const sql =
      `INSERT INTO FLEET_INTELLIGENCE.SEMANTIC_OPS.AGENT_TURN ` +
      `(TURN_ID, REQUEST_ID, STARTED_AT, ENDED_AT, AGENT_NAME, ACTOR, INTERFACE, ` +
      ` QUESTION, ANSWER, TOOLS_USED, TOOL_ERRORS, ACTIVE_VIEW, REGION, VEHICLE_TYPE, ` +
      ` DATASET_ID, FIRST_PART_MS, TOTAL_MS, OUTCOME, ERROR_MESSAGE) ` +
      `SELECT ?, ?, TO_TIMESTAMP_TZ(?::NUMBER, 3), TO_TIMESTAMP_TZ(?::NUMBER, 3), ?, ?, ?, ` +
      ` ?, ?, PARSE_JSON(?)::ARRAY, PARSE_JSON(?)::ARRAY, ?, ?, ?, ?, ?, ?, ?, ?`;

    const tools = Array.from(new Set(rec.toolsUsed)).slice(0, MAX_TOOLS);
    const errors = rec.toolErrors.slice(0, MAX_TOOLS).map((e) => clip(e, 500) ?? '');

    await run(sql, [
      rec.turnId,
      rec.requestId,
      rec.startedAt,
      rec.endedAt,
      rec.agentName,
      rec.actor,
      rec.interface,
      clip(rec.question),
      clip(rec.answer),
      JSON.stringify(tools),
      JSON.stringify(errors),
      rec.activeView,
      rec.region,
      rec.vehicleType,
      rec.datasetId,
      rec.firstPartMs,
      rec.endedAt - rec.startedAt,
      rec.outcome,
      clip(rec.errorMessage, 2000),
    ]);
  } catch (err) {
    // Never rethrow. See the header note: a lost row is cheaper than a lost answer.
    logger.warn('agent-turn-record-failed', { turnId: rec.turnId, error: String(err) });
  }
}
