// Shared, pure (client + server safe) helpers for detecting a suspended routing
// engine and rendering a consistent "resume was triggered, retry in ~N minutes"
// message across every ORS-dependent surface (view queries, backload solve,
// tool/verb calls).
//
// Background: the ORS/VROOM services auto-suspend to save cost. When a region's
// ORS_SERVICE_<REGION> (or VROOM_SERVICE_<REGION>) is suspended, the Python
// routing gateway's HTTP call to the per-region container fails DNS resolution
// (the SPCS service DNS name stops resolving), producing a raw
// "NameResolutionError ... Failed to resolve 'ors-service-<region>'" /
// "Max retries exceeded" error. Other paths surface a typed
// reason:'OPTIMIZATION_UNAVAILABLE'. This module normalizes all of those into a
// single detectable signal so the UI can show a friendly notice instead of a
// raw connection error, and the server can trigger a resume.

export const SUSPEND_REASON = 'ORS_SUSPENDED' as const;

export type RegionTier = 'S' | 'L' | 'XXL';
export type RoutingServiceKind = 'ORS' | 'VROOM' | 'GATEWAY';

// Typed payload the API routes return (HTTP 503) and the client renders.
export interface SuspendedInfo {
  reason: typeof SUSPEND_REASON;
  region: string;
  tier: RegionTier | null;
  waitMinutes: string;
  service?: string;
  message: string;
}

export interface SuspendDetection {
  suspended: boolean;
  region?: string;
  kind?: RoutingServiceKind;
}

// Normalize a region token to the SPCS service-name suffix form (UPPER, only
// [A-Z0-9_]). Mirrors the derivation used in the ORS provisioning procs.
export function sanitizeRegion(region: string | null | undefined): string {
  return String(region || 'SanFrancisco').toUpperCase().replace(/[^A-Z0-9_]/g, '');
}

// Fully-qualified SPCS service name for a region's ORS or VROOM service.
export function regionServiceName(region: string | null | undefined, kind: 'ORS' | 'VROOM'): string {
  return `OPENROUTESERVICE_APP.CORE.${kind}_SERVICE_${sanitizeRegion(region)}`;
}

// Signatures that indicate a routing service is suspended / unreachable. These
// come from the gateway (DNS/connection failures on a suspended container), the
// typed proc failure reason, and the gateway's matrix pre-compute error.
const SUSPEND_SIGNATURES = [
  /failed to resolve/i,
  /nameresolutionerror/i,
  /max retries exceeded/i,
  /name or service not known/i,
  /matrix pre-?compute failed/i,
  /matrix_precompute_failed/i,
  /service_unreachable/i,
  /OPTIMIZATION_UNAVAILABLE/i,
  /connection refused/i,
];

// Extract the (kind, region) named in a "ors-service-<region>" /
// "vroom-service-<region>" / "routing-gateway-service" host reference.
function extractServiceRef(text: string): { kind?: RoutingServiceKind; region?: string } {
  const gw = /routing-gateway-service/i.test(text);
  const m = /\b(ors|vroom)-service-([a-z0-9_]+)/i.exec(text);
  if (m) {
    return { kind: m[1].toUpperCase() === 'VROOM' ? 'VROOM' : 'ORS', region: m[2] };
  }
  if (gw) return { kind: 'GATEWAY' };
  return {};
}

// Detect a suspended-routing-engine condition from any error string / message.
export function detectOrsSuspended(text: string | null | undefined): SuspendDetection {
  if (!text) return { suspended: false };
  const hit = SUSPEND_SIGNATURES.some((re) => re.test(text));
  if (!hit) return { suspended: false };
  const ref = extractServiceRef(text);
  return { suspended: true, region: ref.region, kind: ref.kind };
}

// Detect a suspended condition inside a structured result object (the typed
// proc failure shape, e.g. { status:'FAILED', reason:'OPTIMIZATION_UNAVAILABLE',
// vroom_service, error }). Falls back to scanning the serialized object.
export function detectSuspendedInResult(result: unknown): SuspendDetection {
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o.reason === 'string' && o.reason.toUpperCase() === 'OPTIMIZATION_UNAVAILABLE') {
      const svc = typeof o.vroom_service === 'string' ? o.vroom_service : '';
      const region = typeof o.region === 'string' ? o.region : undefined;
      const fromSvc = detectOrsSuspended(svc);
      return { suspended: true, region: region || fromSvc.region, kind: 'VROOM' };
    }
  }
  try {
    return detectOrsSuspended(JSON.stringify(result));
  } catch {
    return { suspended: false };
  }
}

// Region-size -> friendly wait estimate. Region tier is REGION_ORS_MAP.COMPUTE_SIZE
// (S / L / XXL). Cold graph load scales with region size, so the estimate does too.
export function waitCopyForTier(tier: RegionTier | null | undefined): string {
  switch (tier) {
    case 'S':
      return 'about 2 minutes';
    case 'L':
      return '3 to 4 minutes';
    case 'XXL':
      return 'up to 5 minutes';
    default:
      return '2 to 5 minutes';
  }
}

// The single user-facing sentence shown wherever a suspended engine is detected.
export function suspendedMessage(region: string, waitCopy: string): string {
  return (
    `The routing engine for ${region} was suspended to save cost. ` +
    `A resume has been triggered and it usually takes ${waitCopy} to become ready. ` +
    `Please try again in a moment.`
  );
}

// True when an API error/response body carries the typed suspended reason.
export function isSuspendedBody(body: unknown): body is SuspendedInfo {
  return (
    !!body &&
    typeof body === 'object' &&
    (body as { reason?: unknown }).reason === SUSPEND_REASON
  );
}

// Thrown by hand-rolled fetchers (the surfaces that do not go through
// useViewData) so a suspended engine propagates as a TYPED error instead of
// being flattened into "HTTP 503". Catch with isRoutingSuspendedError and render
// RoutingSuspendedNotice.
export class RoutingSuspendedError extends Error {
  readonly info: SuspendedInfo;
  constructor(info: SuspendedInfo) {
    super(info.message);
    this.name = 'RoutingSuspendedError';
    this.info = info;
  }
}

export function isRoutingSuspendedError(err: unknown): err is RoutingSuspendedError {
  return err instanceof RoutingSuspendedError;
}

// Standard guard for a hand-rolled fetch: call it on a non-ok response BEFORE
// falling back to body.error, because a suspended payload has no `error` key and
// would otherwise be reported as a bare "HTTP 503".
export function throwIfSuspended(status: number, body: unknown): void {
  if (status === 503 && isSuspendedBody(body)) {
    throw new RoutingSuspendedError(body);
  }
}

// Classify a SYSTEM$GET_SERVICE_STATUS result (as returned by the ops
// service_status verb: { status_json: "<json array>" }). An empty / missing
// array means the service exists but has no running instances (suspended). A
// truly non-existent service makes the ops call THROW, handled by the caller.
export function parseSvcStatus(raw: Record<string, unknown>): 'RUNNING' | 'SUSPENDED' | 'UNKNOWN' {
  const js = raw?.status_json as string | undefined;
  if (js == null || js === '') return 'SUSPENDED';
  try {
    const arr = JSON.parse(js);
    if (Array.isArray(arr)) {
      if (!arr.length) return 'SUSPENDED';
      const statuses = arr.map((i: { status?: string }) => String(i?.status ?? '').toUpperCase());
      if (statuses.every((s) => s === 'RUNNING' || s === 'READY')) return 'RUNNING';
      return 'SUSPENDED'; // PENDING / starting -> keep waiting
    }
  } catch {
    /* fall through */
  }
  return 'UNKNOWN';
}
