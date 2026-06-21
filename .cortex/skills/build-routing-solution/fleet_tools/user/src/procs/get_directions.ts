import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const get_directions = defineProc({
  name: 'get_directions',
  description:
    'Get a driving/cycling/walking route between two or more named places. ' +
    'Returns route geometry, distance, and duration. Use for "how do I get from A to B".',
  roles: ['user'],
  args: {
    locations_description: t
      .string({ min: 1, max: 1000 })
      .describe('Natural-language list of places to route through, in order (e.g. "from the depot to 10 Downing St then Kings Cross").'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile: driving-car, driving-hgv, cycling-regular, or foot-walking. Defaults to the active vehicle profile when null.'),
  },
  returns: {
    result: t.object({}).describe('Routing service response: route geometry, distance, duration, and any waypoints.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.directions, [
      args.locations_description,
      args.profile,
    ]);
    return { result };
  },
});
