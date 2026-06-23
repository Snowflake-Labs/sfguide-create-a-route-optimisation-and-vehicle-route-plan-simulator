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
    const maxTime = sp.get('max_time');
    const timeFilter = maxTime ? `AND TRAVEL_TIME_SECONDS <= ${Number(maxTime)}` : '';
    const rows = await runSql(`
      SELECT DEST_H3 AS HEX_ID, TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS
      FROM ${table}
      WHERE ORIGIN_H3 = '${safeOrigin}' AND TRAVEL_TIME_SECONDS IS NOT NULL ${timeFilter}
    `);
    const originLatLon = await runSql(`SELECT ST_Y(H3_CELL_TO_POINT('${safeOrigin}')) AS LAT, ST_X(H3_CELL_TO_POINT('${safeOrigin}')) AS LON`);
    return NextResponse.json({
      destinations: rows,
      origin_lat: Number(originLatLon[0]?.LAT || 0),
      origin_lon: Number(originLatLon[0]?.LON || 0),
    });
  } catch {
    return NextResponse.json({ destinations: [], origin_lat: 0, origin_lon: 0 });
  }
});
