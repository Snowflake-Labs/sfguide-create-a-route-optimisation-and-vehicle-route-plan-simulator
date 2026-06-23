import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { listDatasets } from '@/server/studio/jobs';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (req: NextRequest) => {
  try {
    const sp = new URL(req.url).searchParams;
    const region = sp.get('region') || undefined;
    const vehicle = sp.get('vehicle') || sp.get('vehicleType') || undefined;
    const rows = await listDatasets(runSql, { region, vehicleType: vehicle });
    return NextResponse.json(rows);
  } catch (e) {
    log('WARN', 'Studio', `Failed to list datasets: ${(e as Error).message?.slice(0, 200)}`);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
});
