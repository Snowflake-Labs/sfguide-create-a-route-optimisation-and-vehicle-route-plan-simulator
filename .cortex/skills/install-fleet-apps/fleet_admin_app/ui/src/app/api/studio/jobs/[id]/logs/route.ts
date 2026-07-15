import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { getJob, getJobEvents } from '@/server/studio/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (_req, ctx?: unknown) => {
  const { params } = ctx as { params: Promise<{ id: string }> };
  const { id: jobId } = await params;
  try {
    const events = getJobEvents(jobId);
    if (events) {
      const job = getJob(jobId)!;
      return NextResponse.json({
        jobId, source: 'memory', status: job.status, pointsGenerated: job.pointsGenerated,
        tripsGenerated: job.tripsGenerated, startedAt: job.startedAt, completedAt: job.completedAt, error: job.error, events,
      });
    }
    const rows = await runSql(
      `SELECT JOB_ID, STATUS, POINTS_GENERATED, TRIPS_GENERATED, ERROR_MESSAGE,
              TO_VARCHAR(CONVERT_TIMEZONE('UTC', STARTED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS STARTED_AT,
              TO_VARCHAR(CONVERT_TIMEZONE('UTC', COMPLETED_AT), 'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS COMPLETED_AT, LOG_TEXT
       FROM FLEET_INTELLIGENCE.CORE.GENERATION_JOBS WHERE JOB_ID = '${jobId.replace(/'/g, "''")}'`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    if (!rows.length) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    const row = rows[0];
    const logRaw = row.LOG_TEXT;
    const parsed = typeof logRaw === 'string' ? (logRaw ? JSON.parse(logRaw) : null) : logRaw;
    return NextResponse.json({
      jobId, source: 'db', status: row.STATUS, pointsGenerated: row.POINTS_GENERATED, tripsGenerated: row.TRIPS_GENERATED,
      startedAt: row.STARTED_AT, completedAt: row.COMPLETED_AT, error: row.ERROR_MESSAGE, events: parsed?.events || [],
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
