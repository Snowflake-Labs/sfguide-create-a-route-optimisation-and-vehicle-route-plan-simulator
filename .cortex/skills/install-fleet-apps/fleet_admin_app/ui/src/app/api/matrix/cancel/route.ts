import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure, cancelStatement } from '@/server/lib/sql';
import { escapeString } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const { job_id } = await req.json();
    if (!job_id) return NextResponse.json({ error: 'job_id required' }, { status: 400 });
    const result = await callProcedure(`CANCEL_MATRIX_BUILD('${escapeString(job_id)}')`);
    const parsed = JSON.parse(result || '{}');
    if (parsed.statement_handle) await cancelStatement(parsed.statement_handle);
    return NextResponse.json({ status: 'cancelled', result: parsed });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
