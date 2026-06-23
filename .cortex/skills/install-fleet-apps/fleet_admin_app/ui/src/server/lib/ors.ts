// ORS-related helpers used across multiple route handlers.

import { SF_DATABASE } from '../constants';
import { runSql } from './sql';
import { sanitizeIdentifier, escapeString } from './sanitize';
import { safeRegionIdent, normalizeRegion, isDefaultRegion } from './region';

const DEFAULT_PROFILES = ['driving-car', 'driving-hgv', 'cycling-electric'];
let cachedDefaultExpectedProfiles: string[] | null = null;

// Issue a minimal /directions canary against the per-region ORS service.
// ORS_STATUS reports service_ready=true the instant the engine accepts
// connections, but the very first /directions call after RESUME can still
// race with the in-memory graph load (~5-30s window) and surface as
// `connection_failed` to downstream callers. This canary forces that
// transient failure to land HERE, inside the wait loop, instead of in
// the first real query. (#53)
//
// Picks a tiny ~500m segment near the region's bbox centroid so the call
// is cheap, succeeds on any graph topology, and never hits per-profile
// extremes. Returns true iff the call returned a non-error response.
async function _canaryDirections(region: string, profile: string): Promise<boolean> {
  try {
    const safeRegion = safeRegionIdent(normalizeRegion(region));
    const bboxRows = await runSql(
      `SELECT MIN_LAT, MAX_LAT, MIN_LON, MAX_LON FROM ${SF_DATABASE}.CORE.REGION_ORS_MAP WHERE UPPER(REGION) = UPPER('${escapeString(safeRegion)}') LIMIT 1`,
    );
    const row = bboxRows?.[0];
    if (!row) return false;
    const midLat = (Number(row.MIN_LAT) + Number(row.MAX_LAT)) / 2;
    const midLon = (Number(row.MIN_LON) + Number(row.MAX_LON)) / 2;
    if (!Number.isFinite(midLat) || !Number.isFinite(midLon)) return false;
    // ~500m offset in lon (works near every populated latitude). Pairs the
    // centroid with a point slightly east; both should snap onto roads in
    // any non-trivial extract.
    const lon2 = midLon + 0.005;
    const safeProfile = profile.replace(/[^a-z-]/gi, '');
    const sql = `SELECT ${SF_DATABASE}.CORE.DIRECTIONS('${safeProfile}', ${midLon}, ${midLat}, ${lon2}, ${midLat}, '${escapeString(safeRegion)}') AS R`;
    const rows = await runSql(sql);
    const raw = rows?.[0]?.R;
    if (!raw) return false;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // The DIRECTIONS SQL wrapper returns an object with `RESPONSE` (JSON
    // string) -- when ORS returned `error`, the wrapper surfaces that text.
    const inner = parsed.RESPONSE ?? parsed.response ?? parsed;
    const innerObj = typeof inner === 'string' ? (() => { try { return JSON.parse(inner); } catch { return null; } })() : inner;
    if (!innerObj) return false;
    return !innerObj.error;
  } catch {
    return false;
  }
}

// Poll ORS_STATUS until the graph for `region` reports ready (service_ready &
// at least one profile loaded), or maxWaitSecs is exceeded. Returns the
// final state. Used by region provisioning + diagnose endpoints to gate
// follow-on operations on a fully warmed-up ORS.
//
// After ORS_STATUS reports ready, additionally fire a /directions canary
// (#53) to confirm the engine can actually answer routing calls. The
// canary is best-effort: a failed canary keeps the loop polling rather
// than returning false immediately, because the engine occasionally
// reports ready 1-2 polls before the first /directions succeeds.
export async function waitForOrsGraphReady(
  region: string,
  maxWaitSecs: number = 600,
): Promise<{ ready: boolean; elapsed: number; profiles: string[]; canary?: 'ok' | 'failed' | 'skipped' }> {
  const start = Date.now();
  const interval = 15000;
  const maxAttempts = Math.ceil((maxWaitSecs * 1000) / interval);
  const safeRegion = safeRegionIdent(normalizeRegion(region));
  const statusSql = `SELECT ${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}') AS S`;
  let lastCanary: 'ok' | 'failed' | 'skipped' = 'skipped';

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const rows = await runSql(statusSql);
      const raw = rows?.[0]?.S;
      if (raw) {
        const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (status.service_ready === true && status.profiles) {
          const profileNames = Object.keys(status.profiles);
          if (profileNames.length > 0) {
            // ORS engine accepts connections; verify it can actually answer
            // routing calls before declaring the region ready.
            //
            // KNOWN LIMITATION (#audit-pr-120): the canary probes only ONE
            // profile (the first 'driving|cycling|foot' match). If a region
            // has multiple profiles loaded but a second profile is still
            // warming JVM classes, this loop returns ready=true and the
            // first call against the second profile may still 502.
            //
            // Mitigation: ORS_STATUS already lists ALL loaded profiles in
            // status.profiles, and only profiles that finished CH/LM build
            // appear in that map -- so a profile being in profileNames is
            // a strong signal it is also serviceable. The canary is a
            // belt-and-suspenders engine-liveness check, not a per-profile
            // SLO. Probing all N profiles each poll-iteration would add
            // ~N*200ms to graph-ready latency for marginal coverage gain.
            const probeProfile = profileNames.find((p) => /^(driving|cycling|foot)/.test(p)) || profileNames[0];
            const canaryOk = await _canaryDirections(region, probeProfile);
            lastCanary = canaryOk ? 'ok' : 'failed';
            if (canaryOk) {
              return { ready: true, elapsed: Math.round((Date.now() - start) / 1000), profiles: profileNames, canary: 'ok' };
            }
            // Canary failed: graph is loaded but first-call race not yet
            // settled. Continue the poll loop; do NOT short-circuit to
            // ready, even though ORS_STATUS says yes.
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  return { ready: false, elapsed: Math.round((Date.now() - start) / 1000), profiles: [], canary: lastCanary };
}

// Return the list of routing profiles expected to be loaded for the given
// region. For the default region, we parse the ors-config.yml on the SPCS
// stage. For other regions, we look at the most recent provision job.
// Falls back to DEFAULT_PROFILES.
export async function getExpectedProfiles(region: string): Promise<string[]> {
  if (isDefaultRegion(region)) {
    if (cachedDefaultExpectedProfiles) return cachedDefaultExpectedProfiles;
    try {
      const rows = await runSql(`SELECT "$1" AS CONTENT FROM @${SF_DATABASE}.CORE.ORS_SPCS_STAGE/SanFrancisco/ors-config.yml (FILE_FORMAT => (TYPE='CSV' FIELD_DELIMITER=NONE RECORD_DELIMITER=NONE))`);
      const content = rows?.[0]?.CONTENT;
      if (content && typeof content === 'string') {
        const profileMatches = content.match(/profiles:\s*([\s\S]*?)(?:^\S|$)/m);
        if (profileMatches) {
          const profiles: string[] = [];
          const enabledPattern = /([\w-]+):\s*\n[\s\S]*?enabled:\s*true/gm;
          const block = profileMatches[1];
          let m;
          while ((m = enabledPattern.exec(block)) !== null) {
            profiles.push(m[1]);
          }
          if (profiles.length > 0) {
            cachedDefaultExpectedProfiles = profiles;
            return profiles;
          }
        }
      }
    } catch (e: any) {
      console.log(`[getExpectedProfiles] Could not parse config from stage: ${e.message}`);
    }
    cachedDefaultExpectedProfiles = DEFAULT_PROFILES;
    return DEFAULT_PROFILES;
  }
  try {
    const safeRegion = sanitizeIdentifier(region);
    // Prefer the most recent non-failed job record for this region so that an
    // in-flight RUNNING job's requested profiles drive the UI. If only FAILED
    // rows exist, fall back to the most recent of those (still better than
    // DEFAULT_PROFILES, which would surface phantom profiles like 'driving-car'
    // for a job that only requested 'driving-hgv').
    const rows = await runSql(`SELECT PROFILES FROM ${SF_DATABASE}.CORE.REGION_PROVISION_JOBS WHERE REGION='${escapeString(safeRegion)}' AND PROFILES IS NOT NULL ORDER BY CASE WHEN COALESCE(STATUS,'') NOT IN ('FAILED','ERROR') THEN 0 ELSE 1 END, COALESCE(COMPLETED_AT, STARTED_AT, CREATED_AT) DESC LIMIT 1`);
    const profileStr = rows?.[0]?.PROFILES;
    if (profileStr && typeof profileStr === 'string') {
      return profileStr.split(',').map((p: string) => p.trim()).filter(Boolean);
    }
  } catch (e: any) {
    console.log(`[getExpectedProfiles] Could not get profiles for ${region}: ${e.message}`);
  }
  return DEFAULT_PROFILES;
}

export { DEFAULT_PROFILES };
