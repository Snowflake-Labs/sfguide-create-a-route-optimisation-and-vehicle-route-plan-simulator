import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = withLogging(async (req: NextRequest, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ id: string }> };
  const { id } = await params;
  try {
    const { name, ors_profile, region, config } = await req.json();
    const configJson = JSON.stringify(config).replace(/\$\$/g, '$ $');
    const safeName = (name || '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '');
    await runSql(
      `UPDATE FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS
       SET NAME='${safeName}', ORS_PROFILE='${ors_profile || ''}', REGION='${region || ''}',
           CONFIG=PARSE_JSON($$${configJson}$$), UPDATED_AT=SYSDATE()
       WHERE PRESET_ID='${id.replace(/'/g, "''")}'`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});

export const DELETE = withLogging(async (req: NextRequest, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ id: string }> };
  const { id } = await params;
  try {
    await runSql(`DELETE FROM FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS WHERE PRESET_ID='${id.replace(/'/g, "''")}' AND IS_BUILTIN = FALSE`, 'FLEET_INTELLIGENCE', 'CORE');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
