import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const compute_isochrone = defineProc({
  name: 'compute_isochrone',
  description:
    'Compute a drive-time (or walk/cycle-time) reachability polygon (isochrone) ' +
    'around a place for a given number of minutes. Use for "what can I reach within N minutes of X".',
  roles: ['user'],
  args: {
    location_description: t
      .string({ min: 1, max: 1000 })
      .describe('The place to compute reachability from (e.g. "the Manchester depot").'),
    range_minutes: t
      .number()
      .describe('Travel-time budget in minutes (e.g. 15).'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile or vehicle type: driving-car / car, driving-hgv / hgv, or ebike (cycling). Defaults to the active vehicle profile when null.'),
  },
  returns: {
    result: t.object({}).describe('Isochrone response: GeoJSON polygon(s) for the reachable area.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.isochrone, [
      args.location_description,
      args.range_minutes,
      args.profile,
    ]);
    return { result };
  },
});
