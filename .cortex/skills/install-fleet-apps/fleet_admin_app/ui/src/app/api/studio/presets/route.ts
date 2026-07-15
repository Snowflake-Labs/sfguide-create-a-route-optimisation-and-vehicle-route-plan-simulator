import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withLogging(async () => {
  try {
    const rows = await runSql(
      `SELECT PRESET_ID, NAME, ORS_PROFILE, REGION, CONFIG, IS_BUILTIN, CREATED_AT
       FROM FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS ORDER BY IS_BUILTIN DESC, CREATED_AT`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    const presets = rows.map((r) => ({
      preset_id: r.PRESET_ID, name: r.NAME, ors_profile: r.ORS_PROFILE, region: r.REGION,
      config: typeof r.CONFIG === 'string' ? JSON.parse(r.CONFIG) : r.CONFIG,
      is_builtin: r.IS_BUILTIN === true || r.IS_BUILTIN === 'true', created_at: r.CREATED_AT,
    }));
    return NextResponse.json(presets);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});

export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const { name, ors_profile, region, config } = await req.json();
    if (!name || !ors_profile || !region || !config) return NextResponse.json({ error: 'name, ors_profile, region, config required' }, { status: 400 });
    const configJson = JSON.stringify(config).replace(/\$\$/g, '$ $');
    const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[\x00-\x1f]/g, '');
    await runSql(
      `INSERT INTO FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS (PRESET_ID, NAME, ORS_PROFILE, REGION, CONFIG)
       SELECT UUID_STRING(), '${safeName}', '${ors_profile}', '${region}', PARSE_JSON($$${configJson}$$)`,
      'FLEET_INTELLIGENCE', 'CORE',
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
