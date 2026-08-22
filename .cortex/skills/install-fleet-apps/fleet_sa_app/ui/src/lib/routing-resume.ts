// Server-only helper: on detecting a suspended routing engine, resume the
// region's ORS + VROOM services and build the typed SuspendedInfo payload.
//
// The SA app runs SQL as a fixed service role (SNOWFLAKE_ROLE, ACCOUNTADMIN when
// deployed) via lib/snowflake, so it can issue the narrowly-scoped, idempotent
// ALTER SERVICE IF EXISTS ... RESUME directly - no ops-role gating on the
// ingress user. This makes "a resume has been triggered" true for every
// consumer, not just ops/admin users. Only imported by API route handlers.
import { run, query } from './snowflake';
import { logger } from './logger';
import {
  SUSPEND_REASON,
  type SuspendedInfo,
  type RegionTier,
  regionServiceName,
  waitCopyForTier,
  suspendedMessage,
} from './routing-suspend';

// Look up the region's size tier (REGION_ORS_MAP.COMPUTE_SIZE) for the wait
// estimate. Returns null when the region is unknown (message falls back to the
// generic "2 to 5 minutes").
export async function getRegionTier(region: string): Promise<RegionTier | null> {
  try {
    const rows = await query<{ COMPUTE_SIZE?: string }>(
      `SELECT COMPUTE_SIZE FROM OPENROUTESERVICE_APP.CORE.REGION_ORS_MAP
        WHERE UPPER(REGION) = UPPER(?) LIMIT 1`,
      [region],
    );
    const cs = String(rows[0]?.COMPUTE_SIZE ?? '').toUpperCase();
    return cs === 'S' || cs === 'L' || cs === 'XXL' ? (cs as RegionTier) : null;
  } catch (err) {
    logger.warn('routing-resume-tier-lookup-failed', { region, error: String(err) });
    return null;
  }
}

// Best-effort resume of a region's ORS + VROOM services. Idempotent
// (ALTER SERVICE IF EXISTS ... RESUME); per-service failures are swallowed so a
// missing/already-running service never blocks the response.
export async function triggerRegionResume(region: string): Promise<void> {
  const services = [regionServiceName(region, 'ORS'), regionServiceName(region, 'VROOM')];
  for (const svc of services) {
    // Service names cannot be bound; the FQN is built from a sanitized region
    // token ([A-Z0-9_] only), so it is injection-safe.
    try {
      await run(`ALTER SERVICE IF EXISTS ${svc} RESUME`);
      logger.info('routing-resume-triggered', { service: svc, region });
    } catch (err) {
      logger.warn('routing-resume-failed', { service: svc, region, error: String(err) });
    }
  }
}

// Resolve the region to resume: prefer the region parsed from the error's
// service reference, else the caller-supplied region, else the default.
export function resolveResumeRegion(
  detectedRegion: string | undefined,
  fallbackRegion: string | null | undefined,
): string {
  if (detectedRegion && detectedRegion.trim()) return detectedRegion.trim();
  if (fallbackRegion && String(fallbackRegion).trim()) return String(fallbackRegion).trim();
  return 'SanFrancisco';
}

// Trigger the resume and build the typed 503 payload the client renders.
export async function resumeAndBuildPayload(
  region: string,
  kind?: 'ORS' | 'VROOM' | 'GATEWAY',
): Promise<SuspendedInfo> {
  await triggerRegionResume(region);
  const tier = await getRegionTier(region);
  const waitMinutes = waitCopyForTier(tier);
  const service =
    kind === 'VROOM' ? regionServiceName(region, 'VROOM')
    : kind === 'ORS' ? regionServiceName(region, 'ORS')
    : undefined;
  return {
    reason: SUSPEND_REASON,
    region,
    tier,
    waitMinutes,
    service,
    message: suspendedMessage(region, waitMinutes),
  };
}
