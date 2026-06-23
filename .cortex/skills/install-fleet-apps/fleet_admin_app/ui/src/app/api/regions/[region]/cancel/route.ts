import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql, callProcedure, cancelStatement } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Job { region: string; status: string; statement_handle?: string }

export const POST = withLogging(async (req, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region } = await params;
  try {
    const safeRegion = sanitizeIdentifier(region);
    const result = await callProcedure('GET_PROVISION_STATUS()');
    const jobs: Job[] = JSON.parse(result || '[]');
    const active = jobs.find((j) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
    if (active?.statement_handle) await cancelStatement(active.statement_handle);
    await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=SYSDATE() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
    return NextResponse.json({ status: 'cancelled' });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
