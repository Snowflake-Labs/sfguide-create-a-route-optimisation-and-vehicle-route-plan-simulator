import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier } from '@/server/lib/sanitize';
import { orsServiceFqn } from '@/server/lib/region';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Faithful port of ors_control_app provisioning.ts GET /api/regions/:region/build-progress.
export const GET = withLogging(async (_req, ctx?: unknown) => {
  const { params } = ctx as { params: Promise<{ region: string }> };
  const { region } = await params;
  try {
    const safeRegion = sanitizeIdentifier(region);
    const svcName = orsServiceFqn(region);

    // Fast path: ORS_STATUS is source of truth.
    try {
      const statusRows = await runSql(`SELECT ${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}')::VARCHAR AS S`);
      const statusRaw = statusRows?.[0]?.S;
      if (statusRaw) {
        const parsed = JSON.parse(statusRaw);
        if (parsed?.service_ready === true && parsed?.profiles) {
          const loaded = Object.keys(parsed.profiles);
          if (loaded.length > 0) {
            return NextResponse.json({ phase: 'ready', progress: 100, completedProfiles: loaded, totalProfiles: loaded.length, currentProfile: null });
          }
        }
      }
    } catch { /* fall through to log scraping */ }

    const rows = await runSql(`SELECT SYSTEM$GET_SERVICE_LOGS('${svcName}', 0, 'ors', 1000) AS LOGS`);
    const logs: string = rows?.[0]?.LOGS || '';

    const finishedProfiles = [...logs.matchAll(/\[\d+\] Profiles?: '([\w-]+)'/g)].map((m) => m[1]);
    const startedProfiles = [...logs.matchAll(/ORS-pl-([\w-]+)/g)].map((m) => m[1]);
    const uniqueStarted = [...new Set(startedProfiles)];
    const totalProfiles = Math.max(uniqueStarted.length, finishedProfiles.length);

    const weightToProfile = (tok: string): string => {
      if (tok.startsWith('hgv_ors')) return 'driving-hgv';
      if (tok.startsWith('car_ors')) return 'driving-car';
      if (tok.startsWith('electrobike')) return 'cycling-electric';
      if (tok.startsWith('bike_ors')) return 'cycling-regular';
      if (tok.startsWith('pedestrian')) return 'foot-walking';
      return tok;
    };
    const weightTokens = [...logs.matchAll(/(hgv_ors|car_ors|electrobike|bike_ors|pedestrian)/g)].map((m) => m[1]);
    const contracting = weightTokens.length > 0 ? weightToProfile(weightTokens[weightTokens.length - 1]) : null;
    const lastStarted = uniqueStarted.length > 0 ? uniqueStarted[uniqueStarted.length - 1] : null;
    const currentProfile =
      (contracting && !finishedProfiles.includes(contracting)) ? contracting
      : (lastStarted && !finishedProfiles.includes(lastStarted)) ? lastStarted
      : null;

    if (finishedProfiles.length === totalProfiles && totalProfiles > 0 && !currentProfile) {
      const healthOk = logs.includes('Started Application');
      return NextResponse.json({ phase: healthOk ? 'ready' : 'finalizing', progress: healthOk ? 100 : 99, completedProfiles: finishedProfiles, totalProfiles, currentProfile: null });
    }

    const nodeLines = [...logs.matchAll(/edge,\s*nodes:\s*([\d\s]+\d),\s*shortcuts:\s*([\d\s]+\d)/g)];
    const profileTagEsc = currentProfile ? `ORS-pl-${currentProfile}`.replace(/[-/]/g, '\\$&') : null;
    const hasImport = profileTagEsc ? new RegExp(`${profileTagEsc}.*?start creating graph`).test(logs) : false;
    const hasCH = profileTagEsc ? new RegExp(`${profileTagEsc}.*?Creating CH preparations`).test(logs) : false;
    const hasLM = profileTagEsc ? new RegExp(`${profileTagEsc}.*?Creating LM preparations`).test(logs) : false;

    if (nodeLines.length === 0 || !hasCH) {
      const started = logs.includes('Starting Application') || logs.includes('Spring Boot');
      let phase = 'waiting';
      if (started) phase = hasImport ? 'importing' : 'initializing';
      return NextResponse.json({
        phase,
        progress: totalProfiles > 0 ? Math.round((finishedProfiles.length / totalProfiles) * 100) : 0,
        completedProfiles: finishedProfiles, totalProfiles, currentProfile,
      });
    }

    if (hasLM) {
      const lmDoWorkRe = /Calling LM prepare\.doWork on\s+(\d+)\/(\d+)/g;
      let lmCurrent = 0, lmTotal = 0;
      let m: RegExpExecArray | null;
      while ((m = lmDoWorkRe.exec(logs)) !== null) {
        const cur = parseInt(m[1], 10), tot = parseInt(m[2], 10);
        if (Number.isFinite(cur) && Number.isFinite(tot) && tot > 0) { lmCurrent = Math.max(lmCurrent, cur); lmTotal = Math.max(lmTotal, tot); }
      }
      const lmProfileFrac = lmTotal > 0 ? 0.7 + 0.29 * (lmCurrent / lmTotal) : 0.95;
      const profileProgress = Math.min(Math.round(lmProfileFrac * 100), 99);
      const overallProgress = totalProfiles > 0 ? Math.round(((finishedProfiles.length + lmProfileFrac) / totalProfiles) * 100) : profileProgress;
      return NextResponse.json({
        phase: 'building', progress: Math.min(overallProgress, 99), profileProgress, currentProfile,
        completedProfiles: finishedProfiles, totalProfiles,
        lmCurrent: lmCurrent > 0 ? lmCurrent : undefined, lmTotal: lmTotal > 0 ? lmTotal : undefined,
        detail: lmTotal > 0 ? `Landmark preparation (${lmCurrent}/${lmTotal} sets)` : 'Landmark preparation',
      });
    }

    const parseNum = (s: string) => parseInt(s.replace(/\s/g, ''), 10);
    const firstNodes = parseNum(nodeLines[0][1]);
    const lastNodes = parseNum(nodeLines[nodeLines.length - 1][1]);
    const profileProgress = firstNodes > 0 ? 1 - lastNodes / firstNodes : 0;
    const overallProgress = totalProfiles > 0 ? Math.round(((finishedProfiles.length + profileProgress * 0.9) / totalProfiles) * 100) : Math.round(profileProgress * 90);
    return NextResponse.json({
      phase: 'building', progress: Math.min(overallProgress, 99),
      profileProgress: Math.min(Math.round(profileProgress * 100), 99),
      nodesRemaining: lastNodes, nodesTotal: firstNodes, currentProfile,
      completedProfiles: finishedProfiles, totalProfiles,
    });
  } catch (err) {
    return NextResponse.json({ phase: 'unknown', progress: 0, error: (err as Error).message });
  }
});
