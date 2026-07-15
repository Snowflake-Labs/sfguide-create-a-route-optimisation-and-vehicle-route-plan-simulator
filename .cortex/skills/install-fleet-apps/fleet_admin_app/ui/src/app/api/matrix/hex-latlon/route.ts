import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (req: NextRequest) => {
  try {
    const hex = new URL(req.url).searchParams.get('hex');
    if (!hex) return NextResponse.json({ error: 'hex parameter required' }, { status: 400 });
    const safe = hex.replace(/[^a-fA-F0-9]/g, '');
    if (!safe) return NextResponse.json({ error: 'Invalid hex' }, { status: 400 });
    const rows = await runSql(`SELECT ST_Y(H3_CELL_TO_POINT('${safe}')) AS LAT, ST_X(H3_CELL_TO_POINT('${safe}')) AS LON`);
    return NextResponse.json({ lat: Number(rows[0]?.LAT || 0), lon: Number(rows[0]?.LON || 0) });
  } catch (err) {
    return NextResponse.json({ lat: 0, lon: 0, error: (err as Error).message });
  }
});
