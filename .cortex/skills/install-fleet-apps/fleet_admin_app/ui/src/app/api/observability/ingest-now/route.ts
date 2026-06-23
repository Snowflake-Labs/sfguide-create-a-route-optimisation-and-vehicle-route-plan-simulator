import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// On-demand metrics ingest (manual refresh). Calls the fully-qualified
// OBSERVABILITY proc directly via runSql (callProcedure would prepend
// SF_DATABASE.CORE and double-qualify it).
export const POST = withLogging(async (req) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const rows = await runSql('CALL OPENROUTESERVICE_APP.OBSERVABILITY.INGEST_ORS_METRICS(5)');
    const raw = rows?.[0]?.[Object.keys(rows[0] || {})[0]] ?? '{}';
    try {
      return NextResponse.json(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch {
      return NextResponse.json({ raw });
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message?.slice(0, 300) || String(err) }, { status: 500 });
  }
});
