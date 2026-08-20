import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { requireOps } from '@/lib/ingress-identity';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Accelerator-scoped daily credit consumption for the last 21 days:
//   Warehouse = ROUTING_ANALYTICS (WAREHOUSE_METERING_HISTORY)
//   SPCS      = the accelerator's compute pools (SNOWPARK_CONTAINER_SERVICES_HISTORY)
// Data lives only in SNOWFLAKE.ACCOUNT_USAGE, which the admin service role can
// read only after `GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER TO ROLE <role>`.
// When that grant is missing we return 200 { needsGrant: true } so the widget
// degrades to a friendly notice instead of erroring. Metering lags ~1-3h, so
// the current day is partial.
const CONSUMPTION_SQL = `
WITH days AS (
  SELECT DATEADD('day', -(ROW_NUMBER() OVER (ORDER BY SEQ4())-1), CURRENT_DATE()) AS D
  FROM TABLE(GENERATOR(ROWCOUNT => 21))
),
wh AS (
  SELECT TO_DATE(START_TIME) D, SUM(CREDITS_USED) C
  FROM SNOWFLAKE.ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY
  WHERE WAREHOUSE_NAME = 'ROUTING_ANALYTICS'
    AND START_TIME >= DATEADD('day', -21, CURRENT_DATE())
  GROUP BY 1
),
spcs AS (
  SELECT TO_DATE(START_TIME) D, SUM(CREDITS_USED) C
  FROM SNOWFLAKE.ACCOUNT_USAGE.SNOWPARK_CONTAINER_SERVICES_HISTORY
  WHERE (COMPUTE_POOL_NAME IN ('OPENROUTESERVICE_APP_COMPUTE_POOL','FLEET_APPS_COMPUTE_POOL')
         OR COMPUTE_POOL_NAME ILIKE 'ORS_POOL_%')
    AND START_TIME >= DATEADD('day', -21, CURRENT_DATE())
  GROUP BY 1
)
SELECT TO_VARCHAR(d.D) AS DAY,
       ROUND(COALESCE(wh.C, 0), 3)                     AS WAREHOUSE_CREDITS,
       ROUND(COALESCE(spcs.C, 0), 3)                   AS SPCS_CREDITS,
       ROUND(COALESCE(wh.C, 0) + COALESCE(spcs.C, 0), 3) AS TOTAL_CREDITS
FROM days d
LEFT JOIN wh   ON wh.D = d.D
LEFT JOIN spcs ON spcs.D = d.D
ORDER BY d.D`;

function isAccessError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('does not exist or not authorized')
    || m.includes('insufficient privileges')
    || m.includes('not authorized');
}

export const GET = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const rows = await runSql(CONSUMPTION_SQL);
    return NextResponse.json({ rows: rows || [] });
  } catch (err) {
    const msg = (err as Error)?.message?.slice(0, 300) || String(err);
    if (isAccessError(msg)) {
      log('INFO', 'Observability', `/consumption needs USAGE_VIEWER grant: ${msg}`);
      return NextResponse.json({
        rows: [],
        needsGrant: true,
        grantHint: 'GRANT DATABASE ROLE SNOWFLAKE.USAGE_VIEWER TO ROLE <admin app service-owner role>;',
      });
    }
    log('WARN', 'Observability', `/consumption failed: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
});
