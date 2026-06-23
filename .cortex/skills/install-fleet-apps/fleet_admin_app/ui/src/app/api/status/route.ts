import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const result = await callProcedure('GET_STATUS()');
    return NextResponse.json(JSON.parse(result));
  } catch (err) {
    log('ERROR', 'Health', `/api/status error: ${(err as Error).message?.slice(0, 200)}`);
    return NextResponse.json({ compute_pool: 'ERROR', services: [], error: (err as Error).message });
  }
});
