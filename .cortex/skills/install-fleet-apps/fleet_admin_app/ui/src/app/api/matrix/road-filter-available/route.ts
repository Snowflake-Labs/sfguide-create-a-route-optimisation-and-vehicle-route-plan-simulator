import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    await runSql('SELECT 1 FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT LIMIT 1', 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO');
    return NextResponse.json({ available: true });
  } catch (e) {
    return NextResponse.json({
      available: false,
      reason: 'OVERTURE_MAPS__TRANSPORTATION not accessible. Install from Snowflake Marketplace (CARTO provider) and grant IMPORTED PRIVILEGES.',
      detail: (e as Error).message?.slice(0, 200),
    });
  }
});
