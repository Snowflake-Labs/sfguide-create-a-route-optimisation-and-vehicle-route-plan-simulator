// Snowflake SQL execution helpers. Two transports:
//   - snowSqlLocal:  shell out to `snow sql -c <conn>` for local dev
//   - snowSqlSpcs:   call /api/v2/statements directly inside SPCS
// `runSql` picks the right transport based on IS_SPCS at call time.

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { IS_SPCS, SF_DATABASE, SF_WAREHOUSE, CONN, SNOWFLAKE_HOST } from '../constants.js';
import { getSpcsToken } from './sanitize.js';
import { log } from '../diagnostics.js';

const QUERY_TAG_VALUE = '{"origin":"sf_sit-is-fleet","name":"oss-build-routing-solution","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"sql"}}';

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
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const pr = await fetch(pollUrl, { headers });
      result = await pr.json();
      if (result.data || (result.code && result.code !== '333334')) break;
    }
  }
  if (result.message && !result.data) {
    log('ERROR', 'SQL', `Statement error: ${result.message?.slice(0, 200)}`, { durationMs: Date.now() - sqlStart });
    throw new Error(`SQL error: ${result.message}`);
  }
  if (!result.data) return [];
  const cols = (result.resultSetMetaData?.rowType || []).map((c: any) => c.name);
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
    cols.forEach((c: string, i: number) => { obj[c] = row[i]; });
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

// Async statement submission — returns a Snowflake statementHandle for
// long-running queries. Caller polls / cancels via cancelStatement.
export async function submitSqlAsync(sql: string): Promise<string> {
  if (!IS_SPCS) {
    runSql(sql).catch((e: any) => console.error(`[Async local] Error: ${e.message}`));
    return `local_${Date.now()}`;
  }
  const token = getSpcsToken();
  const body = { statement: sql, timeout: 0, database: SF_DATABASE, warehouse: SF_WAREHOUSE };
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
    'Accept': 'application/json', 'X-Snowflake-Authorization-Token-Type': 'OAUTH',
  };
  console.log(`[SQL API Async] Submitting: ${sql.slice(0, 200)}`);
  const r = await fetch(`https://${SNOWFLAKE_HOST}/api/v2/statements`, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await r.json();
  return result.statementHandle || '';
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
