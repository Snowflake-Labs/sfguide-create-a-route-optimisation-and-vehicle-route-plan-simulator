import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';
import { ROWS_DESCRIPTION, withMapRows, geometryAt } from '../map_rows.js';

export const network_optimization = defineProc({
  name: 'network_optimization',
  description:
    'Run the distribution-network routing optimization across the configured network for the ' +
    'active region (idle-asset repositioning / multi-stop distribution). Use for ' +
    '"optimize the distribution network routes" or "plan the network distribution run".',
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
    const result = await callTool(ctx.conn, Procs.networkOptimization, [args.profile, args.region]);
    return withMapRows(ctx.conn, result, geometryAt('geometry'));
  },
});
