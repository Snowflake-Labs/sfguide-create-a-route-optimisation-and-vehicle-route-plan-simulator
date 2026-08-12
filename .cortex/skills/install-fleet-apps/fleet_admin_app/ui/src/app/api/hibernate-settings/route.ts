import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Auto-hibernate settings (Tier B). Reads/writes the single-row driver table
// FLEET_INTELLIGENCE.CORE.COST_SETTINGS consumed by the hourly
// AUTO_HIBERNATE_TASK -> AUTO_HIBERNATE_IF_IDLE proc.
export const GET = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const rows = await runSql(
      `SELECT HIBERNATE_ENABLED, HIBERNATE_IDLE_HOURS
       FROM FLEET_INTELLIGENCE.CORE.COST_SETTINGS WHERE SETTING_KEY = 'GLOBAL' LIMIT 1`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    const r = rows?.[0] as { HIBERNATE_ENABLED?: boolean; HIBERNATE_IDLE_HOURS?: number } | undefined;
    return NextResponse.json({
      enabled: r?.HIBERNATE_ENABLED ?? true,
      idleHours: Number(r?.HIBERNATE_IDLE_HOURS ?? 4),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});

export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const body = await req.json().catch(() => ({}));
    const enabled = body?.enabled === true ? 'TRUE' : 'FALSE';
    // Clamp idle hours to a sane 1..168 (1h..1week) range; default 4.
    const rawHours = Number(body?.idleHours);
    const idleHours = Number.isFinite(rawHours) ? Math.min(168, Math.max(1, Math.round(rawHours))) : 4;
    await runSql(
      `MERGE INTO FLEET_INTELLIGENCE.CORE.COST_SETTINGS t
       USING (SELECT 'GLOBAL' AS SETTING_KEY) s ON t.SETTING_KEY = s.SETTING_KEY
       WHEN MATCHED THEN UPDATE SET HIBERNATE_ENABLED = ${enabled}, HIBERNATE_IDLE_HOURS = ${idleHours}, UPDATED_AT = CURRENT_TIMESTAMP()
       WHEN NOT MATCHED THEN INSERT (SETTING_KEY, HIBERNATE_ENABLED, HIBERNATE_IDLE_HOURS)
         VALUES ('GLOBAL', ${enabled}, ${idleHours})`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    return NextResponse.json({ status: 'ok', enabled: enabled === 'TRUE', idleHours });
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message }, { status: 500 });
  }
});
