import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const catchment = defineProc({
  name: 'catchment',
  description:
    'Estimate the drive-time catchment area and reachable population/demand around a ' +
    'site (store, depot, facility, or similar). Use for "what is the catchment of this site".',
  roles: ['user'],
  args: {
    site_description: t
      .string({ min: 1, max: 1000 })
      .describe('The site to analyze (name or address).'),
    range_minutes: t
      .number()
      .describe('Drive-time budget in minutes defining the catchment.'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile or vehicle type: driving-car / car, driving-hgv / hgv, or ebike (cycling). Defaults to the active vehicle profile when null.'),
  },
  returns: {
    result: t.object({}).describe('Catchment response: catchment polygon and reachable metrics.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.catchment, [
      args.site_description,
      args.range_minutes,
      args.profile,
    ]);
    return { result };
  },
});
