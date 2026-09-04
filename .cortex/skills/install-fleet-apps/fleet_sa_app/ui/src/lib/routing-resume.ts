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
  type EngineState,
  regionServiceName,
  sanitizeRegion,
  waitCopyForTier,
  suspendedMessage,
  notProvisionedMessage,
} from './routing-suspend';

// Actual SPCS state of a region's ORS service.
//   SUSPENDED - resume it.
//   RUNNING   - already up; it is warming or overloaded, so do NOT resume.
//   MISSING   - the region has no ORS service at all.
export type RegionServiceState = 'SUSPENDED' | 'RUNNING' | 'MISSING';

// Ask Snowflake what the service is actually doing, instead of inferring it from
// an error string. String matching alone is fragile: the gateway has several
// error codes for "cannot serve this region" (service_unreachable, circuit_open,
// timeout, service_warming_up) and adding one silently reintroduced the bug this
// function exists to prevent. With the host in hand the truth is one query away.
export async function getRegionServiceState(region: string): Promise<RegionServiceState> {
  const svc = `ORS_SERVICE_${sanitizeRegion(region)}`;
  try {
    // SHOW ... LIKE takes the pattern as a string literal, which cannot be
    // bound; the token is sanitized to [A-Z0-9_] so it is injection-safe.
    const rows = await query<{ name?: string; status?: string }>(
      `SHOW SERVICES LIKE '${svc}' IN DATABASE OPENROUTESERVICE_APP`,
    );
    if (!rows.length) return 'MISSING';
    // SHOW output column case varies by driver settings.
    const raw = rows[0] as Record<string, unknown>;
    const status = String(raw.status ?? raw.STATUS ?? '').toUpperCase();
    return status === 'RUNNING' || status === 'READY' ? 'RUNNING' : 'SUSPENDED';
  } catch (err) {
    logger.warn('routing-resume-state-lookup-failed', { region, service: svc, error: String(err) });
    // Unknown state: fall back to the old behavior (attempt a resume). An
    // ALTER ... RESUME on a running service is a harmless no-op.
    return 'SUSPENDED';
  }
}

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
// service reference, else the caller-supplied region. Returns null when neither
// is known.
//
// It deliberately does NOT fall back to a default region. It used to return
// 'SanFrancisco', which meant an error carrying no host token resumed an
// unrelated region and then told the user that region had been resumed - the
// region they were actually looking at stayed suspended. A generic error is
// better than a confidently wrong one.
export function resolveResumeRegion(
  detectedRegion: string | undefined,
  fallbackRegion: string | null | undefined,
): string | null {
  if (detectedRegion && detectedRegion.trim()) return detectedRegion.trim();
  if (fallbackRegion && String(fallbackRegion).trim()) return String(fallbackRegion).trim();
  return null;
}

// Decide what to do from the service's ACTUAL state, then build the typed 503
// payload the client renders. `detectedState` is the hint from the error string;
// the service state overrides it, because only the service state can tell a
// suspended engine from a warming one.
export async function resumeAndBuildPayload(
  region: string,
  kind?: 'ORS' | 'VROOM' | 'GATEWAY',
  detectedState: EngineState = 'suspended',
): Promise<SuspendedInfo> {
  const svcState = await getRegionServiceState(region);
  const tier = await getRegionTier(region);
  const waitMinutes = waitCopyForTier(tier);
  const service =
    kind === 'VROOM' ? regionServiceName(region, 'VROOM')
    : kind === 'ORS' ? regionServiceName(region, 'ORS')
    : undefined;

  if (svcState === 'MISSING') {
    logger.warn('routing-resume-region-not-provisioned', { region });
    return {
      reason: SUSPEND_REASON,
      region,
      tier,
      waitMinutes,
      service,
      state: 'not_provisioned',
      message: notProvisionedMessage(region),
    };
  }

  // Only resume something that is actually down. A RUNNING service that cannot
  // answer is warming up or overloaded; resuming it changes nothing and the
  // "a resume has been triggered" copy would be false.
  const state: EngineState = svcState === 'SUSPENDED' ? 'suspended' : 'not_ready';
  if (state === 'suspended') {
    await triggerRegionResume(region);
  } else {
    logger.info('routing-resume-skipped-service-running', { region, detectedState });
  }

  return {
    reason: SUSPEND_REASON,
    region,
    tier,
    waitMinutes,
    service,
    state,
    message: suspendedMessage(region, waitMinutes, state),
  };
}
