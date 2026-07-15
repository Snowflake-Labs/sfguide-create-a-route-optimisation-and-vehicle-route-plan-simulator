import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const family = (await callProcedure('RESOLVE_LARGEST_HIGHMEM_FAMILY()')) || 'HIGHMEM_X64_M';
    return NextResponse.json({ family: family.trim() });
  } catch (err) {
    return NextResponse.json({ family: 'HIGHMEM_X64_M', error: (err as Error).message }, { status: 500 });
  }
});
