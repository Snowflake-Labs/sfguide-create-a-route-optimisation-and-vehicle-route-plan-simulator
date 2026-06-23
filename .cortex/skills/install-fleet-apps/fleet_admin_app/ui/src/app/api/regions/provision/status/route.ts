import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const result = await callProcedure('GET_PROVISION_STATUS()');
    return NextResponse.json({ jobs: JSON.parse(result || '[]') });
  } catch (err) {
    return NextResponse.json({ jobs: [], error: (err as Error).message });
  }
});
