import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const pharma_catchment = defineProc({
  name: 'pharma_catchment',
  description:
    'Estimate the drive-time catchment area and reachable population/demand around a ' +
    'pharmacy (or similar site). Use for "what is the catchment of this pharmacy".',
  roles: ['user'],
  args: {
    pharmacy_description: t
      .string({ min: 1, max: 1000 })
      .describe('The pharmacy or site to analyze (name or address).'),
    range_minutes: t
      .number()
      .describe('Drive-time budget in minutes defining the catchment.'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile: driving-car, driving-hgv, cycling-regular, or foot-walking. Defaults to the active vehicle profile when null.'),
  },
  returns: {
    result: t.object({}).describe('Catchment response: catchment polygon and reachable metrics.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.pharmaCatchment, [
      args.pharmacy_description,
      args.range_minutes,
      args.profile,
    ]);
    return { result };
  },
});
