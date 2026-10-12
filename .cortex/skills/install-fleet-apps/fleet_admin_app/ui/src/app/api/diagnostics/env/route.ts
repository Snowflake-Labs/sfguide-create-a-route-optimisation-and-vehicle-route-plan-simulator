import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { IS_SPCS, SF_DATABASE, SF_WAREHOUSE } from '@/server/constants';
import { formatUptime } from '@/server/lib/cache';
import { getUptimeMs } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APP_VERSION = process.env.APP_VERSION || '0.0.0';

export const GET = withLogging(async () => {
  const mem = process.memoryUsage();
  return NextResponse.json({
    version: APP_VERSION,
    uptimeMs: getUptimeMs(),
    uptime: formatUptime(getUptimeMs()),
    isSpcs: IS_SPCS,
    database: SF_DATABASE,
    warehouse: SF_WAREHOUSE,
    nodeVersion: process.version,
    memoryMb: {
      rss: Math.round(mem.rss / 1048576),
      heapUsed: Math.round(mem.heapUsed / 1048576),
      heapTotal: Math.round(mem.heapTotal / 1048576),
    },
  });
});
