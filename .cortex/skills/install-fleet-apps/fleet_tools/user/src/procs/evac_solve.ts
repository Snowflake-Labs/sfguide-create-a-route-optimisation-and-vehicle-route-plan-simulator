import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

// Solve the evacuation VRP. Wraps TOOL_EVAC_SOLVE (a thin wrapper over ORS
// OPTIMIZATION). The multi-depot / multi-trip pickup challenge is built by the
// caller (the wizard expands each van into up to maxTrips virtual vehicles and
// each participant into a pickup:[1] job) and passed as a JSON string. Returns
// the per-vehicle routes, unassigned list, summary, and route geometry.
export const evac_solve = defineProc({
  name: 'evac_solve',
  description:
    'Solve the evacuation vehicle-routing problem for a prepared challenge: ' +
    'assign evacuees (pickup jobs) to vans across multiple care-center depots and ' +
    'order them to minimize travel. Input is the VROOM challenge JSON. Use for ' +
    '"plan the evacuation routes" once participants and vehicles are set.',
  roles: ['user'],
  args: {
    challenge: t
      .string({ min: 1, max: 900000 })
      .describe('The VROOM optimization challenge as a JSON string (vehicles[] + jobs[]).'),
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Region whose road graph to route on. Defaults to the active region when null.'),
  },
  returns: {
    result: t.object({}).describe('Optimization response: routes[], unassigned[], summary, and route geometry.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.evacSolve, [args.challenge, args.region]);
    return { result };
  },
});
