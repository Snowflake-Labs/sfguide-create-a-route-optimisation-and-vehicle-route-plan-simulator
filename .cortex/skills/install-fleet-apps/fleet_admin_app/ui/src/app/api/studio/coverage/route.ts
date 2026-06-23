import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const telemetryStats = await runSql(
      `SELECT VEHICLE_TYPE, REGION, ORS_PROFILE, COUNT(*) AS TELEMETRY_ROWS,
              COUNT(DISTINCT VEHICLE_ID) AS VEHICLES, COUNT(DISTINCT TRIP_ID) AS TRIPS
       FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT
       GROUP BY VEHICLE_TYPE, REGION, ORS_PROFILE`,
      'SYNTHETIC_DATASETS', 'UNIFIED',
    );
    let tripStats: Record<string, unknown>[] = [];
    try {
      tripStats = await runSql(
        `SELECT VEHICLE_TYPE, REGION, COUNT(*) AS TRIP_ROWS FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT GROUP BY VEHICLE_TYPE, REGION`,
        'SYNTHETIC_DATASETS', 'UNIFIED',
      );
    } catch (e) {
      log('WARN', 'Studio', `Failed to load trip stats for coverage: ${(e as Error).message?.slice(0, 200)}`);
    }
    const merged = telemetryStats.map((t) => {
      const ts = tripStats.find((s) => s.VEHICLE_TYPE === t.VEHICLE_TYPE && s.REGION === t.REGION);
      return { ...t, TRIP_ROWS: ts?.TRIP_ROWS || 0 };
    });
    return NextResponse.json(merged);
  } catch (e) {
    log('WARN', 'Studio', `Failed to load coverage: ${(e as Error).message?.slice(0, 200)}`);
    return NextResponse.json([]);
  }
});
