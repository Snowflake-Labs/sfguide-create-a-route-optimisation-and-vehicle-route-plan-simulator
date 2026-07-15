import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { getViewerInventory, validateViewerTable } from '@/server/matrix-viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (req: NextRequest) => {
  try {
    const tableParam = new URL(req.url).searchParams.get('table');
    if (!tableParam) return NextResponse.json({ error: 'table parameter required' }, { status: 400 });
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });
    const rows = await runSql(`SELECT DISTINCT ORIGIN_H3 AS HEX_ID FROM ${table}`);
    return NextResponse.json({ hexes: rows.map((r) => r.HEX_ID) });
  } catch {
    return NextResponse.json({ hexes: [] });
  }
});
