import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { getJob, deleteJobData } from '@/server/studio/jobs';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withLogging(async (req, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ id: string }> };
  const { id } = await params;
  try {
    const job = getJob(id);
    if (job && job.status === 'RUNNING') return NextResponse.json({ error: 'Cannot delete data for a running job. Cancel it first.' }, { status: 409 });
    const result = await deleteJobData(id, runSql);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
