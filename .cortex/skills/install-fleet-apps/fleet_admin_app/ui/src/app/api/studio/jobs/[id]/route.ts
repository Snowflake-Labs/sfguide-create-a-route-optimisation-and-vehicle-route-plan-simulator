import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql, runSqlBatch } from '@/server/lib/sql';
import { getJob, deleteJobData, loadJobState } from '@/server/studio/jobs';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withLogging(async (req, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ id: string }> };
  const { id } = await params;
  try {
    // The in-memory registry is lost on a container restart, so it alone cannot
    // answer "is this job running". Fall back to the durable JOB_STATE row, or a
    // restart would let a delete proceed against a job whose worker is still
    // alive in another process.
    const job = getJob(id);
    const running = job
      ? job.status === 'RUNNING'
      : (await loadJobState(id, runSql))?.status === 'RUNNING';
    if (running) return NextResponse.json({ error: 'Cannot delete data for a running job. Cancel it first.' }, { status: 409 });
    // 17 DELETEs across the large fact tables -> batch.
    const result = await deleteJobData(id, runSqlBatch);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
