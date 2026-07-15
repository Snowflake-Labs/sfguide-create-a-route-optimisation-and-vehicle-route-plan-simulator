import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier, toIso } from '@/server/lib/sanitize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (_req, ctx?: unknown) => {
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region } = await params;
  try {
    const safeRegion = sanitizeIdentifier(region);
    const rows = await runSql(
      `SELECT BUILD_ID, JOB_ID, REGION, INSTANCE_FAMILY, COMPUTE_SIZE,
              PROFILES, JVM_XMX_GIB, STARTED_AT, FINISHED_AT, ELAPSED_MINUTES,
              EXIT_STATUS, PEAK_RSS_GIB, OUTPUT_GRAPH_GIB
       FROM ${SF_DATABASE}.CORE.ORS_BUILD_HISTORY
       WHERE UPPER(REGION) = UPPER('${safeRegion}')
       ORDER BY STARTED_AT DESC LIMIT 25`,
    );
    const history = (rows || []).map((r) => ({ ...r, STARTED_AT: toIso(r.STARTED_AT), FINISHED_AT: toIso(r.FINISHED_AT) }));
    return NextResponse.json({ region: safeRegion, history });
  } catch (err) {
    return NextResponse.json({ region, history: [], error: (err as Error).message }, { status: 500 });
  }
});
