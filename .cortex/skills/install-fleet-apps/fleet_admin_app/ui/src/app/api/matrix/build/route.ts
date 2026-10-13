import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql, submitSqlAsync } from '@/server/lib/sql';
import { sanitizeIdentifier, sanitizeFloat, escapeString } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withLogging(async (req: NextRequest) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { region, resolutions, profile: reqProfile, road_filter, force } = await req.json();
  if (!region || !resolutions) return NextResponse.json({ error: 'region and resolutions required' }, { status: 400 });
  const profile = reqProfile || 'driving-car';
  const roadFilter = road_filter === true;
  let safeRegion: string;
  try { safeRegion = sanitizeIdentifier(region); } catch (err) { return NextResponse.json({ error: `Invalid region: ${(err as Error).message}` }, { status: 400 }); }
  const safeResolutions = (resolutions as number[]).filter((r) => r >= 5 && r <= 10);
  if (safeResolutions.length === 0) return NextResponse.json({ error: 'resolutions must be between 5 and 10' }, { status: 400 });
  const safeProfile = escapeString(profile);
  const safeProfileUpper = profile.replace(/-/g, '_').toUpperCase();

  try {
    const preflightWarnings: string[] = [];
    for (const resolution of safeResolutions) {
      const listTable = `${SF_DATABASE}.TRAVEL_MATRIX.${safeRegion.toUpperCase()}_${safeProfileUpper}_LIST_RES${resolution}`;
      let hexCount = 0;
      try { const rows = await runSql(`SELECT COUNT(*) AS CNT FROM ${listTable}`); hexCount = parseInt(rows?.[0]?.CNT || '0'); } catch { continue; }
      const impliedPairs = hexCount * (hexCount - 1);
      if (impliedPairs > 10_000_000_000 && !force) {
        return NextResponse.json({ error: `Region too large for RES${resolution}: ${hexCount.toLocaleString()} hexagons implies ${(impliedPairs / 1e9).toFixed(1)}B pairs. Split the region or use a coarser resolution. Pass force:true to override.`, hex_count: hexCount, implied_pairs: impliedPairs, resolution, requires_force: true }, { status: 422 });
      }
      if (impliedPairs > 625_000_000) preflightWarnings.push(`RES${resolution}: ${hexCount.toLocaleString()} hexagons (${(impliedPairs / 1e9).toFixed(1)}B pairs) — recommend XLARGE warehouse`);
      else if (impliedPairs > 25_000_000) preflightWarnings.push(`RES${resolution}: ${hexCount.toLocaleString()} hexagons (${(impliedPairs / 1e6).toFixed(0)}M pairs) — recommend LARGE warehouse`);
    }

    let bbox: Record<string, number> = { MIN_LAT: 37.71, MAX_LAT: 37.81, MIN_LON: -122.51, MAX_LON: -122.37 };
    try { const cityRow = await runSql(`SELECT * FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE REGION = '${escapeString(safeRegion)}'`); if (cityRow?.[0]) bbox = cityRow[0]; } catch {}

    let matrixFn = `${SF_DATABASE}.CORE.MATRIX_TABULAR`;
    if (safeRegion && safeRegion.toUpperCase() !== 'DEFAULT' && safeRegion.toUpperCase() !== 'SANFRANCISCO') matrixFn = `${SF_DATABASE}.CORE.MATRIX_TABULAR_W`;

    const jobs: { job_id: string; resolution: number }[] = [];
    const regionDb = safeRegion;
    const insertValues = safeResolutions.map((resolution, i) => {
      const jobId = `${safeRegion.toUpperCase()}_${profile.replace(/-/g, '_')}_RES${resolution}_${Date.now() + i}`.toUpperCase();
      jobs.push({ job_id: jobId, resolution });
      return `('${escapeString(jobId)}', '${escapeString(regionDb)}', '${safeProfile}', 'RES${resolution}', 'PENDING', 'NOT_STARTED')`;
    });
    await runSql(`INSERT INTO ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS (JOB_ID, REGION, PROFILE, RESOLUTION, STATUS, STAGE) VALUES ${insertValues.join(', ')}`);

    // Fire-and-forget: launch each build job async and poll its status.
    (async () => {
      for (const { job_id: jobId, resolution } of jobs) {
        try {
          const callSql = `CALL ${SF_DATABASE}.CORE.BUILD_MATRIX_JOB_WRAPPER('${escapeString(jobId)}', 'RES${resolution}', ${sanitizeFloat(bbox.MIN_LAT)}, ${sanitizeFloat(bbox.MAX_LAT)}, ${sanitizeFloat(bbox.MIN_LON)}, ${sanitizeFloat(bbox.MAX_LON)}, '${escapeString(matrixFn)}', '${escapeString(regionDb)}', '${safeProfile}', ${roadFilter ? 'TRUE' : 'FALSE'})`;
          const handle = await submitSqlAsync(callSql);
          await runSql(`UPDATE ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS SET STATEMENT_HANDLE = '${escapeString(handle)}' WHERE JOB_ID = '${escapeString(jobId)}'`);
          let jobStatus = 'RUNNING';
          while (jobStatus === 'RUNNING' || jobStatus === 'PENDING') {
            await new Promise((r) => setTimeout(r, 10000));
            try { const rows = await runSql(`SELECT STATUS FROM ${SF_DATABASE}.TRAVEL_MATRIX.MATRIX_BUILD_JOBS WHERE JOB_ID = '${escapeString(jobId)}'`); jobStatus = rows?.[0]?.STATUS || 'UNKNOWN'; } catch { break; }
          }
        } catch (e) { console.error(`[matrix/build] async launch error for ${jobId}: ${(e as Error).message}`); }
      }
    })().catch(() => {});

    return NextResponse.json({ status: 'launched', jobs, ...(preflightWarnings.length > 0 ? { warning: preflightWarnings.join('; ') } : {}) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message || 'Internal server error' }, { status: 500 });
  }
});
