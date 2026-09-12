import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Dashboard tiles must fail fast. The default 600s request timeout is meant for
// batch submissions; on a saturated warehouse it turned a stalled tile into an
// eight-minute spinner that then rendered "0". Measured: this endpoint returned
// HTTP 200 after 477,086 ms with its statement killed at the 600s bound.
const STATS_TIMEOUT_SECS = 60;

export const GET = withLogging(async () => {
  try {
    const rows = await runSql(
      `SELECT ORS_PROFILE, VEHICLE_TYPE, REGION, COUNT(*) AS POINT_COUNT, COUNT(DISTINCT VEHICLE_ID) AS VEHICLES, COUNT(DISTINCT TRIP_ID) AS TRIPS
       FROM SYNTHETIC_DATASETS.UNIFIED.V_FACT_VEHICLE_TELEMETRY_CURRENT GROUP BY ORS_PROFILE, VEHICLE_TYPE, REGION`,
      'SYNTHETIC_DATASETS', 'UNIFIED', STATS_TIMEOUT_SECS,
    );
    return NextResponse.json(rows);
  } catch (e) {
    const message = (e as Error).message || 'unknown error';
    log('ERROR', 'Studio', `Failed to load stats: ${message.slice(0, 200)}`);
    // 503, NOT an empty array. This route used to `return NextResponse.json([])`
    // on any failure, and the page reduces an empty array to 0:
    //   totalPoints = safeStats.reduce((s, r) => s + Number(r.POINT_COUNT || 0), 0)
    // So a hard SQL failure and a genuinely empty dataset rendered IDENTICALLY,
    // as "Total Points 0". That is what made a warehouse-contention incident
    // look like missing seed data while 1,544,219 telemetry rows sat in the
    // table. A failure must be reported as a failure.
    return NextResponse.json(
      { error: `Could not load dataset stats: ${message.slice(0, 300)}` },
      { status: 503 },
    );
  }
});
