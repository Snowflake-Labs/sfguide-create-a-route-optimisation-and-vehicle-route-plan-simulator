import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier, escapeString } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withLogging(async (req, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ region: string; profile: string; resolution: string }> };
  const { region, profile, resolution } = await params;
  try {
    const safeRegion = sanitizeIdentifier(region);
    const safeProfile = escapeString(profile);
    const safeRes = sanitizeIdentifier(resolution);
    const tablePrefix = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion}_${safeProfile.toUpperCase().replace(/-/g, '_')}_`;
    const tables = [`${tablePrefix}MATRIX_${safeRes}`, `${tablePrefix}MATRIX_RAW_${safeRes}`, `${tablePrefix}WORK_QUEUE_${safeRes}`, `${tablePrefix}LIST_${safeRes}`];
    let droppedCount = 0;
    for (const t of tables) {
      try {
        const checkRows = await runSql(`SELECT 1 FROM ${SF_DATABASE}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = 'TRAVEL_MATRIX' AND TABLE_NAME = '${t.split('.').pop()}'`);
        if (checkRows && checkRows.length > 0) { await runSql(`DROP TABLE IF EXISTS ${t}`); droppedCount++; }
      } catch {}
    }
    await runSql(`DELETE FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE REGION = '${escapeString(region)}' AND PROFILE = '${safeProfile}' AND RESOLUTION = '${escapeString(safeRes)}'`);
    return NextResponse.json({ status: droppedCount > 0 ? 'ok' : 'not_found', dropped_count: droppedCount });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
