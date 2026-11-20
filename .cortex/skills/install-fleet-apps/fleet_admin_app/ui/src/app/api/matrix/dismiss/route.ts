import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST { job_id } - hide a finished matrix job from the failed-jobs list. The
// flag lives on MATRIX_BUILD_JOBS, so the dismissal survives a page refresh.
// Body rather than a [jobId] segment: that level is already the dynamic
// [region] segment, and Next.js forbids two parameter names at one level.
export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const { job_id } = await req.json();
    if (!job_id) return NextResponse.json({ error: 'job_id required' }, { status: 400 });
    const jobId = sanitizeIdentifier(String(job_id));
    await callProcedure(`DISMISS_MATRIX_JOB('${jobId}')`);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
