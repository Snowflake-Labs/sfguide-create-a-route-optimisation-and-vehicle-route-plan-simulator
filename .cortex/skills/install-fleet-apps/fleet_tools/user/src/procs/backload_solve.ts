import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

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
    '"which return loads should we take". Read-only: proposes, never books.',
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
  },
  returns: {
    result: t.object({}).describe(
      'On success: { status:"SUCCESS", region, vehicle_type, strategy, strategies_run, ' +
      'counts, totals, weights, proposals[] }. On failure: { status:"FAILED", reason, error } ' +
      'where reason is OPTIMIZATION_UNAVAILABLE (routing suspended - resume and retry), ' +
      'NO_FEED (no vehicles or loads for the region), DATA_NOT_PROVISIONED, or BAD_STRATEGY.',
    ),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.backloadSolve, [
      args.strategy,
      args.max_vehicles,
      args.max_loads,
      args.region,
      args.limit,
      args.granularity,
    ]);
    return { result };
  },
});
