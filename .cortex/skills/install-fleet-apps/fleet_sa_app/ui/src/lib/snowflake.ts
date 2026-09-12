// Shared Snowflake REST API client for Next.js app (used by workflow engine routes)
// Dual-mode auth via getSnowflakeAuth(): SPCS OAuth (token file) or local PAT.
import { getSnowflakeAuth } from './sf-auth';
import { WAREHOUSE, BATCH_WAREHOUSE } from './warehouse';

const warehouse = WAREHOUSE;
const role = process.env.SNOWFLAKE_ROLE ?? 'ACCOUNTADMIN';

// Attribution tag (AGENTS.md): every statement this helper runs is tagged so the
// SA app's Snowflake traffic (workflow engine, /api/tool, /api/chat) is attributable
// in QUERY_HISTORY. Set as a session parameter on every REST call.
export const QUERY_TAG = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}';

interface SnowflakeResponse {
  statementHandle?: string;
  resultSetMetaData?: { rowType: Array<{ name: string; type: string }> };
  data?: string[][];
  message?: string;
  code?: string;
  numUpdatedRows?: number;
  numRowsInserted?: number;
}

async function callSnowflake(sql: string, bindings?: Record<string, { type: string; value: string }>, wh: string = warehouse): Promise<SnowflakeResponse> {
  const auth = getSnowflakeAuth();
  // 80s statement timeout: must stay under the 90s SPCS ingress connection
  // timeout so a slow-but-valid call (e.g. routing/isochrone ops while ORS is
  // under load) still returns synchronously instead of going async + polling
  // past the ingress limit (which surfaces to the browser as a 504
  // "upstream request timeout" that fails JSON.parse).
  const body: Record<string, unknown> = { statement: sql, timeout: 80, warehouse: wh, role, parameters: { QUERY_TAG } };
  if (bindings) body.bindings = bindings;

  const response = await fetch(`${auth.baseUrl}/api/v2/statements`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${auth.token}`,
      'X-Snowflake-Authorization-Token-Type': auth.tokenType,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Snowflake API ${response.status}: ${text}`);

  const result: SnowflakeResponse = JSON.parse(text);
  if (result.statementHandle && !result.resultSetMetaData && !result.data) {
    return pollResult(result.statementHandle);
  }
  return result;
}

async function pollResult(handle: string): Promise<SnowflakeResponse> {
  const auth = getSnowflakeAuth();
  const url = `${auth.baseUrl}/api/v2/statements/${handle}`;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await fetch(url, { headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json', 'X-Snowflake-Authorization-Token-Type': auth.tokenType } });
    const result: SnowflakeResponse = await r.json() as SnowflakeResponse;
    if (result.resultSetMetaData || result.data || result.message?.includes('success')) return result;
  }
  // CANCEL before throwing. The statement carries `timeout: 80` while this loop
  // gives up at 30x2s = 60s, so an abandoned solve kept running - and kept its
  // warehouse slot - for up to another 20 seconds after the caller had already
  // failed. That makes the contention that caused the timeout measurably worse.
  // /api/query already cancels on its giveup path; this one did not.
  try {
    await fetch(`${auth.baseUrl}/api/v2/statements/${handle}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json',
        'X-Snowflake-Authorization-Token-Type': auth.tokenType,
      },
    });
  } catch { /* best-effort: a failed cancel must not mask the real error */ }
  throw new Error(`Statement ${handle} timed out after 60s (cancelled)`);
}

function rowToObject(row: string[], cols: Array<{ name: string; type: string }>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  cols.forEach((col, i) => {
    const raw = row[i];
    if (raw === null || raw === undefined) { obj[col.name] = null; return; }
    obj[col.name] = (col.type === 'fixed' || col.type === 'real' || col.type === 'float') ? Number(raw) : raw;
  });
  return obj;
}

export type QueryRow = Record<string, unknown>;

export async function query<T = QueryRow>(sql: string, binds: (string | number | null)[] = []): Promise<T[]> {
  const bindings: Record<string, { type: string; value: string }> = {};
  binds.forEach((v, i) => {
    bindings[String(i + 1)] = {
      type: v === null ? 'TEXT' : typeof v === 'number' ? 'FIXED' : 'TEXT',
      value: v === null ? '' : String(v),
    };
  });
  const result = await callSnowflake(sql, binds.length > 0 ? bindings : undefined);
  const cols = result.resultSetMetaData?.rowType ?? [];
  return (result.data ?? []).map((row) => rowToObject(row, cols) as T);
}

// Same semantics as query(), on the BATCH warehouse. For synchronous solver calls
// that would otherwise hold an interactive slot for the length of a VRP solve.
// NOTE this fixes STARVATION, not the ceiling: pollResult still gives up at 60s
// and the statement is capped at 80s to stay under the ~90s SPCS ingress limit,
// so a solve needing longer cannot complete synchronously on either warehouse.
export async function queryBatch<T = QueryRow>(sql: string, binds: (string | number | null)[] = []): Promise<T[]> {
  const bindings: Record<string, { type: string; value: string }> = {};
  binds.forEach((v, i) => {
    bindings[String(i + 1)] = {
      type: v === null ? 'TEXT' : typeof v === 'number' ? 'FIXED' : 'TEXT',
      value: v === null ? '' : String(v),
    };
  });
  const result = await callSnowflake(sql, binds.length > 0 ? bindings : undefined, BATCH_WAREHOUSE);
  const cols = result.resultSetMetaData?.rowType ?? [];
  return (result.data ?? []).map((row) => rowToObject(row, cols) as T);
}

export async function run(sql: string, binds: (string | number | null)[] = []): Promise<number> {
  const bindings: Record<string, { type: string; value: string }> = {};
  binds.forEach((v, i) => {
    bindings[String(i + 1)] = {
      type: v === null ? 'TEXT' : typeof v === 'number' ? 'FIXED' : 'TEXT',
      value: v === null ? '' : String(v),
    };
  });
  const result = await callSnowflake(sql, binds.length > 0 ? bindings : undefined);
  return result.numUpdatedRows ?? result.numRowsInserted ?? 0;
}
