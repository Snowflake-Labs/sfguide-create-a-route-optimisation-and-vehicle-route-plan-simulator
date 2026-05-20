// ORS-related helpers used across multiple route handlers.

import { SF_DATABASE } from '../constants.js';
import { runSql } from './sql.js';
import { sanitizeIdentifier, escapeString } from './sanitize.js';
import { safeRegionIdent, normalizeRegion, isDefaultRegion } from './region.js';

const DEFAULT_PROFILES = ['driving-car', 'driving-hgv', 'cycling-electric'];
let cachedDefaultExpectedProfiles: string[] | null = null;

// Poll ORS_STATUS until the graph for `region` reports ready (service_ready &
// at least one profile loaded), or maxWaitSecs is exceeded. Returns the
// final state. Used by region provisioning + diagnose endpoints to gate
// follow-on operations on a fully warmed-up ORS.
export async function waitForOrsGraphReady(
  region: string,
  maxWaitSecs: number = 600,
): Promise<{ ready: boolean; elapsed: number; profiles: string[] }> {
  const start = Date.now();
  const interval = 15000;
  const maxAttempts = Math.ceil((maxWaitSecs * 1000) / interval);
  const safeRegion = safeRegionIdent(normalizeRegion(region));
  const statusSql = `SELECT ${SF_DATABASE}.CORE.ORS_STATUS('${safeRegion}') AS S`;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const rows = await runSql(statusSql);
      const raw = rows?.[0]?.S;
      if (raw) {
        const status = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (status.service_ready === true && status.profiles) {
          const profileNames = Object.keys(status.profiles);
          if (profileNames.length > 0) {
            return { ready: true, elapsed: Math.round((Date.now() - start) / 1000), profiles: profileNames };
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, interval));
  }
  return { ready: false, elapsed: Math.round((Date.now() - start) / 1000), profiles: [] };
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
