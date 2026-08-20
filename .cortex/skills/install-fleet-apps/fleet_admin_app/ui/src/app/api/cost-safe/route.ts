import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cost-safe mode: suspends all fleet dynamic tables + recurring tasks and then
// suspends the SPCS routing services (SUSPEND_ALL_SERVICES, which also
// reconciles AUTO_SUSPEND / warehouse-size drift). Use on an idle deployment
// to stop background credit consumption.
export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ status: 'error', error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const result = await callProcedure('COST_SAFE_MODE()');
    return NextResponse.json({ status: 'ok', result });
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message });
  }
});
