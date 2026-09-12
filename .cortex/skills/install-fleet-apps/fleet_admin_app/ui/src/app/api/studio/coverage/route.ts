import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// See stats/route.ts: dashboard reads fail fast rather than hold a spinner for
// the batch-sized 600s default.
const COVERAGE_TIMEOUT_SECS = 60;

export const GET = withLogging(async () => {
  try {
    const telemetryStats = await runSql(
      `SELECT VEHICLE_TYPE, REGION, ORS_PROFILE, COUNT(*) AS TELEMETRY_ROWS,
              COUNT(DISTINCT VEHICLE_ID) AS VEHICLES, COUNT(DISTINCT TRIP_ID) AS TRIPS
       FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT
       GROUP BY VEHICLE_TYPE, REGION, ORS_PROFILE`,
      'SYNTHETIC_DATASETS', 'UNIFIED', COVERAGE_TIMEOUT_SECS,
    );
    // Trip stats are genuinely optional: coverage is keyed on telemetry, and a
    // dataset can carry telemetry with no trips. This inner tolerance is a
    // deliberate partial degrade, not the masking pattern below - it is reported
    // to the caller via TRIPS_DEGRADED so the UI can say so rather than present
    // 0 as a measurement.
    let tripStats: Record<string, unknown>[] = [];
    let tripsDegraded = false;
    try {
      tripStats = await runSql(
        `SELECT VEHICLE_TYPE, REGION, COUNT(*) AS TRIP_ROWS FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_TRIPS_CURRENT GROUP BY VEHICLE_TYPE, REGION`,
        'SYNTHETIC_DATASETS', 'UNIFIED', COVERAGE_TIMEOUT_SECS,
      );
    } catch (e) {
      tripsDegraded = true;
      log('WARN', 'Studio', `Failed to load trip stats for coverage: ${(e as Error).message?.slice(0, 200)}`);
    }
    const merged = telemetryStats.map((t) => {
      const ts = tripStats.find((s) => s.VEHICLE_TYPE === t.VEHICLE_TYPE && s.REGION === t.REGION);
      return { ...t, TRIP_ROWS: ts?.TRIP_ROWS ?? null, TRIPS_DEGRADED: tripsDegraded };
    });
    return NextResponse.json(merged);
  } catch (e) {
    const message = (e as Error).message || 'unknown error';
    log('ERROR', 'Studio', `Failed to load coverage: ${message.slice(0, 200)}`);
    // 503, not `[]`. An empty array here reads as "no dataset has any data",
    // which is indistinguishable from "the query failed" - see stats/route.ts.
    return NextResponse.json(
      { error: `Could not load dataset coverage: ${message.slice(0, 300)}` },
      { status: 503 },
    );
  }
});
