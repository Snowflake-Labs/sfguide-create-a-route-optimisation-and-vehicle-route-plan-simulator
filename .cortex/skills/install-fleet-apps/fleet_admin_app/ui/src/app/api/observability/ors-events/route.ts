import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async (req: NextRequest) => {
  const sp = new URL(req.url).searchParams;
  const limitRaw = parseInt(sp.get('limit') || '200', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 1000) : 200;
  const endpoint = (sp.get('endpoint') || '').trim();
  const onlyErrors = (sp.get('errors') || '').trim() === '1';
  try {
    // CURRENT_TIMESTAMP(), not SYSDATE(): REQUEST_TS is TIMESTAMP_LTZ and
    // SYSDATE() is the UTC wall clock as NTZ, so comparing them shifts the
    // cutoff forward by the session's UTC offset. Measured: this "24h" filter
    // really covered 17h, and the summary view's "1h" window was
    // unconditionally empty. See 08_observability.sql for the full note.
    const filters: string[] = ['REQUEST_TS >= DATEADD(hour, -24, CURRENT_TIMESTAMP())'];
    if (endpoint && /^[a-z_]+$/i.test(endpoint)) filters.push(`ENDPOINT = '${endpoint.toLowerCase()}'`);
    if (onlyErrors) filters.push('(STATUS_CODE >= 400 OR ERROR_CODE IS NOT NULL)');
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = await runSql(
      `SELECT TO_VARCHAR(REQUEST_TS) AS REQUEST_TS, REQUEST_ID, ENDPOINT, PROFILE, REGION, ORS_HOST,
              STATUS_CODE, ERROR_CODE, LATENCY_MS, REQUEST_BYTES, RESPONSE_BYTES, CALLER
       FROM OPENROUTESERVICE_APP.OBSERVABILITY.ORS_REQUEST_LOG
       ${where} ORDER BY REQUEST_TS DESC LIMIT ${limit}`,
    );
    return NextResponse.json({ rows: rows || [] });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message?.slice(0, 300) || String(err) }, { status: 500 });
  }
});
