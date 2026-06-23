import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { toIso } from '@/server/lib/sanitize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Job { stage: string; work_queue_rows: number; profile: string; region: string; resolution: string; raw_rows: number; pct_complete: number }

export const GET = withLogging(async () => {
  try {
    let jobs: Job[] = [];
    try {
      const rows = await runSql(
        `SELECT JOB_ID, REGION, PROFILE, RESOLUTION, STATUS, STAGE, HEXAGONS, WORK_QUEUE_ROWS, RAW_ROWS, MATRIX_ROWS,
                PCT_COMPLETE, ERROR_MSG, STATEMENT_HANDLE,
                TO_VARCHAR(CREATED_AT,'YYYY-MM-DD"T"HH24:MI:SS.FF3') || 'Z' AS CREATED_AT,
                TO_VARCHAR(STARTED_AT,'YYYY-MM-DD"T"HH24:MI:SS.FF3') || 'Z' AS STARTED_AT,
                TO_VARCHAR(COMPLETED_AT,'YYYY-MM-DD"T"HH24:MI:SS.FF3') || 'Z' AS COMPLETED_AT
         FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS ORDER BY CREATED_AT DESC LIMIT 50`,
      );
      jobs = (rows || []).map((r) => ({
        job_id: r.JOB_ID, region: r.REGION, profile: r.PROFILE, resolution: r.RESOLUTION, status: r.STATUS, stage: r.STAGE,
        hexagons: Number(r.HEXAGONS) || 0, work_queue_rows: Number(r.WORK_QUEUE_ROWS) || 0, raw_rows: Number(r.RAW_ROWS) || 0,
        matrix_rows: Number(r.MATRIX_ROWS) || 0, pct_complete: Number(r.PCT_COMPLETE) || 0, error_msg: r.ERROR_MSG,
        statement_handle: r.STATEMENT_HANDLE, created_at: toIso(r.CREATED_AT), started_at: toIso(r.STARTED_AT), completed_at: toIso(r.COMPLETED_AT),
      })) as unknown as Job[];
      await Promise.all(jobs.filter((j) => j.stage === 'BUILDING' && j.work_queue_rows > 0).map(async (j) => {
        const safeProfile = String(j.profile || '').toUpperCase().replace(/-/g, '_');
        const safeRegion = String(j.region || '').toUpperCase();
        const rawTable = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion}_${safeProfile}_MATRIX_RAW_${j.resolution}`;
        try {
          const liveRows = await runSql(`SELECT COUNT(*) AS C FROM ${rawTable}`);
          const c = Number(liveRows?.[0]?.C) || 0;
          j.raw_rows = c;
          j.pct_complete = Math.min(100, Math.round((c * 100) / j.work_queue_rows));
        } catch {}
      }));
    } catch {}
    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json({ jobs: [], error: (err as Error).message });
  }
});
