import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (req: NextRequest) => {
  try {
    const sp = new URL(req.url).searchParams;
    const region = sp.get('region') || '';
    const profile = sp.get('profile') || 'driving-car';
    const safeRegion = region ? sanitizeIdentifier(region) : 'SAN_FRANCISCO';
    const safeProfile = profile.replace(/-/g, '_').toUpperCase();
    const prefix = `${safeRegion}_${safeProfile}`;
    const counts: Record<string, number> = {};
    for (const r of [5, 6, 7, 8, 9, 10]) {
      try {
        const rows = await runSql(`SELECT COUNT(*) AS CNT FROM ${SF_DATABASE}.TRAVEL_MATRIX.${prefix}_MATRIX_RES${r}`);
        const cnt = parseInt(rows?.[0]?.CNT || '0');
        if (cnt > 0) counts[`RES${r}`] = cnt;
      } catch {}
    }
    return NextResponse.json(counts);
  } catch {
    return NextResponse.json({});
  }
});
