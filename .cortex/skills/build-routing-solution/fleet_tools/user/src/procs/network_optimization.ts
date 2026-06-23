import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

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
      .describe('Routing profile: driving-car, driving-hgv, cycling-regular, or foot-walking. Defaults to the active vehicle profile when null.'),
  },
  returns: {
    result: t.object({}).describe('Optimization response: optimized routes and summary metrics.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.networkOptimization, [args.profile]);
    return { result };
  },
});
