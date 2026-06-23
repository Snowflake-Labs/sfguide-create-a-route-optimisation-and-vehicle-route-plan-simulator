import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';
import { sanitizeInt } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ status: 'error', error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const body = await req.json();
    const min = sanitizeInt(body.min);
    const max = sanitizeInt(body.max);
    if (min < 1 || max < min || max > 20) return NextResponse.json({ error: 'min must be 1-20, max >= min' }, { status: 400 });
    const result = await callProcedure(`SCALE_SERVICES(${min}, ${max})`);
    return NextResponse.json({ status: 'ok', result });
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message });
  }
});
