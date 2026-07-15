import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { fetchResultByHandle } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (_req: NextRequest, ctx?: unknown) => {
  const { params } = (ctx as { params: Promise<{ handle: string }> });
  const { handle } = await params;
  try {
    const out = await fetchResultByHandle(handle);
    if ('status' in out) return NextResponse.json({ status: out.status });
    return NextResponse.json({ result: out.rows });
  } catch (err) {
    log('ERROR', 'Query', `/api/query-result error: ${(err as Error).message?.slice(0, 300)}`);
    return NextResponse.json({ error: (err as Error).message });
  }
});
