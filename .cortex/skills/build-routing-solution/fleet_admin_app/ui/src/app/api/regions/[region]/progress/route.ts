import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Job { region: string; status: string; stage: string; message?: string; error_msg?: string }

export const GET = withLogging(async (_req, ctx?: unknown) => {
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region } = await params;
  try {
    const safeRegion = sanitizeIdentifier(region);
    const result = await callProcedure('GET_PROVISION_STATUS()');
    const jobs: Job[] = JSON.parse(result || '[]');
    const job = jobs.find((j) => j.region === safeRegion && (j.status === 'RUNNING' || j.status === 'PENDING'));
    if (job) {
      return NextResponse.json({ status: job.status === 'RUNNING' ? 'running' : job.status, phase: job.stage.toLowerCase(), message: job.message, error: job.error_msg });
    }
    const completed = jobs.find((j) => j.region === safeRegion);
    return NextResponse.json(completed ? { status: completed.status.toLowerCase(), phase: completed.stage.toLowerCase(), message: completed.message } : { status: 'idle', phase: '' });
  } catch {
    return NextResponse.json({ status: 'idle', phase: '' });
  }
});
