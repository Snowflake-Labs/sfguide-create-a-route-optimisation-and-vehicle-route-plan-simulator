import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

// Generic, use-case-agnostic vehicle-routing solve. Wraps TOOL_VRP_SOLVE (a thin
// wrapper over OPTIMIZATION). The caller builds the VROOM challenge client-side
// (backload matching, delivery planning, evacuation, etc.) and passes it as a
// JSON string; this verb names no use case. Returns per-vehicle routes, the
// unassigned list, a summary, and an aggregated route-geometry FeatureCollection.
export const vrp_solve = defineProc({
  name: 'vrp_solve',
  description:
    'Solve a prepared vehicle-routing problem: assign jobs/shipments to vehicles ' +
    'and order them to minimize travel, given a VROOM challenge JSON (vehicles[] + ' +
    'jobs[]/shipments[]). Use-case agnostic - the caller builds the challenge. ' +
    'Use for "solve this routing/optimization plan" when a challenge is already prepared.',
  roles: ['user'],
  args: {
    challenge: t
      .string({ min: 1, max: 900000 })
      .describe('The VROOM optimization challenge as a JSON string (vehicles[] + jobs[]/shipments[]).'),
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Region whose road graph to route on. Defaults to the active region when null.'),
  },
  returns: {
    result: t.object({}).describe('Optimization response: routes[], unassigned[], summary, and route geometry.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.vrpSolve, [args.challenge, args.region]);
    return { result };
  },
});
