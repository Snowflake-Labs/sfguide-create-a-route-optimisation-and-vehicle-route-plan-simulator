import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const rows = await runSql(
      `SELECT ORS_PROFILE, VEHICLE_TYPE, REGION, COUNT(*) AS POINT_COUNT, COUNT(DISTINCT VEHICLE_ID) AS VEHICLES, COUNT(DISTINCT TRIP_ID) AS TRIPS
       FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT GROUP BY ORS_PROFILE, VEHICLE_TYPE, REGION`,
      'SYNTHETIC_DATASETS', 'UNIFIED',
    );
    return NextResponse.json(rows);
  } catch (e) {
    log('WARN', 'Studio', `Failed to load stats: ${(e as Error).message?.slice(0, 200)}`);
    return NextResponse.json([]);
  }
});
