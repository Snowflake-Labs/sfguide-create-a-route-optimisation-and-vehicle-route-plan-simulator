import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const rows = await runSql(
      `SELECT REGION_NAME, BBOX_MIN_LAT, BBOX_MAX_LAT, BBOX_MIN_LON, BBOX_MAX_LON, ORS_PROFILES, STATUS
       FROM FLEET_INTELLIGENCE.CORE.REGION_REGISTRY ORDER BY REGION_NAME`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    return NextResponse.json(rows);
  } catch (e) {
    log('WARN', 'Studio', `Failed to load regions: ${(e as Error).message?.slice(0, 200)}`);
    return NextResponse.json([]);
  }
});
