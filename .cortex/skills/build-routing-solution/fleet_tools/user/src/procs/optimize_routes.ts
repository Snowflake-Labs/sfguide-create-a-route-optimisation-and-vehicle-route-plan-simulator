import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const optimize_routes = defineProc({
  name: 'optimize_routes',
  description:
    'Solve a multi-stop vehicle routing problem: assign delivery stops to vehicles ' +
    'and order them to minimize travel from a depot. Use for "plan routes for these stops".',
  roles: ['user'],
  args: {
    delivery_locations: t
      .string({ min: 1, max: 4000 })
      .describe('The delivery stops as a natural-language or delimited list of addresses/places.'),
    depot_location: t
      .string({ min: 1, max: 1000 })
      .describe('The depot / start-and-end location for the vehicles.'),
    num_vehicles: t
      .number()
      .describe('How many vehicles are available.'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile: driving-car, driving-hgv, cycling-regular, or foot-walking. Defaults to the active vehicle profile when null.'),
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Region whose road graph to use. Defaults to the active region when null.'),
  },
  returns: {
    result: t.object({}).describe('Optimization response: per-vehicle ordered stop sequence, route geometry, and totals.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.optimization, [
      args.delivery_locations,
      args.depot_location,
      args.num_vehicles,
      args.profile,
      args.region,
    ]);
    return { result };
  },
});
