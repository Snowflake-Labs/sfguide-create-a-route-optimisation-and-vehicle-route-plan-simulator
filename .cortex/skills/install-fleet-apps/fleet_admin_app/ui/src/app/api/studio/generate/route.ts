import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { startGeneration } from '@/server/studio/jobs';
import { GenerationConfig, defaultDistanceDistributionForArea } from '@/server/studio/profiles';
import { bboxAreaKm2 } from '@/server/studio/engine/spatial';
import { resolveRegionBbox, resolveRegionAreaKm2, checkOrsReadiness } from '@/server/studio/route-helpers';
import { requireOps } from '@/lib/ingress-identity';
import { log } from '@/server/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  try {
    const { preset_id, config: rawConfig, preset_name } = await req.json();
    let config: GenerationConfig;
    let name: string;

    if (preset_id) {
      const rows = await runSql(`SELECT NAME, ORS_PROFILE, REGION, CONFIG FROM FLEET_INTELLIGENCE.CORE.GENERATION_PRESETS WHERE PRESET_ID='${String(preset_id).replace(/'/g, "''")}'`, 'FLEET_INTELLIGENCE', 'CORE');
      if (!rows.length) return NextResponse.json({ error: 'Preset not found' }, { status: 404 });
      const preset = rows[0];
      const presetConfig = typeof preset.CONFIG === 'string' ? JSON.parse(preset.CONFIG) : preset.CONFIG;
      name = preset.NAME as string;
      config = { ...presetConfig, region: preset.REGION, ors_profile: preset.ORS_PROFILE };
    } else if (rawConfig) {
      config = rawConfig;
      name = preset_name || `Custom ${config.ors_profile}`;
    } else {
      return NextResponse.json({ error: 'preset_id or config required' }, { status: 400 });
    }

    try {
      config.bbox = await resolveRegionBbox(config.region, runSql);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message, code: 'REGION_NOT_REGISTERED' }, { status: 400 });
    }

    const areaKm2 = (await resolveRegionAreaKm2(config.region, runSql)) ?? bboxAreaKm2(config.bbox);
    config.region_area_km2 = areaKm2;
    if (!config.spatial_spread) {
      config.spatial_spread = { enabled: true, bin_deg: null, min_bins_required: 3 };
    } else {
      if (config.spatial_spread.enabled == null) config.spatial_spread.enabled = true;
      if (config.spatial_spread.min_bins_required == null) config.spatial_spread.min_bins_required = 3;
      if (config.spatial_spread.bin_deg === undefined) config.spatial_spread.bin_deg = null;
    }
    const dd = config.distance_distribution as Record<string, unknown> | undefined;
    const ddIncomplete = !dd || dd.short_pct == null || dd.short_max_km == null || dd.medium_pct == null || dd.medium_max_km == null || dd.long_pct == null;
    if (ddIncomplete) config.distance_distribution = defaultDistanceDistributionForArea(areaKm2);

    // Fast pre-flight ORS readiness gate, but strictly time-bounded. checkOrsReadiness
    // does a live ORS_STATUS() round-trip that can block well past the SPCS ingress
    // ~60s window when the region's service is suspended or still loading a large graph
    // (e.g. Europe) - which surfaces to the client as a 504 "upstream request timeout"
    // text body and a cryptic JSON-parse error. The background job already re-checks
    // readiness via waitForOrsReady, so if the pre-flight does not answer quickly we
    // simply defer to it and return the job id immediately.
    const READINESS_PREFLIGHT_MS = 8000;
    const health = await Promise.race([
      checkOrsReadiness(runSql, config.ors_profile, config.region),
      new Promise<{ ready: boolean; deferred?: boolean }>((resolve) =>
        setTimeout(() => resolve({ ready: true, deferred: true }), READINESS_PREFLIGHT_MS),
      ),
    ]);
    if ((health as { deferred?: boolean }).deferred) {
      log('INFO', 'Studio', `ORS readiness pre-check exceeded ${READINESS_PREFLIGHT_MS}ms for region "${config.region}"; deferring to background waitForOrsReady`);
    } else if (!health.ready) {
      return NextResponse.json({ error: (health as { error?: string }).error, code: 'ORS_NOT_READY' }, { status: 409 });
    }

    const jobId = await startGeneration(config, name, runSql);
    return NextResponse.json({ job_id: jobId, status: 'RUNNING' });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
});
