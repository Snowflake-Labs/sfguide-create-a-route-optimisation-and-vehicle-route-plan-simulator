import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql, callProcedure } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withLogging(async (req, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ status: 'error', error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region } = await params;
  try {
    const safeRegion = sanitizeIdentifier(region);
    const result = await callProcedure(`DROP_REGION_ORS('${safeRegion}')`);
    await runSql(`UPDATE ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS SET STATUS='CANCELLED', COMPLETED_AT=SYSDATE() WHERE REGION='${safeRegion}' AND STATUS IN ('RUNNING','PENDING')`);
    return NextResponse.json({ status: 'ok', result });
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message });
  }
});
