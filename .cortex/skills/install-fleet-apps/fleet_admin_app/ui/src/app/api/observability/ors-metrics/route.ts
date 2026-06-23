import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const rows = await runSql(
      `SELECT WINDOW_NAME, ENDPOINT, REQ_COUNT, ERROR_COUNT, ERROR_RATE_PCT,
              P50_MS, P95_MS, MAX_MS, AVG_MS, AVG_REQ_BYTES, AVG_RESP_BYTES,
              TO_VARCHAR(LAST_EVENT_TS) AS LAST_EVENT_TS
       FROM OPENROUTESERVICE_APP.OBSERVABILITY.V_ORS_METRICS_SUMMARY`,
    );
    return NextResponse.json({ rows: rows || [] });
  } catch (err) {
    const msg = (err as Error)?.message?.slice(0, 300) || String(err);
    log('WARN', 'Observability', `/ors-metrics failed: ${msg}`);
    return NextResponse.json({ error: msg, hint: 'Confirm module 08_observability.sql has been deployed and ORS_METRICS_INGEST_TASK is resumed.' }, { status: 500 });
  }
});
