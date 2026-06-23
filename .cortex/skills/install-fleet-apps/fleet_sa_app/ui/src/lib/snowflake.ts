// Shared Snowflake REST API client for Next.js app (used by workflow engine routes)
// Dual-mode auth via getSnowflakeAuth(): SPCS OAuth (token file) or local PAT.
import { getSnowflakeAuth } from './sf-auth';

const warehouse = process.env.SNOWFLAKE_WAREHOUSE ?? 'COMPUTE_WH';
const role = process.env.SNOWFLAKE_ROLE ?? 'ACCOUNTADMIN';

interface SnowflakeResponse {
  statementHandle?: string;
  resultSetMetaData?: { rowType: Array<{ name: string; type: string }> };
  data?: string[][];
  message?: string;
  code?: string;
  numUpdatedRows?: number;
  numRowsInserted?: number;
}

async function callSnowflake(sql: string, bindings?: Record<string, { type: string; value: string }>): Promise<SnowflakeResponse> {
  const auth = getSnowflakeAuth();
  const body: Record<string, unknown> = { statement: sql, timeout: 60, warehouse, role };
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
  throw new Error(`Statement ${handle} timed out`);
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
