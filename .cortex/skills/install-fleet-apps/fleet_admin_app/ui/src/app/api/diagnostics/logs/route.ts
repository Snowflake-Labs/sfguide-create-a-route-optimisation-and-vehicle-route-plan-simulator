import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { getEntries, type LogLevel } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (req: NextRequest) => {
  const sp = new URL(req.url).searchParams;
  const limit = sp.get('limit');
  const entries = getEntries({
    level: (sp.get('level') as LogLevel) || undefined,
    tag: sp.get('tag') || undefined,
    jobId: sp.get('jobId') || undefined,
    since: sp.get('since') || undefined,
    limit: limit ? Number(limit) : undefined,
  });
  return NextResponse.json({ entries, total: entries.length });
});
