import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql, runSqlBatch } from '@/server/lib/sql';
import { activateDataset } from '@/server/studio/jobs';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async (req, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ id: string }> };
  const { id } = await params;
  try {
    // Probe + UPDATE + CONFIG sync across every region schema -> batch.
    const result = await activateDataset(runSqlBatch, id);
    return NextResponse.json(result);
  } catch (e) {
    const status = /not found/i.test((e as Error).message) ? 404 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
});
