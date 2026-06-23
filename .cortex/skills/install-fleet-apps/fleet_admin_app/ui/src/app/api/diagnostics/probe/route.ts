import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  const results: Record<string, { ok: boolean; ms: number; detail?: string }> = {};

  let t = Date.now();
  try {
    await runSql('SELECT 1 AS PING');
    results.snowflakeSql = { ok: true, ms: Date.now() - t };
  } catch (e) {
    results.snowflakeSql = { ok: false, ms: Date.now() - t, detail: (e as Error).message?.slice(0, 200) };
  }

  t = Date.now();
  try {
    const rows = await runSql(`SELECT ${SF_DATABASE}.CORE.ORS_STATUS() AS S`);
    const raw = rows?.[0]?.S;
    const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const profiles = Object.keys(status?.profiles || {});
    results.orsService = { ok: !!status?.service_ready, ms: Date.now() - t, detail: `profiles: ${profiles.join(', ') || 'none'}` };
  } catch (e) {
    results.orsService = { ok: false, ms: Date.now() - t, detail: (e as Error).message?.slice(0, 200) };
  }

  t = Date.now();
  try {
    await runSql('SELECT 1 FROM OVERTURE_MAPS__PLACES.CARTO.PLACE LIMIT 1', 'OVERTURE_MAPS__PLACES', 'CARTO');
    results.overtureMaps = { ok: true, ms: Date.now() - t };
  } catch (e) {
    results.overtureMaps = { ok: false, ms: Date.now() - t, detail: (e as Error).message?.slice(0, 200) };
  }

  t = Date.now();
  try {
    await runSql('SELECT 1 FROM OVERTURE_MAPS__TRANSPORTATION.CARTO.SEGMENT LIMIT 1', 'OVERTURE_MAPS__TRANSPORTATION', 'CARTO');
    results.overtureTransportation = { ok: true, ms: Date.now() - t };
  } catch (e) {
    results.overtureTransportation = { ok: false, ms: Date.now() - t, detail: (e as Error).message?.slice(0, 200) };
  }

  log('INFO', 'Diagnostics', 'Connectivity probe completed', { detail: results });
  return NextResponse.json(results);
});
