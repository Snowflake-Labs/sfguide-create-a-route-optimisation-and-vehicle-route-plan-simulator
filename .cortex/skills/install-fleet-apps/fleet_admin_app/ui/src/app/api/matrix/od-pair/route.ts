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
    const dest = sp.get('dest');
    if (!tableParam || !origin || !dest) return NextResponse.json({ error: 'table, origin, dest required' }, { status: 400 });
    await getViewerInventory();
    const table = validateViewerTable(tableParam);
    if (!table) return NextResponse.json({ error: 'Invalid table name' }, { status: 400 });
    const safeO = origin.replace(/[^a-fA-F0-9]/g, '');
    const safeD = dest.replace(/[^a-fA-F0-9]/g, '');
    if (safeO === safeD) {
      const ll = await runSql(`SELECT ST_Y(H3_CELL_TO_POINT('${safeO}')) AS LAT, ST_X(H3_CELL_TO_POINT('${safeO}')) AS LON`);
      const lat = Number(ll[0]?.LAT || 0);
      const lon = Number(ll[0]?.LON || 0);
      return NextResponse.json({ found: true, travel_time_secs: 0, distance_meters: 0, origin_lat: lat, origin_lon: lon, dest_lat: lat, dest_lon: lon });
    }
    const rows = await runSql(`
      SELECT TRAVEL_TIME_SECONDS, TRAVEL_DISTANCE_METERS,
             ST_Y(H3_CELL_TO_POINT('${safeO}')) AS O_LAT, ST_X(H3_CELL_TO_POINT('${safeO}')) AS O_LON,
             ST_Y(H3_CELL_TO_POINT('${safeD}')) AS D_LAT, ST_X(H3_CELL_TO_POINT('${safeD}')) AS D_LON
      FROM ${table}
      WHERE ORIGIN_H3 = '${safeO}' AND DEST_H3 = '${safeD}' LIMIT 1
    `);
    const r = rows[0];
    if (!r) return NextResponse.json({ found: false });
    return NextResponse.json({
      found: true,
      travel_time_secs: Number(r.TRAVEL_TIME_SECONDS),
      distance_meters: Number(r.TRAVEL_DISTANCE_METERS),
      origin_lat: Number(r.O_LAT), origin_lon: Number(r.O_LON),
      dest_lat: Number(r.D_LAT), dest_lon: Number(r.D_LON),
    });
  } catch (err) {
    return NextResponse.json({ found: false, error: (err as Error).message });
  }
});
