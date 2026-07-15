import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { orsServiceFqn } from '@/server/lib/region';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (req: NextRequest, ctx?: unknown) => {
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region } = await params;
  try {
    const svcName = orsServiceFqn(region);
    const linesRaw = parseInt(new URL(req.url).searchParams.get('lines') || '200', 10);
    const lines = Number.isFinite(linesRaw) ? Math.min(Math.max(linesRaw, 10), 1000) : 200;
    const rows = await runSql(`SELECT SYSTEM$GET_SERVICE_LOGS('${svcName}', 0, 'ors', ${lines}) AS LOGS`);
    const logs: string = rows?.[0]?.LOGS || '';
    const all = logs.split(/\r?\n/);
    const tail = all.slice(-lines).join('\n');
    return NextResponse.json({ logs: tail, total_lines: all.length, returned_lines: Math.min(all.length, lines) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || String(err) }, { status: 500 });
  }
});
