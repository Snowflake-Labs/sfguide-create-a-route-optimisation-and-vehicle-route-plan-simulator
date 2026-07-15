import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  const status: Record<string, 'ok' | 'missing' | 'error'> = {};
  const errors: Record<string, string> = {};
  const probes: { key: string; sql: string }[] = [
    { key: 'resolver', sql: `CALL ${SF_DATABASE}.CORE.RESOLVE_LARGEST_HIGHMEM_FAMILY()` },
    { key: 'retry_strategy', sql: `CALL ${SF_DATABASE}.CORE.RECOMMEND_RETRY_STRATEGY('__HEALTHCHECK__')` },
    { key: 'build_history', sql: `SELECT 1 FROM ${SF_DATABASE}.CORE.ORS_BUILD_HISTORY LIMIT 1` },
    { key: 'build_spec', sql: `SELECT ${SF_DATABASE}.CORE.BUILD_ORS_SERVICE_SPEC('X','XXL','false')` },
    { key: 'downsize_proc', sql: `SHOW PROCEDURES LIKE 'DOWNSIZE_REGION_AFTER_BUILD' IN SCHEMA ${SF_DATABASE}.CORE` },
  ];
  await Promise.all(probes.map(async ({ key, sql }) => {
    try {
      const rows = await runSql(sql);
      if (key === 'downsize_proc') status[key] = rows && rows.length > 0 ? 'ok' : 'missing';
      else status[key] = 'ok';
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      if (/does not exist|not authorized|unknown function/i.test(msg)) status[key] = 'missing';
      else { status[key] = 'error'; errors[key] = msg.slice(0, 200); }
    }
  }));
  const overall = Object.values(status).every((v) => v === 'ok') ? 'ok' : 'degraded';
  return NextResponse.json({ overall, status, errors });
});
