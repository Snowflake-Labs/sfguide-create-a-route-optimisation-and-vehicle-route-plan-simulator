import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql, runSqlBatch } from '@/server/lib/sql';
import { refreshRegionCatalog } from '@/server/lib/refresh-region-catalog';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async (req) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ status: 'error', error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    // Scrapes the mirrors then MERGEs ~5,200 rows in 50-row batches -> batch.
    const result = await refreshRegionCatalog(runSqlBatch);
    return NextResponse.json({ status: 'ok', result });
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message }, { status: 500 });
  }
});
