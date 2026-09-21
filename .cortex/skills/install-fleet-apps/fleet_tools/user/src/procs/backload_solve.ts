import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool, persistSolve } from '../helpers.js';

// Internal-first backload matching, solved live. Wraps TOOL_BACKLOAD_SOLVE, which
// is the SINGLE implementation of what the Backload Matching / Backload Proposals
// cockpit does - the app calls the same proc through /api/tool, so a graded answer
// here matches what a dispatcher sees on screen rather than approximating it.
//
// This is deliberately NOT vrp_solve. vrp_solve takes a challenge the caller has
// already built; this verb reads the region's own vehicles and loads, builds the
// challenge per strategy, solves, and grades the result. An agent cannot construct
// a backload challenge from a plain-language request (it needs the eligibility
// view, the match params, the capacity/skill encoding), so routing a "find return
// loads" question to vrp_solve would fail or, worse, silently solve a wrong one.
export const backload_solve = defineProc({
  name: 'backload_solve',
  description:
    'Find return loads (backloads) for a region\'s idle vehicles and grade them. ' +
    'Reads the region\'s idle vehicles and open internal loads + external offers, ' +
    'builds and solves a vehicle-routing problem live on the road graph, and returns ' +
    'one graded proposal per vehicle with empty km, loaded km, margin and per-constraint ' +
    'pass/fail. Internal loads are preferred over external offers. Use for "what can ' +
    'bring these vehicles back loaded", "reduce empty running", "find backloads", ' +
    '"which return loads should we take". When the user names ONE vehicle, pass trailer_id ' +
    '- never max_vehicles=1, which answers about the longest-idle vehicle instead. ' +
    'Read-only: proposes, never books.',
  roles: ['user'],
  args: {
    strategy: t
      .string({ max: 20 })
      .nullable()
      .describe(
        'Optimizer strategy. "ensemble" (default) runs all four and fuses them, reporting ' +
        'how many agreed on each pair - prefer it unless the user asks for one. ' +
        '"baseline" = quick scan, nearest eligible load, no solve (the only strategy that ' +
        'still answers when the routing engine is suspended). "vrp" = one load per vehicle ' +
        'on road distances. "fleet" = fleet-wide 1:1 assignment. "bpmp" = profit-max ' +
        'backhaul, consolidating several loads per vehicle.',
      ),
    // t.number() carries no bounds, so the proc clamps these (1..200 vehicles,
    // 1..1000 loads, 1..200 returned). Stated here so the agent picks sane values
    // rather than discovering the clamp.
    max_vehicles: t
      .number()
      .nullable()
      .describe('Cap on idle vehicles considered, longest-idle first. Default 20, clamped to 200. Raising it multiplies solve time.'),
    max_loads: t
      .number()
      .nullable()
      .describe('Cap on candidate loads considered, internal first. Default 120, clamped to 1000.'),
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Region whose vehicles, loads and road graph to use. Defaults to the active region when null.'),
    limit: t
      .number()
      .nullable()
      .describe('How many rows to return. Default 25, clamped to 200.'),
    granularity: t
      .string({ max: 12 })
      .nullable()
      .describe(
        'Shape of the answer. "vehicle" (default) returns ONE best proposal per vehicle - the ' +
        'dispatcher answer, and what you almost always want. "pair" returns every graded ' +
        '(vehicle, load) pair with its per-dimension scores; it exists for a caller that ranks ' +
        'the pairs itself, so prefer "vehicle" unless the user explicitly asks to compare ' +
        'several candidate loads for the same vehicle.',
      ),
    // The ONLY way to answer a question about a NAMED vehicle. max_vehicles=1 is
    // not a substitute: the feed is ordered by free time, so it returns the
    // longest-idle vehicle in the region and silently answers about a different
    // truck than the one asked about.
    trailer_id: t
      .string({ max: 64 })
      .nullable()
      .describe(
        'Scope the whole solve to ONE named vehicle (e.g. "V-DRI-00033"). PASS THIS whenever ' +
        'the user names a specific vehicle, trailer or truck. It narrows the feed to that ' +
        'vehicle and to the loads it is eligible for, which is both far faster and the only ' +
        'correct way to answer about a named vehicle - do NOT use max_vehicles=1 for this, ' +
        'that returns the longest-idle vehicle instead. Returns reason VEHICLE_NOT_FOUND if ' +
        'the id is not among the region\'s idle vehicles, and NO_FEED if it is idle but has ' +
        'no eligible load. Leave null to plan the whole region. ' +
        // Measured, and it is not a rounding difference: V-DRI-00033 solved alone got
        // 46.4 empty km / $1,432 on DLV-000228, while the same truck inside the
        // 20-vehicle regional plan got 895.2 empty km / $824 on a different load - and
        // DLV-000228 went unassigned fleet-wide. Two different problems, not two
        // answers to one.
        'IMPORTANT, STATE THIS: a single-vehicle result optimises THAT VEHICLE ALONE. The ' +
        'regional plan optimises across the fleet and can hand the same vehicle a worse ' +
        'individual load, so these figures are the best case for this truck in isolation ' +
        'and are OPTIMISTIC versus what it would be assigned in a fleet-wide plan. Say so ' +
        'rather than presenting them as the dispatch decision.',
      ),
    time_budget_s: t
      .number()
      .nullable()
      .describe(
        'Ceiling on the time spent CALLING THE OPTIMIZER, in seconds. Default 90, clamped ' +
        '15..600. It is checked before each strategy and before each engine attempt, so a ' +
        'run that overruns returns whatever finished with degraded set instead of running ' +
        'on. It does NOT bound the feed reads and the great-circle baseline scan that ' +
        'precede the first engine call, so total elapsed_s can exceed it at large ' +
        'max_vehicles/max_loads - compare elapsed_s against it rather than assuming. ' +
        'Raise it only for a deliberately large batch; for a faster answer prefer ' +
        'trailer_id or a single strategy over lowering it.',
      ),
  },
  returns: {
    result: t.object({}).describe(
      'On success: { status:"SUCCESS", region, vehicle_type, strategy, strategies_run, ' +
      'counts, totals, weights, proposals[], solve_key, families_skipped[], degraded }. ' +
      'On failure: { status:"FAILED", ' +
      'reason, error } where reason is OPTIMIZATION_UNAVAILABLE (routing suspended - resume ' +
      'and retry), NO_FEED (no vehicles or loads for the region), VEHICLE_NOT_FOUND (trailer_id ' +
      'names no idle vehicle in the region - report the id, do not retry region-wide and ' +
      'present another vehicle), TIME_BUDGET_EXCEEDED (nothing solved inside time_budget_s - ' +
      'say so and suggest trailer_id or a single strategy), DATA_NOT_PROVISIONED, or ' +
      'BAD_STRATEGY. solve_key identifies this stored result: pass it to show_view as ' +
      'selection="solve_key=<key>" to put THIS plan on screen instead of making the page ' +
      'solve again. It is absent when the result could not be cached, in which case just open ' +
      'the view without it. ' +
      // strategies_run is the honest record of what actually solved, and it is NOT the
      // strategy that was asked for: only 'vrp', 'fleet' and 'bpmp' touch the road graph,
      // while 'baseline' is a great-circle scan. An "ensemble" run whose three road
      // strategies all failed used to come back as a plain SUCCESS with no signal at all,
      // so the agent presented straight-line estimates as a live road solve.
      'READ degraded BEFORE PRESENTING: it is non-null whenever a strategy you asked for ' +
      'produced nothing, and families_skipped names each one with the engine error that ' +
      'stopped it. If degraded says no road-graph strategy produced a plan, the numbers are ' +
      'GREAT-CIRCLE estimates from the baseline scan and you MUST say so rather than ' +
      'describing them as solved on the road network. Cross-check strategies_run against ' +
      'the strategy you requested; a status of SUCCESS does not mean the run was complete.',
    ),
  },
  execute: async (args, ctx) => {
    const params = {
      strategy: args.strategy,
      max_vehicles: args.max_vehicles,
      max_loads: args.max_loads,
      region: args.region,
      limit: args.limit,
      granularity: args.granularity,
      trailer_id: args.trailer_id,
      time_budget_s: args.time_budget_s,
    };
    const result = await callTool(ctx.conn, Procs.backloadSolve, [
      args.strategy,
      args.max_vehicles,
      args.max_loads,
      args.region,
      args.limit,
      args.granularity,
      args.trailer_id,
      args.time_budget_s,
    ]);
    // Cache successful solves so the app can REDRAW this exact plan rather than
    // running a second, different one. Only on success: caching a failure would
    // hand the agent a key that resolves to an error page.
    if (String(result.status ?? '') === 'SUCCESS') {
      const key = await persistSolve(ctx.conn, 'backload_solve', params, result);
      if (key) result.solve_key = key;
    }
    return { result };
  },
});
