import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APP_VERSION = process.env.APP_VERSION || '0.0.0';

async function serviceStatus(fqn: string): Promise<string> {
  try {
    const rows = await runSql(`SELECT PARSE_JSON(SYSTEM$GET_SERVICE_STATUS('${fqn}')) AS S`);
    const raw = rows?.[0]?.S;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) return parsed[0]?.status || 'UNKNOWN';
    return 'UNKNOWN';
  } catch {
    return 'ERROR';
  }
}

export const GET = withLogging(async () => {
  const result: Record<string, unknown> = { healthy: false, version: APP_VERSION, services: {} };
  const services = result.services as Record<string, string>;

  services.ors = await serviceStatus(`${SF_DATABASE}.CORE.ORS_SERVICE_SANFRANCISCO`);
  services.gateway = await serviceStatus(`${SF_DATABASE}.CORE.ROUTING_GATEWAY_SERVICE`);
  services.vroom = await serviceStatus(`${SF_DATABASE}.CORE.VROOM_SERVICE_SANFRANCISCO`);

  try {
    const versionRows = await runSql(`SELECT COMPONENT, VERSION FROM ${SF_DATABASE}.CORE.VERSION_INFO`);
    if (versionRows?.length) {
      const versions: Record<string, unknown> = {};
      for (const row of versionRows) versions[row.COMPONENT || row.component] = row.VERSION || row.version;
      result.versions = versions;
    }
  } catch (err) {
    const msg = (err as Error)?.message?.slice(0, 200) || String(err);
    result.versions_error = msg;
    log('WARN', 'Health', `/api/health VERSION_INFO query failed: ${msg}`);
  }

  result.healthy = services.ors === 'READY' && services.gateway === 'READY';
  return NextResponse.json(result);
});
