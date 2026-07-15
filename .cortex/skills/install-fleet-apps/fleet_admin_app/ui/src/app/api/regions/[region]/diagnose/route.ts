import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { callProcedure } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DiagCache { [k: string]: { ts: number; payload: unknown } }

export const POST = withLogging(async (req, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ ok: false, error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region } = await params;
  let safeRegion: string;
  try {
    safeRegion = sanitizeIdentifier(region);
  } catch (err) {
    return NextResponse.json({ ok: false, error: `Invalid region: ${(err as Error).message}` }, { status: 400 });
  }
  const now = Date.now();
  const cacheKey = `diag:${safeRegion}`;
  const g = globalThis as unknown as { __fleetAdminDiagCache?: DiagCache };
  g.__fleetAdminDiagCache ??= {};
  const cached = g.__fleetAdminDiagCache[cacheKey];
  if (cached && now - cached.ts < 30_000) return NextResponse.json(cached.payload as object);
  try {
    const result = await callProcedure(`DIAGNOSE_REGION('${safeRegion}')`);
    const parsed = JSON.parse(result || '{}');
    const payload = { ok: true, ...parsed };
    g.__fleetAdminDiagCache[cacheKey] = { ts: now, payload };
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
});
