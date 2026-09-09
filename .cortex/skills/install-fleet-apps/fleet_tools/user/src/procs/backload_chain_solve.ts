import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

// Two-hop (chained) return planning. Wraps TOOL_BACKLOAD_CHAIN_SOLVE, the same
// computation the Triangle Proposals cockpit runs, so app and agent share one
// implementation.
//
// This exists because backload_solve structurally cannot answer the long-haul
// case: when NO single load brings a vehicle back, a one-hop matcher returns
// nothing, which reads as "there is no return" rather than "there is no SINGLE
// return". A chain carries load A part of the way and load B the rest.
export const backload_chain_solve = defineProc({
  name: 'backload_chain_solve',
  description:
    'Plan a TWO-HOP chained return for vehicles that no single load can bring back. ' +
    'Enumerates chains (carry one load part of the way, a second the rest), prices every ' +
    'leg live on the road network with one matrix call, grades them, and applies an ' +
    'internal-first cascade that stops at the lowest rung with an acceptable chain. Each ' +
    'chain is reported against the status quo of running home empty. Use for "no load ' +
    'brings this vehicle back", "two-hop / chained / triangle return", "multi-leg ' +
    'backhaul", or when backload_solve found nothing for a long-haul region. Chains are a ' +
    'LONG-HAUL pattern: a metro region legitimately has none, because every load already ' +
    'delivers inside the target radius. Read-only: proposes, never books.',
  roles: ['user'],
  args: {
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Region whose vehicles, loads and road graph to use. Defaults to the active region when null.'),
    cost_basis: t
      .string({ max: 20 })
      .nullable()
      .describe(
        '"road" (default) prices every leg live on the road network and is required for grades ' +
        'and for the internal-first cascade. "great_circle" skips the routing call and returns ' +
        'UNGRADED straight-line skeletons - use it only when the routing engine is unavailable, ' +
        'and say the figures are estimates.',
      ),
    acceptance_score: t
      .number()
      .nullable()
      .describe(
        'Pass mark 0-100 for the cascade, which stops at the lowest rung holding an eligible ' +
        'chain at or above it. Defaults to CASCADE_GRADE_THRESHOLD. Counter-intuitive and worth ' +
        'stating when reporting: if NO rung clears the mark the cascade cut is not applied at ' +
        'all, so a HIGHER score can return MORE chains.',
      ),
    max_per_vehicle: t
      .number()
      .nullable()
      .describe('Chains kept per vehicle, best first. Defaults to MAX_TRIANGLES_PER_TRAILER, clamped to 20.'),
    limit: t
      .number()
      .nullable()
      .describe('How many chains to return. Default 25, clamped to 200.'),
  },
  returns: {
    result: t.object({}).describe(
      'On success: { status:"SUCCESS", region, cost_basis, acceptance_score, cascade:{rung_reached,' +
      'label,note}, counts, totals, economics, envelope, chains[] }. Each chain carries hop1/hop2, ' +
      'empty_km (residual-inclusive, comparable with baseline_empty_km), two_leg_empty_km (the ' +
      'subtotal the constraint checks use - never compare THAT with the baseline), empty_saved_km, ' +
      'net_usd vs baseline_net_usd, beats_baseline, and per-constraint verdicts. A region with no ' +
      'chains returns SUCCESS with an explanatory note, not an error. On failure: ' +
      '{ status:"FAILED", reason } where reason is OPTIMIZATION_UNAVAILABLE, DATA_NOT_PROVISIONED, ' +
      'or BAD_COST_BASIS.',
    ),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.backloadChainSolve, [
      args.region,
      args.cost_basis,
      args.acceptance_score,
      args.max_per_vehicle,
      args.limit,
    ]);
    return { result };
  },
});
