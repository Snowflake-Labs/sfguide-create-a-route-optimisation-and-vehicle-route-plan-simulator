import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';
import { sanitizeIdentifier, sanitizeInt, escapeString } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async (req: NextRequest, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ status: 'error', error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ region: string; profile: string; resolution: string }> };
  const { region, profile, resolution } = await params;
  try {
    const safeRegion = sanitizeIdentifier(region);
    const safeProfile = escapeString(profile);
    const safeRes = sanitizeIdentifier(resolution);
    const body = await req.json().catch(() => ({}));
    const offsetSecs = sanitizeInt(body.offset_seconds || 300);
    const result = await callProcedure(`RESTORE_MATRIX_DATA('${safeRegion}', '${safeProfile}', '${safeRes}', ${offsetSecs})`);
    return NextResponse.json(JSON.parse(result || '{}'));
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message }, { status: 500 });
  }
});
