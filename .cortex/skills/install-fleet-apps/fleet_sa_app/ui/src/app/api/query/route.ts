import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getSnowflakeAuth } from '@/lib/sf-auth';

const WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH';
const ROLE = process.env.SNOWFLAKE_ROLE || 'PUBLIC';

interface StatementResponse {
  statementHandle?: string;
  statementStatusUrl?: string;
  message?: string;
  resultSetMetaData?: {
    numRows: number;
    format: string;
    rowType: Array<{ name: string; type: string }>;
    partitionInfo?: Array<{ rowCount: number; uncompressedSize: number }>;
  };
  data?: string[][];
  code?: string;
}

function validateQuery(sql: string): void {
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
    throw new Error('Only SELECT queries are allowed');
  }
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE|GRANT|REVOKE|COPY)\b/i;
  if (forbidden.test(sql)) {
    throw new Error('Query contains forbidden DDL/DML statements');
  }
}

function validateParams(params?: Record<string, string | null>): void {
  if (!params) return;
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') {
      if (value.length > 1000) {
        throw new Error(`Parameter '${key}' exceeds max length`);
      }
      if (/[;]/.test(value)) {
        throw new Error(`Parameter '${key}' contains invalid characters`);
      }
    }
  }
}

// Databases an agent-emitted (dynamic) query may reference. FLEET_APP is the
// neutral data contract; SNOWFLAKE.CORTEX.COMPLETE backs the asset-velocity
// rationale. This is a fast pre-filter for clear errors - the AUTHORITATIVE
// boundary is the owner's-rights proc FLEET_APP.CORE.QUERY_DYNAMIC, which runs
// as FLEET_APP_DYNAMIC_READER and physically cannot reach other databases.
const ALLOWED_DYNAMIC_DBS = new Set(['FLEET_APP', 'SNOWFLAKE']);

function validateDynamicAllowlist(sql: string): void {
  // Match any 3-part qualified name (DB.SCHEMA.OBJECT), covering both
  // `FROM/JOIN db.schema.obj` and `TABLE(db.schema.fn(...))` forms.
  const re = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*[A-Za-z_][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const db = m[1].toUpperCase();
    if (!ALLOWED_DYNAMIC_DBS.has(db)) {
      throw new Error(
        `Dynamic query may only reference ${[...ALLOWED_DYNAMIC_DBS].join(', ')}; found '${m[1]}'`,
      );
    }
  }
}

const DYNAMIC_QUERY_TAG =
  '{"origin":"sf_sit-is-fleet","name":"oss-render-view","version":{"major":1,"minor":0},"attributes":{"is_quickstart":1,"source":"app"}}';

function resolveParams(sql: string, params?: Record<string, string | null>): string {
  if (!params) return sql;
  let resolved = sql;
  for (const [key, value] of Object.entries(params)) {
    const placeholder = new RegExp(`:${key}\\b`, 'g');
    if (value === null || value === undefined || value === '') {
      resolved = resolved.replace(placeholder, 'NULL');
    } else {
      resolved = resolved.replace(placeholder, `'${value.replace(/'/g, "''")}'`);
    }
  }
  return resolved;
}

interface ExecOpts {
  bindings?: Record<string, { type: string; value: string }>;
  queryTag?: string;
}

async function executeStatement(sql: string, opts: ExecOpts = {}): Promise<StatementResponse> {
  const auth = getSnowflakeAuth();
  const url = `${auth.baseUrl}/api/v2/statements`;
  const body: Record<string, unknown> = {
    statement: sql,
    timeout: 60,
    warehouse: WAREHOUSE,
    role: ROLE,
  };
  if (opts.bindings) body.bindings = opts.bindings;
  if (opts.queryTag) body.parameters = { QUERY_TAG: opts.queryTag };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json',
      'X-Snowflake-Authorization-Token-Type': auth.tokenType,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Snowflake API ${res.status}: ${text}`);
  }

  return res.json();
}

// The SQL API splits large result sets into partitions; the initial response
// (or first poll) carries only partition 0 in `data`. Without this, a big query
// like the 1182-cell hazard grid silently returns only the first ~partition of
// rows, so the UI renders a fraction of the hexagons while server-side procs see
// the full set -> visible mismatches. Fetch the remaining partitions and append.
async function fetchPartition(handle: string, partition: number): Promise<string[][]> {
  const auth = getSnowflakeAuth();
  const url = `${auth.baseUrl}/api/v2/statements/${handle}?partition=${partition}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: 'application/json',
      'X-Snowflake-Authorization-Token-Type': auth.tokenType,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Partition ${partition} error ${res.status}: ${text}`);
  }
  const data: StatementResponse = await res.json();
  return data.data || [];
}

async function pollForResults(handle: string, sqlPreview: string): Promise<StatementResponse> {
  const auth = getSnowflakeAuth();
  const url = `${auth.baseUrl}/api/v2/statements/${handle}`;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    logger.debug('sf-poll', { attempt: i + 1, handle: handle.slice(0, 16), sql: sqlPreview });
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: 'application/json',
        'X-Snowflake-Authorization-Token-Type': auth.tokenType,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Poll error ${res.status}: ${text}`);
    }
    const data: StatementResponse = await res.json();
    if (data.data || data.resultSetMetaData) return data;
    if (data.message?.includes('error') || data.code === '000625') {
      throw new Error(data.message || 'Query failed');
    }
  }
  throw new Error('Query timed out after 30s');
}

async function handleQuery(request: NextRequest): Promise<Response> {
  try {
    const body = await request.json();
    const rawSql = body.sql as string;
    const params = body.params as Record<string, string | null> | undefined;
    const dynamic = body.dynamic === true;

    if (!rawSql) {
      return NextResponse.json({ error: 'sql is required' }, { status: 400 });
    }
    if (!getSnowflakeAuth().baseUrl || !getSnowflakeAuth().token) {
      return NextResponse.json({ error: 'Snowflake credentials not configured' }, { status: 500 });
    }

    validateQuery(rawSql);
    validateParams(params);
    const sql = resolveParams(rawSql, params);
    const sqlPreview = sql.replace(/\s+/g, ' ').trim().slice(0, 120);

    const sfStart = Date.now();
    logger.debug('sf-exec', { sql: sqlPreview, warehouse: WAREHOUSE, role: ROLE, dynamic });

    // Agent-emitted queries run through the owner's-rights boundary proc so the
    // caller's secondary roles cannot leak in. The SQL is bound (not inlined) to
    // avoid dollar-quoting hazards. validateDynamicAllowlist is a fast pre-filter;
    // FLEET_APP_DYNAMIC_READER (the proc owner) is the authoritative boundary.
    let result: StatementResponse;
    if (dynamic) {
      validateDynamicAllowlist(sql);
      result = await executeStatement('CALL FLEET_APP.CORE.QUERY_DYNAMIC(?)', {
        bindings: { '1': { type: 'TEXT', value: sql } },
        queryTag: DYNAMIC_QUERY_TAG,
      });
    } else {
      result = await executeStatement(sql);
    }
    const hadHandle = !!(result.statementHandle && !result.data);

    if (hadHandle) {
      logger.debug('sf-async', { handle: result.statementHandle?.slice(0, 16), sql: sqlPreview });
      result = await pollForResults(result.statementHandle!, sqlPreview);
    }

    const sfMs = Date.now() - sfStart;
    const numRows = result.resultSetMetaData?.numRows ?? 0;
    logger.debug('sf-done', { ms: sfMs, rows: numRows, polling: hadHandle, sql: sqlPreview });

    const columns = (result.resultSetMetaData?.rowType || []).map((col) => ({
      key: col.name.toLowerCase(),
      label: col.name,
      type: col.type,
    }));

    // Assemble all partitions, not just partition 0, so large result sets (e.g.
    // the full hazard-zone grid) are returned in their entirety.
    let allData: string[][] = result.data || [];
    const partitions = result.resultSetMetaData?.partitionInfo;
    const handle = result.statementHandle;
    if (handle && partitions && partitions.length > 1) {
      for (let p = 1; p < partitions.length; p++) {
        const pd = await fetchPartition(handle, p);
        allData = allData.concat(pd);
      }
      logger.debug('sf-partitions', { count: partitions.length, rows: allData.length, sql: sqlPreview });
    }

    const rows = allData.map((row) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        const raw = row[i];
        if (raw === null || raw === undefined) {
          obj[col.key] = null;
        } else if (col.type === 'fixed' || col.type === 'real' || col.type === 'float') {
          obj[col.key] = Number(raw);
        } else if (col.type === 'boolean') {
          obj[col.key] = raw === 'true' || raw === '1';
        } else if (col.type === 'timestamp_ntz' || col.type === 'timestamp_ltz' || col.type === 'timestamp_tz') {
          const ms = Math.round(parseFloat(raw) * 1000);
          obj[col.key] = new Date(ms).toISOString();
        } else {
          obj[col.key] = raw;
        }
      });
      return obj;
    });

    return NextResponse.json({
      columns: columns.map(({ key, label }) => ({ key, label })),
      rows,
      totalRows: result.resultSetMetaData?.numRows ?? rows.length,
    });
  } catch (err) {
    logger.error('sf-error', { warehouse: WAREHOUSE }, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Query execution failed' },
      { status: 500 },
    );
  }
}

export const POST = withLogging(handleQuery);
