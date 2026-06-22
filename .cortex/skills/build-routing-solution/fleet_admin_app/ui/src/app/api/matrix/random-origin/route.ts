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
    const [originRows, maxRows] = await Promise.all([
      runSql(`SELECT ORIGIN_H3 FROM (SELECT ORIGIN_H3, COUNT(*) AS CNT FROM ${table} GROUP BY ORIGIN_H3 ORDER BY CNT DESC LIMIT 10) ORDER BY RANDOM() LIMIT 1`),
      runSql(`SELECT MAX(TRAVEL_TIME_SECONDS) AS GLOBAL_MAX FROM ${table}`),
    ]);
    const hex = originRows?.[0]?.ORIGIN_H3;
    if (!hex) return NextResponse.json({ error: 'No data in table' });
    const latLon = await runSql(`SELECT ST_Y(H3_CELL_TO_POINT('${hex}')) AS LAT, ST_X(H3_CELL_TO_POINT('${hex}')) AS LON`);
    return NextResponse.json({
      origin_hex: hex,
      origin_lat: Number(latLon[0]?.LAT || 0),
      origin_lon: Number(latLon[0]?.LON || 0),
      global_max_time_secs: Number(maxRows?.[0]?.GLOBAL_MAX || 0),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message });
  }
});
