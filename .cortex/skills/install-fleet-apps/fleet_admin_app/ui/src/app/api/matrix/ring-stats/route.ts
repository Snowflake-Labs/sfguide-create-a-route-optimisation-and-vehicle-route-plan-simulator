import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { getViewerInventory, validateViewerTable } from '@/server/matrix-viewer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (req: NextRequest) => {
  try {
    const sp = new URL(req.url).searchParams;
    const tableParam = sp.get('table');
    const origin = sp.get('origin');
    if (!tableParam || !origin) return NextResponse.json({ error: 'table and origin required' }, { status: 400 });
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });
    const safeOrigin = origin.replace(/[^a-fA-F0-9]/g, '');
    const rows = await runSql(`
      SELECT
        H3_GRID_DISTANCE('${safeOrigin}', DEST_H3) AS RING,
        COUNT(*) AS HEX_COUNT,
        ROUND(MIN(TRAVEL_TIME_SECONDS) / 60, 1) AS MIN_MINS,
        ROUND(AVG(TRAVEL_TIME_SECONDS) / 60, 1) AS AVG_MINS,
        ROUND(MAX(TRAVEL_TIME_SECONDS) / 60, 1) AS MAX_MINS,
        ROUND(AVG(TRAVEL_DISTANCE_METERS) / 1000, 2) AS AVG_KM
      FROM ${table}
      WHERE ORIGIN_H3 = '${safeOrigin}'
      GROUP BY RING HAVING RING IS NOT NULL ORDER BY RING
    `);
    return NextResponse.json({ rings: rows });
  } catch {
    return NextResponse.json({ rings: [] });
  }
});
