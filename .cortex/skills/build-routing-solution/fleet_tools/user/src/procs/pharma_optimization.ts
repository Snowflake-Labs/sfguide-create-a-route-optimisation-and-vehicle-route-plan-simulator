import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const pharma_optimization = defineProc({
  name: 'pharma_optimization',
  description:
    'Run the pharmacy supply optimization: plan optimized multi-stop delivery routes ' +
    'across the configured pharmacy network for the active region. Use for "optimize ' +
    'pharmacy deliveries" or "plan the pharma distribution run".',
  roles: ['user'],
  args: {
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile: driving-car, driving-hgv, cycling-regular, or foot-walking. Defaults to the active vehicle profile when null.'),
  },
  returns: {
    result: t.object({}).describe('Optimization response: optimized routes and summary metrics.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.pharmaOptimization, [args.profile]);
    return { result };
  },
});
