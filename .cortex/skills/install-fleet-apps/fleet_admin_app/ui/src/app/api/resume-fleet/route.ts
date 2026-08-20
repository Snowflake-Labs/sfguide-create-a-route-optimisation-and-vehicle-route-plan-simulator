import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Resume the fleet dynamic tables after cost-safe mode (inverse of /api/cost-safe).
// SPCS routing services are intentionally NOT resumed here - they resume lazily
// on the first routing query, so there is no idle service cost to pay up front.
export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ status: 'error', error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const result = await callProcedure('RESUME_FLEET()');
    return NextResponse.json({ status: 'ok', result });
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message });
  }
});
