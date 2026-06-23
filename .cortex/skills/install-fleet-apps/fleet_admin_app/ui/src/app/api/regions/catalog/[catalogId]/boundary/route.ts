import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { escapeString } from '@/server/lib/sanitize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (_req, ctx?: unknown) => {
  const { params } = ctx as { params: Promise<{ catalogId: string }> };
  const { catalogId: raw } = await params;
  try {
    const catalogId = escapeString(String(raw || '').trim());
    if (!catalogId) return NextResponse.json({ boundaryGeoJson: null, error: 'catalogId required' }, { status: 400 });
    const rows = await runSql(`SELECT CAST(ST_ASGEOJSON(BOUNDARY) AS VARCHAR) AS BOUNDARY_GEOJSON FROM ${SF_DATABASE}.CORE.REGION_CATALOG WHERE CATALOG_ID = '${catalogId}' LIMIT 1`);
    return NextResponse.json({ boundaryGeoJson: rows?.[0]?.BOUNDARY_GEOJSON ?? null });
  } catch (err) {
    return NextResponse.json({ boundaryGeoJson: null, error: (err as Error).message }, { status: 500 });
  }
});
