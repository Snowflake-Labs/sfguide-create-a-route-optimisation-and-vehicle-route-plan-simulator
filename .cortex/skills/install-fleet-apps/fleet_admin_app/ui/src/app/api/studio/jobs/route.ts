import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { getJobs } from '@/server/studio/jobs';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const memoryJobs = getJobs();
    let dbJobs: Record<string, unknown>[] = [];
    try {
      dbJobs = await runSql(
        `SELECT JOB_ID, PRESET_NAME, REGION, ORS_PROFILE, NUM_VEHICLES, STATUS, POINTS_GENERATED, TRIPS_GENERATED,
                TO_VARCHAR(CONVERT_TIMEZONE('UTC', STARTED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS STARTED_AT,
                TO_VARCHAR(CONVERT_TIMEZONE('UTC', COMPLETED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS COMPLETED_AT,
                ERROR_MESSAGE, DATEDIFF('second', STARTED_AT, COALESCE(COMPLETED_AT, SYSDATE())) AS DURATION_SEC, START_DATE, END_DATE
         FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS WHERE STATUS != 'DELETED' ORDER BY STARTED_AT DESC LIMIT 50`,
        'FLEET_INTELLIGENCE', 'CORE',
      );
    } catch (e) {
      log('WARN', 'Studio', `Failed to load job history: ${(e as Error).message?.slice(0, 200)}`);
    }
    return NextResponse.json({ active: memoryJobs, history: dbJobs });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
