// Rehydrate a backload plan the AGENT solved, instead of solving it again.
//
// WHY THIS EXISTS
// ---------------
// An agent can run `backload_solve` and describe the result accurately, but
// until now it had no way to put that result on screen. The only navigation it
// had was "open the Backload page", and the page then solved from scratch: a
// second job of 38 to 168 seconds whose numbers can legitimately differ from the
// ones just quoted in chat. Two answers to one question is worse than one slow
// answer, so the verb now caches its result and hands back a `solve_key`, and
// this module collects it.
//
// WHY THE PROPOSALS, AND NOT THE RAW OPTIMIZER RESPONSE
// ----------------------------------------------------
// The obvious route is to persist the optimizer's own response and replay the
// page's existing parsing. It is a trap. That parser resolves `route.vehicle`
// and `step.id` through `trailerById` / `offerById`, which are maps of integer
// ids the PAGE minted when it built its own challenge - array positions, in
// effect. The procedure mints its own ids over its own selection, so replaying
// its response through the page's maps attaches each tour to whatever vehicle
// happens to sit at that index. Nothing throws, every field is present, and the
// plan renders beautifully for the wrong trailers.
//
// The graded proposals carry TRAILER_ID and LOAD_ID - business keys, resolved by
// the procedure while it still had the mapping. Matching on those cannot
// mis-attribute a tour. It also means every strategy is redrawable, including
// `ensemble` (which fuses four solves and therefore has no single raw response)
// and `baseline` (which never solves at all).
//
// DISTANCES ARE GREAT-CIRCLE UNTIL ENRICHED
// The procedure reports haversine km. The page's own solve upgrades those to
// real road distances with a later DIRECTIONS pass, and that pass runs over
// rehydrated assignments too - so the figures converge on the road numbers a
// moment after the plan appears, rather than silently staying straight-line.

/** One row of `proposals` from TOOL_BACKLOAD_SOLVE at vehicle granularity. */
export interface AgentProposal {
  vehicle_id: string;
  load_id: string;
  grade?: string;
  composite?: number;
  best_strategy?: string;
  strategies_agreeing?: number;
  is_internal?: boolean;
  source?: string;
  empty_km?: number | null;
  loaded_km?: number | null;
  detour_km?: number | null;
  margin_usd?: number | null;
  stops?: number | null;
  empty_city?: string | null;
  pickup_city?: string | null;
  delivery_city?: string | null;
  pickup_lon?: number | null;
  pickup_lat?: number | null;
  delivery_lon?: number | null;
  delivery_lat?: number | null;
}

export interface AgentSolve {
  status?: string;
  region?: string;
  strategy?: string;
  strategies_run?: string[];
  proposals?: AgentProposal[];
  pairs?: unknown[];
  totals?: Record<string, unknown>;
  counts?: Record<string, unknown>;
  note?: string | null;
}

export type CollectOutcome =
  | { state: 'ok'; solve: AgentSolve }
  | { state: 'pending' }
  | { state: 'expired' }
  | { state: 'failed'; error: string };

/**
 * Collect a cached solve by key.
 *
 * Every documented response of /api/solve-status is handled distinctly, because
 * they demand different behaviour from the caller and conflating them produces
 * the two worst outcomes: polling a key that will never exist, or reporting a
 * live solve as broken.
 *   200 -> the result           202 -> still running, poll again
 *   404 -> unknown key (expired or never written): STOP, do not poll
 *   502 -> the solve itself failed; show its error
 */
export async function collectAgentSolve(key: string, signal?: AbortSignal): Promise<CollectOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/solve-status?key=${encodeURIComponent(key)}`, { signal });
  } catch (e) {
    return { state: 'failed', error: (e as Error)?.message || 'could not reach the solve store' };
  }
  if (res.status === 202) return { state: 'pending' };
  if (res.status === 404) return { state: 'expired' };
  let body: { result?: unknown; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { state: 'failed', error: 'malformed response from the solve store' };
  }
  if (!res.ok) return { state: 'failed', error: body.error || `solve store returned ${res.status}` };

  // The verb's payload is stored in the rows shape and unwrapped server-side, so
  // `result` is the procedure's own object. It nests one level when the row came
  // from the verb envelope.
  const raw = body.result as Record<string, unknown> | undefined;
  const solve = (raw?.result ?? raw) as AgentSolve | undefined;
  if (!solve || typeof solve !== 'object') {
    return { state: 'failed', error: 'the cached solve held no result' };
  }
  return { state: 'ok', solve };
}

/** Minimal shape this module needs from whatever the page calls a vehicle. */
export interface RehydrateVehicle {
  TRAILER_ID: string;
  DROPOFF_CITY?: string;
  DROPOFF_LON?: number | string;
  DROPOFF_LAT?: number | string;
  HOME_LON?: number | string;
  HOME_LAT?: number | string;
}

export interface RehydratedAssignment {
  ASSIGNMENT_ID: string;
  TRAILER_ID: string;
  OFFER_ID: string;
  SOURCE: string;
  /** Authoritative internal/external flag. See resolveChannel below. */
  IS_INTERNAL: boolean;
  PICKUP_LON: number;
  PICKUP_LAT: number;
  DROPOFF_LON: number;
  DROPOFF_LAT: number;
  EMPTY_KM: number;
  LOADED_KM: number;
  SCORE: number;
  DETOUR_KM?: number;
  PRODUCT: string;
  PICKUP_CITY: string;
  PROPOSAL_DROPOFF_CITY: string;
  HOME_LON: number;
  HOME_LAT: number;
  TRAILER_DROPOFF_LON: number;
  TRAILER_DROPOFF_LAT: number;
  END_LON?: number;
  END_LAT?: number;
  LAST_TASK_LON?: number;
  LAST_TASK_LAT?: number;
  STOPS: {
    kind: string;
    label: string;
    city?: string;
    lon: number;
    lat: number;
    offerId?: string;
    source?: string;
  }[];
  N_DELIVERIES?: number;
  NET_BENEFIT_USD?: number;
  /** Marks a plan collected from a prior solve rather than solved on this page. */
  REHYDRATED?: boolean;
}

const n = (v: unknown): number => Number(v);
const finite = (v: unknown): boolean => Number.isFinite(Number(v));

/**
 * Resolve the internal/external channel from a proposal.
 *
 * `is_internal` is the ONLY authoritative field, and `source` is a channel label
 * that has carried the literal word INTERNAL on external offers - measured 75 of
 * 300 rows still live in VW_LOADS, because the generator that produced them
 * round-robined 'INTERNAL' through a list of external channel names. The
 * generator has since been fixed, but that does not retire the rows already
 * generated.
 *
 * So a label of INTERNAL on a row whose flag says external is not ambiguous, it
 * is untrue: the load arrived from an external exchange. Deriving the badge from
 * `source` (`is_internal ? 'INTERNAL' : source`) reproduced the untruth on the
 * assignment card, in the stops list, and in the agent memo - and because
 * `internalCount` in the page counts IS_INTERNAL while the badge showed SOURCE, a
 * single plan could display INTERNAL and report 0 internal matches at once.
 */
export function resolveChannel(
  isInternal: unknown, source: unknown,
): { internal: boolean; label: string } {
  const internal = isInternal === true;
  const raw = String(source ?? '').trim();
  if (internal) return { internal: true, label: 'INTERNAL' };
  // Never echo an INTERNAL label back out for a row the flag calls external.
  if (!raw || raw.toUpperCase() === 'INTERNAL') return { internal: false, label: 'EXTERNAL' };
  return { internal: false, label: raw };
}

/**
 * Convert graded proposals into the page's assignment shape.
 *
 * A proposal whose vehicle is not in the page's current pool is DROPPED, not
 * faked: the pool depends on the region and the payload sliders, so a plan
 * solved over a wider pool can legitimately reference a vehicle that is not on
 * screen. Reporting the count of dropped rows is the honest alternative to
 * rendering a tour with an invented start point.
 */
export function proposalsToAssignments(
  proposals: AgentProposal[],
  vehicles: RehydrateVehicle[],
): { assignments: RehydratedAssignment[]; skipped: number } {
  const byId = new Map<string, RehydrateVehicle>();
  for (const v of vehicles) byId.set(String(v.TRAILER_ID), v);

  const out: RehydratedAssignment[] = [];
  let skipped = 0;

  for (const p of proposals) {
    const v = byId.get(String(p.vehicle_id));
    if (!v) { skipped += 1; continue; }
    if (!finite(p.pickup_lon) || !finite(p.pickup_lat)) { skipped += 1; continue; }

    const idleLon = n(v.DROPOFF_LON);
    const idleLat = n(v.DROPOFF_LAT);
    const pickLon = n(p.pickup_lon);
    const pickLat = n(p.pickup_lat);
    const dropLon = finite(p.delivery_lon) ? n(p.delivery_lon) : pickLon;
    const dropLat = finite(p.delivery_lat) ? n(p.delivery_lat) : pickLat;
    const channel = resolveChannel(p.is_internal, p.source);
    const source = channel.label;

    out.push({
      ASSIGNMENT_ID: `${p.vehicle_id}-${p.load_id}`,
      TRAILER_ID: String(p.vehicle_id),
      OFFER_ID: String(p.load_id),
      SOURCE: source,
      IS_INTERNAL: channel.internal,
      PICKUP_LON: pickLon,
      PICKUP_LAT: pickLat,
      DROPOFF_LON: dropLon,
      DROPOFF_LAT: dropLat,
      EMPTY_KM: finite(p.empty_km) ? n(p.empty_km) : 0,
      LOADED_KM: finite(p.loaded_km) ? n(p.loaded_km) : 0,
      // The page sorts and labels by SCORE. The procedure's composite grade is
      // the closest honest equivalent it has.
      SCORE: finite(p.composite) ? n(p.composite) : 0,
      ...(finite(p.detour_km) ? { DETOUR_KM: n(p.detour_km) } : {}),
      PRODUCT: '',
      PICKUP_CITY: String(p.pickup_city ?? ''),
      PROPOSAL_DROPOFF_CITY: String(p.delivery_city ?? ''),
      HOME_LON: finite(v.HOME_LON) ? n(v.HOME_LON) : idleLon,
      HOME_LAT: finite(v.HOME_LAT) ? n(v.HOME_LAT) : idleLat,
      TRAILER_DROPOFF_LON: idleLon,
      TRAILER_DROPOFF_LAT: idleLat,
      END_LON: finite(v.HOME_LON) ? n(v.HOME_LON) : undefined,
      END_LAT: finite(v.HOME_LAT) ? n(v.HOME_LAT) : undefined,
      LAST_TASK_LON: dropLon,
      LAST_TASK_LAT: dropLat,
      STOPS: [
        {
          kind: 'start',
          label: 'Vehicle idle location',
          city: String(p.empty_city ?? v.DROPOFF_CITY ?? ''),
          lon: idleLon,
          lat: idleLat,
        },
        {
          kind: 'pickup',
          label: `${source} ${p.load_id}`,
          city: String(p.pickup_city ?? ''),
          lon: pickLon,
          lat: pickLat,
          offerId: String(p.load_id),
          source,
        },
        {
          kind: 'dropoff',
          label: `${source} ${p.load_id}`,
          city: String(p.delivery_city ?? ''),
          lon: dropLon,
          lat: dropLat,
          offerId: String(p.load_id),
          source,
        },
      ],
      N_DELIVERIES: 1,
      ...(finite(p.margin_usd) ? { NET_BENEFIT_USD: n(p.margin_usd) } : {}),
      REHYDRATED: true,
    });
  }

  return { assignments: out, skipped };
}
