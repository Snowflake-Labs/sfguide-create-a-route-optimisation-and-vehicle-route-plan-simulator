import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';
import { ROWS_DESCRIPTION, withMapRows, geometryAt } from '../map_rows.js';

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
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Region whose site network and road graph to use. Pass the active region; defaults to it when omitted.'),
  },
  returns: {
    result: t.object({}).describe('Optimization response: optimized routes and summary metrics.'),
    rows: t.array(t.object({})).nullable().describe(ROWS_DESCRIPTION),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.deliveryOptimization, [args.profile, args.region]);
    return withMapRows(ctx.conn, result, geometryAt('geometry'));
  },
});
