import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const supply_chain = defineProc({
  name: 'supply_chain',
  description:
    'Run the supply-chain routing optimization across the configured network for the ' +
    'active region (idle-asset repositioning / multi-stop distribution). Use for ' +
    '"optimize the supply chain routes" or "plan the distribution network run".',
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
    const result = await callTool(ctx.conn, Procs.supplyChain, [args.profile]);
    return { result };
  },
});
