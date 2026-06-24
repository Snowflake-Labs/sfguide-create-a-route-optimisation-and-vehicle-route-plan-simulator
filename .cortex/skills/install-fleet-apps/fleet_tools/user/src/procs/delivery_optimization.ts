import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';
import { resolveProfile } from '../codes.js';

export const delivery_optimization = defineProc({
  name: 'delivery_optimization',
  description:
    'Run the pre-configured fleet delivery optimization: plan optimized multi-stop delivery ' +
    'routes across the configured site network for the active region. Use for "optimize ' +
    'deliveries" or "plan the distribution run".',
  roles: ['user'],
  args: {
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile or vehicle type: driving-car / car, driving-hgv / hgv, or ebike (cycling). Defaults to the active vehicle profile when null.'),
  },
  returns: {
    result: t.object({}).describe('Optimization response: optimized routes and summary metrics.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.deliveryOptimization, [resolveProfile(args.profile)]);
    return { result };
  },
});
