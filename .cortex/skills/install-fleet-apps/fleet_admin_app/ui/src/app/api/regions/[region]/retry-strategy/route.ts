import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (_req, ctx?: unknown) => {
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region } = await params;
  try {
    const safeRegion = sanitizeIdentifier(region);
    const strategy = await callProcedure(`RECOMMEND_RETRY_STRATEGY('${safeRegion}')`);
    return NextResponse.json({ region: safeRegion, strategy: (strategy || 'NO_HISTORY').trim() });
  } catch (err) {
    return NextResponse.json({ strategy: 'NO_HISTORY', error: (err as Error).message }, { status: 500 });
  }
});
