import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const READONLY_ALLOWED = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'CALL', 'WITH'];

export const POST = withLogging(async (req: NextRequest) => {
  try {
    const { sql, database, schema } = await req.json();
    if (!sql) return NextResponse.json({ error: 'sql required' }, { status: 400 });
    const trimmed = String(sql).trim().replace(/;+$/, '').trim();
    const firstWord = trimmed.split(/\s+/)[0].toUpperCase();
    if (!READONLY_ALLOWED.includes(firstWord)) {
      return NextResponse.json({ error: `Only read-only queries allowed. Got: ${firstWord}` }, { status: 403 });
    }
    log('INFO', 'Query', `DB:${database} Schema:${schema} SQL:${trimmed.slice(0, 300)}`);
    const rows = await runSql(trimmed, database, schema);
    log('INFO', 'Query', `Returned ${rows?.length ?? 0} rows`);
    return NextResponse.json({ result: rows });
  } catch (err) {
    log('ERROR', 'Query', `/api/query error: ${(err as Error).message?.slice(0, 300)}`);
    return NextResponse.json({ error: (err as Error).message });
  }
});
