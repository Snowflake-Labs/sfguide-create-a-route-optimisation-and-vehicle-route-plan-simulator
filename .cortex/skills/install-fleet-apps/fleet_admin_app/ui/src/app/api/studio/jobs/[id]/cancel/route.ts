import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { cancelJob } from '@/server/studio/jobs';
import { requireOps } from '@/lib/ingress-identity';
import { runSql, runSqlBatch } from '@/server/lib/sql';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async (req, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ id: string }> };
  const { id } = await params;
  // Cancels the job then repairs the dataset registry (5 statements) -> batch.
  const result = await cancelJob(id, runSqlBatch);
  if (!result.ok) {
    const code = result.mode === 'not-found' ? 404 : result.mode === 'error' ? 500 : 409;
    return NextResponse.json(result, { status: code });
  }
  return NextResponse.json(result);
});
