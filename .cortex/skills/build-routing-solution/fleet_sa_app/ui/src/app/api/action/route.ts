import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';

const ACCOUNT_URL = process.env.SNOWFLAKE_ACCOUNT_URL?.replace(/\/+$/, '') || '';
const PAT = process.env.SNOWFLAKE_PAT || '';
const WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH';
const ROLE = process.env.SNOWFLAKE_ROLE || 'PUBLIC';

interface StatementResponse {
  statementHandle?: string;
  resultSetMetaData?: { numRows: number; rowType: Array<{ name: string; type: string }> };
  data?: string[][];
  message?: string;
  code?: string;
}

function validateAction(sql: string): void {
  const trimmed = sql.trim().toUpperCase();
  if (!trimmed.startsWith('CALL ')) {
    throw new Error('Only CALL statements are allowed via /api/action');
  }
}

async function executeStatement(sql: string): Promise<StatementResponse> {
  const res = await fetch(`${ACCOUNT_URL}/api/v2/statements`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PAT}`,
      Accept: 'application/json',
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
    },
    body: JSON.stringify({ statement: sql, timeout: 60, warehouse: WAREHOUSE, role: ROLE }),
  });
  if (!res.ok) throw new Error(`Snowflake API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function pollForResults(handle: string): Promise<StatementResponse> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`${ACCOUNT_URL}/api/v2/statements/${handle}`, {
      headers: {
        Authorization: `Bearer ${PAT}`,
        Accept: 'application/json',
        'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
      },
    });
    if (!res.ok) throw new Error(`Poll error ${res.status}`);
    const data: StatementResponse = await res.json();
    if (data.data || data.resultSetMetaData) return data;
    if (data.message?.includes('error') || data.code === '000625') throw new Error(data.message || 'Action failed');
  }
  throw new Error('Action timed out after 30s');
}

async function handlePost(request: NextRequest): Promise<Response> {
  try {
    const { sql } = await request.json() as { sql: string };
    if (!sql) return NextResponse.json({ error: 'sql is required' }, { status: 400 });
    if (!ACCOUNT_URL || !PAT) return NextResponse.json({ error: 'Snowflake credentials not configured' }, { status: 500 });

    validateAction(sql);
    let result = await executeStatement(sql);
    if (result.statementHandle && !result.data) result = await pollForResults(result.statementHandle);

    const firstRow = result.data?.[0];
    const raw = firstRow?.[0];
    let parsed: unknown = raw;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }

    return NextResponse.json({ result: parsed });
  } catch (err) {
    logger.error('action-error', {}, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Action failed' }, { status: 500 });
  }
}

export const POST = withLogging(handlePost);
