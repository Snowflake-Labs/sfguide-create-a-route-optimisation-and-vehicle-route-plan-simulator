import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { getViewerInventory } from '@/server/matrix-viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const tables = await getViewerInventory();
    return NextResponse.json({ tables });
  } catch (err) {
    return NextResponse.json({ tables: [], error: (err as Error).message });
  }
});
