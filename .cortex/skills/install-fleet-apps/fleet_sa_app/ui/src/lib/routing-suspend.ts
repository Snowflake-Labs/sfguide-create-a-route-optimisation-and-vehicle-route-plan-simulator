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

// Typed reason for a request naming coordinates outside the region's road graph.
// Distinct from SUSPEND_REASON on purpose: one is an engine state the app can
// fix by resuming, the other is a payload the app must correct.
export const OUT_OF_GRAPH_REASON = 'ORS_OUT_OF_GRAPH' as const;

export type RegionTier = 'S' | 'L' | 'XXL';
export type RoutingServiceKind = 'ORS' | 'VROOM' | 'GATEWAY';

// Why the engine could not serve the request.
//   'suspended'      - the service is down; a resume is the correct remedy.
//   'not_ready'      - the service is up but cannot answer yet (graph still
//                      loading after a resume, or the call exceeded its timeout
//                      budget). Resuming is a no-op, so the copy must NOT
//                      claim one.
//   'not_provisioned'- the region has no ORS service at all. Neither a resume
//                      nor waiting will help.
//   'starting'       - the service is already coming up (PENDING / RESUMING),
//                      typically from an earlier resume. Issuing another is
//                      pointless and "a resume has been triggered" would claim
//                      an action this request did not take.
// The distinction exists because the honest message differs, and because
// claiming "a resume has been triggered" for a running-but-slow engine sends
// the user off to wait for something that already happened.
export type EngineState = 'suspended' | 'not_ready' | 'not_provisioned' | 'starting';

// Typed payload the API routes return (HTTP 503) and the client renders.
export interface SuspendedInfo {
  reason: typeof SUSPEND_REASON;
  region: string;
  tier: RegionTier | null;
  waitMinutes: string;
  service?: string;
  message: string;
  // Whether a resume was actually issued. Absent on payloads built before this
  // field existed, so treat undefined as 'suspended'.
  state?: EngineState;
}

export interface SuspendDetection {
  suspended: boolean;
  region?: string;
  kind?: RoutingServiceKind;
  // Only meaningful when suspended is true.
  state?: EngineState;
  // True when the request named coordinates the region's road graph does not
  // cover. This is a PAYLOAD defect on a HEALTHY engine, so it deliberately
  // suppresses `suspended` - see OUT_OF_GRAPH_SIGNATURES.
  outOfGraph?: boolean;
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
  /connection_failed/i,
  // The gateway's circuit breaker fails fast without touching ORS. It now
  // reports the code that opened it, but an older gateway image (or a breaker
  // opened by mixed causes) can still emit the bare code, and a region that
  // trips the breaker is unusable either way - so treat it as suspended and let
  // the server's service-state check decide whether to actually resume.
  /circuit_open/i,
];

// Signatures for an engine that is UP but cannot answer yet. Same detection
// path, different remedy and different copy - see EngineState.
// Kept as a named constant because detectOrsSuspended also uses it to attribute
// the failure to the gateway (the text names no host).
const GATEWAY_CONNECT_FAILURE = /could not connect to server/i;
const NOT_READY_SIGNATURES = [
  /service_warming_up/i,
  /graph_loading/i,
  /graphs? (?:are |is )?still (?:building|loading)/i,
  /graph is loading/i,
  // The gateway's per-endpoint timeout. Emitted both when a resumed region is
  // still loading its graph and when a genuinely healthy region is handed a
  // request too large for its budget, which is exactly why this is 'not_ready'
  // rather than 'suspended'.
  //
  // Deliberately NOT a bare /timeout/: that would also match a Snowflake
  // statement timeout on a heavy non-routing query and mislabel it as a routing
  // outage. Match only the two shapes a gateway timeout actually arrives in -
  // the SQL guard's "ORS timeout host=..." raise, and the JSON error field seen
  // by detectSuspendedInResult.
  /\bORS (?:request )?time(?:d)? ?out\b/i,
  /["']error["']\s*:\s*["']timeout["']/i,
  /\btimed out after\b/i,
  // The SAME condition as the timeout above, arriving by a different route: when
  // SPCS ingress cuts the connection it substitutes a PLAIN-TEXT body
  // ('upstream request timeout'), the gateway's r.json() cannot parse it, and it
  // returns this code instead of a JSON timeout. The gateway's own docstring
  // names the cause - "the service ingress timing the request out before ORS
  // answered ... an unroutable or very distant coordinate pair, or reduce the
  // request size" - so classifying it as 'suspended' would tell the user to
  // resume a region that is already running. Same remedy as the timeout, same
  // bucket, for the reason recorded on that entry.
  /non_json_response/i,
  // Raised by SNOWFLAKE, not the gateway, when the routing gateway service is
  // waking from its idle auto-suspend (auto_suspend_secs 3600) and has not
  // started accepting connections. Measured on wgb26798:
  //   100283 "Request failed for external function _ORS_STATUS_RAW. Error:
  //   Could not connect to server" after 3.7 s; the same call 29 s later took
  //   313 ms. The call itself triggers the resume, so the remedy is waiting,
  //   which makes this not_ready rather than suspended. Covered by
  //   MEASURED_PLATFORM_ERRORS in check_suspend_signatures.py. A literal here,
  //   not GATEWAY_CONNECT_FAILURE: that gate reads regex LITERALS from this
  //   array, and it asserts the two stay identical.
  /could not connect to server/i,
];

// Signatures for coordinates the region's road graph does not cover. These are
// a PAYLOAD defect on a perfectly healthy engine, and they are checked BEFORE
// the suspend signatures because the two overlap: the gateway reports an
// out-of-bounds ORS matrix rejection as `matrix_precompute_failed`, which is
// also (correctly) a suspend signature when the cause is an unreachable engine.
//
// Getting the precedence wrong is not cosmetic. A Europe solve that carried 29
// San Francisco coordinates was rejected by the Europe graph in 5 ms with ORS
// 6010; the detector called it a suspended engine, the resume path found the
// service RUNNING and downgraded it to `not_ready`, and the page told the user
// to wait 2 to 5 minutes for an engine that was already up. Retry could never
// clear it, because nothing was starting and the same off-graph points went
// back on every attempt.
const OUT_OF_GRAPH_SIGNATURES = [
  /out of bounds/i,
  // ORS 6010 (matrix) / 2010 (directions): point not on the graph.
  /["']?code["']?\s*:\s*["']?(?:6010|2010)\b/i,
  /could not find routable point/i,
  /point\(s\) \[[^\]]*\] out of bounds/i,
];

// Extract the `lat,lon` pairs ORS lists after "out of bounds:". ORS reports them
// LAT FIRST (the opposite of the [lon,lat] order it accepts as input), so they
// are swapped here rather than passed through - reporting a San Francisco stop
// as 37.57E 122.34S would send someone looking in the wrong hemisphere.
export function parseOutOfGraphPoints(text: string): { lon: number; lat: number }[] {
  const tail = /out of bounds:\s*([^}\n]*)/i.exec(text);
  if (!tail) return [];
  const pts: { lon: number; lat: number }[] = [];
  const re = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail[1])) !== null) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lon, lat });
  }
  return pts;
}

// True when the text describes coordinates outside the region's road graph.
export function isOutOfGraph(text: string | null | undefined): boolean {
  if (!text) return false;
  return OUT_OF_GRAPH_SIGNATURES.some((re) => re.test(text));
}

// User-facing copy for an out-of-graph payload. Names the region and the count,
// and promises NO wait - waiting is exactly the wrong action here.
export function outOfGraphMessage(
  region: string | null | undefined,
  count: number,
  sample: { lon: number; lat: number }[] = [],
): string {
  const where = region ? `the ${region} road graph` : "this region's road graph";
  const n = count > 0 ? `${count} location${count === 1 ? '' : 's'}` : 'One or more locations';
  const coords = sample
    .slice(0, 3)
    .map((p) => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`)
    .join('; ');
  return (
    `${n} in this request ${count === 1 ? 'is' : 'are'} outside ${where}, so the routing ` +
    `engine refused the request. The engine is healthy - waiting will not help. ` +
    `Check that the selected region matches the data being solved` +
    (coords ? ` (for example: ${coords}).` : '.')
  );
}

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
  // An out-of-graph payload wins over everything else: the engine is up and a
  // resume is not the remedy, so claiming an engine state here is a lie that
  // sends the user off to wait for something that will never happen.
  if (isOutOfGraph(text)) return { suspended: false, outOfGraph: true };
  // Check suspended first: a payload naming both (e.g. a breaker opened by a
  // timeout on a since-suspended host) is better treated as the actionable one.
  const suspendedHit = SUSPEND_SIGNATURES.some((re) => re.test(text));
  const notReadyHit = !suspendedHit && NOT_READY_SIGNATURES.some((re) => re.test(text));
  if (!suspendedHit && !notReadyHit) return { suspended: false };
  const ref = extractServiceRef(text);
  // Snowflake's "Could not connect to server" names no host, but every routing
  // function is a service function on the gateway, so that is what failed.
  const kind = ref.kind ?? (GATEWAY_CONNECT_FAILURE.test(text) ? 'GATEWAY' : undefined);
  return {
    suspended: true,
    region: ref.region,
    kind,
    state: suspendedHit ? 'suspended' : 'not_ready',
  };
}

// Detect a suspended condition inside a structured result object (the typed
// proc failure shape, e.g. { status:'FAILED', reason:'OPTIMIZATION_UNAVAILABLE',
// vroom_service, error }). Falls back to scanning the serialized object.
export function detectSuspendedInResult(result: unknown): SuspendDetection {
  let serialized = '';
  try { serialized = JSON.stringify(result) ?? ''; } catch { serialized = ''; }
  // Out-of-graph first, and ahead of the typed OPTIMIZATION_UNAVAILABLE branch:
  // that reason is also raised when the solve was refused for an off-graph
  // point, and treating it as an outage produces the false "engine is starting".
  if (isOutOfGraph(serialized)) return { suspended: false, outOfGraph: true };
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o.reason === 'string' && o.reason.toUpperCase() === 'OPTIMIZATION_UNAVAILABLE') {
      const svc = typeof o.vroom_service === 'string' ? o.vroom_service : '';
      const region = typeof o.region === 'string' ? o.region : undefined;
      const fromSvc = detectOrsSuspended(svc);
      return { suspended: true, region: region || fromSvc.region, kind: 'VROOM', state: 'suspended' };
    }
  }
  return detectOrsSuspended(serialized);
}

// Detect a suspended engine reported INSIDE a successful result set. A live
// view whose ORS wrapper did not raise returns rows whose cell holds the
// gateway's error object, e.g.
//   {"error":"service_unreachable","message":"Cannot connect to ORS (host: ors-service-usnewjersey)..."}
// The query succeeds, the layer compiler drops the geometry, and the panel
// renders blank with no notice. Only cells that ARE an error object are read -
// a JSON object with a top-level "error" key - so an ordinary text column that
// happens to say "timeout" can never trip the notice. Off-graph errors are not
// reported from here: one bad row is not an outage.
const ERROR_CELL_MAX = 20000;
export function detectSuspendedInRows(rows: ReadonlyArray<Record<string, unknown>>): SuspendDetection {
  for (const row of rows) {
    for (const v of Object.values(row)) {
      if (typeof v !== 'string' || v.length > ERROR_CELL_MAX) continue;
      const t = v.trimStart();
      if (!t.startsWith('{') || !t.includes('"error"')) continue;
      let obj: unknown;
      try { obj = JSON.parse(t); } catch { continue; }
      if (!obj || typeof obj !== 'object' || !('error' in (obj as object))) continue;
      const det = detectSuspendedInResult(obj);
      if (det.suspended) return det;
    }
  }
  return { suspended: false };
}

// Actual SPCS state of a region's ORS service.
//   SUSPENDED - resume it (SUSPENDING is folded in: it will be SUSPENDED within
//               a minute, and the notice's auto-retry re-resumes it then).
//   STARTING  - PENDING / RESUMING / STARTING: already coming up, do NOT resume.
//   RUNNING   - already up; it is warming or overloaded, so do NOT resume.
//   MISSING   - the region has no ORS service at all.
export type RegionServiceState = 'SUSPENDED' | 'STARTING' | 'RUNNING' | 'MISSING';

export function classifyServiceStatus(status: string): Exclude<RegionServiceState, 'MISSING'> {
  const s = status.toUpperCase();
  if (s === 'RUNNING' || s === 'READY') return 'RUNNING';
  if (s === 'PENDING' || s === 'RESUMING' || s === 'STARTING') return 'STARTING';
  return 'SUSPENDED';
}

// Auto-retry policy for RoutingSuspendedNotice. A cold engine used to leave the
// panel on a notice until the user found the Retry button; the region is
// usually ready within minutes, so the notice re-checks on its own.
//   - never for 'not_provisioned' (waiting cannot help)
//   - only inside a window from the FIRST notice for the region, sized above the
//     largest tier's cold start ("up to 5 minutes"), then Retry is manual
//   - short delays first (the gateway wakes in ~30 s), longer after
// `firstSeenMs` must survive the notice unmounting on each refetch, so the
// caller keeps it outside component state.
export const AUTO_RETRY_WINDOW_MS = 6 * 60_000;
export function autoRetryDelayMs(
  state: EngineState | undefined,
  firstSeenMs: number,
  nowMs: number,
): number | null {
  if (state === 'not_provisioned') return null;
  const elapsed = nowMs - firstSeenMs;
  if (elapsed >= AUTO_RETRY_WINDOW_MS) return null;
  return elapsed < 60_000 ? 10_000 : 20_000;
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

// The single user-facing sentence shown wherever an unavailable engine is
// detected. `state` keeps the claim truthful: only say a resume was triggered
// when one actually was.
export function suspendedMessage(
  region: string,
  waitCopy: string,
  state: EngineState = 'suspended',
): string {
  if (state === 'not_provisioned') {
    return notProvisionedMessage(region);
  }
  if (state === 'starting') {
    return (
      `The routing engine for ${region} is starting up. ` +
      `It usually takes ${waitCopy} to become ready.`
    );
  }
  if (state === 'not_ready') {
    return (
      `The routing engine for ${region} is running but did not answer in time. ` +
      `It may still be loading its road graph (usually ${waitCopy}) or be busy ` +
      `with other requests. Please try again in a moment.`
    );
  }
  return (
    `The routing engine for ${region} was suspended to save cost. ` +
    `A resume has been triggered and it usually takes ${waitCopy} to become ready. ` +
    `Please try again in a moment.`
  );
}

// Message for a region that has no ORS service at all. Promising a resume here
// is a promise that can never be kept.
export function notProvisionedMessage(region: string): string {
  return (
    `No routing engine is provisioned for ${region}, so live routing is ` +
    `unavailable for this region. Provision it from the admin app (Regions), ` +
    `then reload this view.`
  );
}

// Message for the shared routing gateway waking from its idle auto-suspend while
// the region's engine is up. Naming the engine ("loading its road graph") here
// would send the user to look at the wrong service, and the wait is far shorter.
export function gatewayWakingMessage(region: string): string {
  return (
    `The routing gateway was idle and is waking up (it auto-suspends after an ` +
    `hour without requests). The ${region} routing engine is running. It is ` +
    `usually ready within about 30 seconds. Please try again in a moment.`
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
