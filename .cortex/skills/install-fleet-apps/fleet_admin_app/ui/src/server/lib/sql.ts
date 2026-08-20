// Snowflake SQL execution helpers. Two transports:
//   - snowSqlLocal:  shell out to `snow sql -c <conn>` for local dev
//   - snowSqlSpcs:   call /api/v2/statements directly inside SPCS
// `runSql` picks the right transport based on IS_SPCS at call time.

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { IS_SPCS, SF_DATABASE, SF_WAREHOUSE, CONN, SNOWFLAKE_HOST } from '../constants';
import { getSpcsToken } from './sanitize';
import { log } from '../diagnostics';

const QUERY_TAG_VALUE = '{"origin":"sf_sit-is-fleet","name":"oss-install-fleet-apps","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

export function snowSqlLocal(sql: string, database?: string, schema?: string): any[] {
  const tmpFile = join(tmpdir(), `ors_query_${Date.now()}.sql`);
  const db = database || SF_DATABASE;
  let fullSql = `ALTER SESSION SET TIMEZONE='UTC';\nALTER SESSION SET query_tag = '${QUERY_TAG_VALUE}';\nUSE WAREHOUSE ${SF_WAREHOUSE};\nUSE DATABASE ${db};\n`;
  if (schema) fullSql += `USE SCHEMA ${schema};\n`;
  fullSql += `${sql};`;
  writeFileSync(tmpFile, fullSql);
  try {
    const result = execSync(`snow sql -c ${CONN} -f "${tmpFile}" --format json 2>/dev/null`, {
      maxBuffer: 50 * 1024 * 1024, timeout: 120000, encoding: 'utf-8',
    });
    const parsed = JSON.parse(result.trim());
    if (Array.isArray(parsed) && Array.isArray(parsed[0])) return parsed[parsed.length - 1];
    return parsed;
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

export async function snowSqlSpcs(sql: string, database?: string, schema?: string, timeoutSecs: number = 600): Promise<any[]> {
  const token = getSpcsToken();
  const body = { statement: sql, timeout: timeoutSecs, database: database || SF_DATABASE, schema: schema || 'CORE', warehouse: SF_WAREHOUSE, parameters: { QUERY_TAG: QUERY_TAG_VALUE, TIMEZONE: 'UTC' } };
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
    'Accept': 'application/json', 'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  console.log(`[SQL API] Executing: ${sql.slice(0, 200)} (WH: ${SF_WAREHOUSE}, DB: ${SF_DATABASE}, HOST: ${SNOWFLAKE_HOST})`);
  const sqlStart = Date.now();
  const res = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const errBody = (await res.text()).slice(0, 500);
    log('ERROR', 'SQL', `API error ${res.status}: ${errBody.slice(0, 200)}`, { durationMs: Date.now() - sqlStart });
    throw new Error(`SQL API error ${res.status}: ${errBody}`);
  }
  let result: any = await res.json();
  if (result.statementStatusUrl && (!result.data || result.code === '333334')) {
    const pollUrl = `https://${SNOWFLAKE_HOST}${result.statementStatusUrl}`;
    // Backoff poll instead of a flat 5s. Short statements (e.g. per-leg ORS
    // DIRECTIONS calls in Data Studio generation) usually finish in well under
    // a second, so a fixed 5s interval taxed every async-path route ~5s. Start
    // at 300ms and ramp to a 3s cap for genuinely long statements. Overall
    // bound stays ~10 min (matches the previous 120 x 5s ceiling).
    const deadline = Date.now() + 600_000;
    let delay = 300;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, delay));
      const pr = await fetch(pollUrl, { headers });
      result = await pr.json();
      if (result.data || (result.code && result.code !== '333334')) break;
      delay = Math.min(Math.floor(delay * 1.5), 3000);
    }
  }
  if (result.message && !result.data) {
    log('ERROR', 'SQL', `Statement error: ${result.message?.slice(0, 200)}`, { durationMs: Date.now() - sqlStart });
    throw new Error(`SQL error: ${result.message}`);
  }
  if (!result.data) return [];
  return mapSqlApiResult(result, headers);
}

// Map a Snowflake SQL REST API result object into row objects with JS-native
// types, fetching any extra partitions. Shared by the synchronous transport
// and the async-by-handle path.
async function mapSqlApiResult(result: any, headers: Record<string, string>): Promise<any[]> {
  const rowType: any[] = result.resultSetMetaData?.rowType || [];
  const cols = rowType.map((c: any) => c.name);
  // The Snowflake SQL REST API returns ALL values as strings inside `data`
  // arrays (numerics, booleans, dates, etc). Without coercion, every numeric
  // column in the React app arrives as a string and `(x as number).toFixed()`
  // throws - the canonical mask for "blank page on Freight Exchange". Coerce
  // by `rowType[i].type` here so callers get JS-native types. BIGINTs
  // (NUMBER with precision > 15, scale 0) stay as strings to preserve
  // precision; everything else (`real`, `fixed` with safe precision/scale,
  // `boolean`) is converted.
  const coercers: Array<(v: any) => any> = rowType.map((c: any) => {
    const t = String(c?.type || '').toLowerCase();
    if (t === 'real') return (v: any) => (v == null ? v : Number(v));
    if (t === 'fixed') {
      const scale = Number(c?.scale ?? 0);
      const precision = Number(c?.precision ?? 0);
      if (scale === 0 && precision > 15) return (v: any) => v; // preserve BIGINT
      return (v: any) => (v == null ? v : Number(v));
    }
    if (t === 'boolean') return (v: any) => {
      if (v == null) return v;
      if (typeof v === 'boolean') return v;
      return v === 'true' || v === true;
    };
    return (v: any) => v;
  });
  let allData: any[][] = [...(result.data || [])];
  const partitions = result.resultSetMetaData?.partitionInfo;
  if (partitions && partitions.length > 1) {
    const handle = result.statementHandle;
    console.log(`[SQL API] Result has ${partitions.length} partitions (${result.resultSetMetaData?.numRows} rows). Fetching remaining...`);
    for (let p = 1; p < partitions.length; p++) {
      const pr = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements/${handle}?partition=${p}`, { headers });
      const partResult: any = await pr.json();
      if (partResult.data) allData = allData.concat(partResult.data);
    }
  }
  console.log(`[SQL API] Returning ${allData.length} rows`);
  return allData.map((row: any[]) => {
    const obj: Record<string, any> = {};
    cols.forEach((c: string, i: number) => { obj[c] = coercers[i](row[i]); });
    return obj;
  });
}

export async function runSql(sql: string, database?: string, schema?: string): Promise<any[]> {
  if (IS_SPCS) return snowSqlSpcs(sql, database, schema);
  return snowSqlLocal(sql, database, schema);
}

export async function callProcedure(proc: string): Promise<string> {
  const rows = await runSql(`CALL ${SF_DATABASE}.CORE.${proc}`);
  return rows?.[0]?.[Object.keys(rows[0])[0]] || '';
}

// Async statement submission - returns a Snowflake statementHandle for
// long-running queries. Caller polls / cancels via cancelStatement.
// db/schema let callers target the right namespace (e.g. EMERGENCY_RESPONSE).
export async function submitSqlAsync(sql: string, database?: string, schema?: string): Promise<string> {
  if (!IS_SPCS) {
    // Local dev: run synchronously now, stash rows under a handle the
    // fetch-by-handle path can pop. Keeps `npm run dev` working without SPCS.
    const handle = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      localResultCache.set(handle, { rows: snowSqlLocal(sql, database, schema), ts: Date.now() });
    } catch (e: any) {
      localResultCache.set(handle, { error: e?.message || String(e), ts: Date.now() });
    }
    pruneLocalCache();
    return handle;
  }
  const token = getSpcsToken();
  const body = { statement: sql, timeout: 0, database: database || SF_DATABASE, schema: schema || 'CORE', warehouse: SF_WAREHOUSE, parameters: { QUERY_TAG: QUERY_TAG_VALUE, TIMEZONE: 'UTC' } };
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
    'Accept': 'application/json', 'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  console.log(`[SQL API Async] Submitting: ${sql.slice(0, 200)}`);
  const r = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const errBody = (await r.text()).slice(0, 500);
    throw new Error(`SQL API error ${r.status}: ${errBody}`);
  }
  const result = await r.json();
  return result.statementHandle || '';
}

// One-shot result retrieval for a previously submitted async statement.
// Returns { status: 'running' } while the query is still executing, or
// { rows } once complete. Throws on statement error. Each call is a short
// request, so the browser can poll without holding a long-lived connection.
export async function fetchResultByHandle(handle: string): Promise<{ status: 'running' } | { rows: any[] }> {
  if (!handle) throw new Error('handle required');
  if (handle.startsWith('local_')) {
    const entry = localResultCache.get(handle);
    if (!entry) return { rows: [] }; // already consumed or unknown
    localResultCache.delete(handle);
    if (entry.error) throw new Error(entry.error);
    return { rows: entry.rows || [] };
  }
  const token = getSpcsToken();
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
    'Accept': 'application/json', 'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  const r = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements/${handle}`, { headers });
  if (r.status === 202) return { status: 'running' };
  const result: any = await r.json();
  if (result.code === '333334' || (result.statementStatusUrl && !result.data && !result.message)) {
    return { status: 'running' };
  }
  if (result.message && !result.data) {
    throw new Error(`SQL error: ${result.message}`);
  }
  if (!result.data) return { rows: [] };
  return { rows: await mapSqlApiResult(result, headers) };
}

// In-memory result cache for the local-dev async path. Short TTL + size cap
// so a long-running dev server doesn't leak.
const localResultCache = new Map<string, { rows?: any[]; error?: string; ts: number }>();
const LOCAL_CACHE_TTL = 600_000; // 10 min
function pruneLocalCache(): void {
  const now = Date.now();
  for (const [k, v] of localResultCache) {
    if (now - v.ts > LOCAL_CACHE_TTL) localResultCache.delete(k);
  }
  if (localResultCache.size > 200) {
    const oldest = [...localResultCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 100);
    for (const [k] of oldest) localResultCache.delete(k);
  }
}

export async function cancelStatement(handle: string): Promise<boolean> {
  if (!IS_SPCS || !handle || handle.startsWith('local_')) return false;
  try {
    const token = getSpcsToken();
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
    };
    const r = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements/${handle}/cancel`, { method: 'POST', headers });
    return r.ok;
  } catch { return false; }
}
