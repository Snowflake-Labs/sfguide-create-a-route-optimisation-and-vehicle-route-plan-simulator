import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { escapeString } from '@/server/lib/sanitize';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (req: NextRequest) => {
  try {
    const sp = new URL(req.url).searchParams;
    const search = (sp.get('search') || '').trim();
    const source = (sp.get('source') || '').trim();
    const level = (sp.get('level') || '').trim();
    let where = 'WHERE 1=1';
    if (search) where += ` AND LOWER(REGION_NAME) LIKE '%${escapeString(search.toLowerCase())}%'`;
    if (source) where += ` AND SOURCE = '${escapeString(source)}'`;
    if (level) where += ` AND LEVEL = '${escapeString(level)}'`;
    const rows = await runSql(`SELECT CATALOG_ID, SOURCE, REGION_NAME, REGION_KEY, HIERARCHY, CONTINENT, COUNTRY, PBF_URL, PBF_SIZE_MB, LEVEL, MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM ${SF_DATABASE}.CORE.REGION_CATALOG ${where} QUALIFY ROW_NUMBER() OVER (PARTITION BY SOURCE, REGION_KEY, COALESCE(COUNTRY,'') ORDER BY CATALOG_ID) = 1 ORDER BY SOURCE, CONTINENT, COUNTRY, REGION_NAME`);
    return NextResponse.json({ catalog: rows || [] });
  } catch (err) {
    return NextResponse.json({ catalog: [], error: (err as Error).message });
  }
});
