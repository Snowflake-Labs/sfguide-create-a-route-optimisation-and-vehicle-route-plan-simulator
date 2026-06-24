import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';
import { RoutingCodes, SUPPORTED_PROFILES, resolveProfile } from '../codes.js';

export const optimize_routes = defineProc({
  name: 'optimize_routes',
  description:
    'Solve a multi-stop vehicle routing problem: assign delivery stops to vehicles ' +
    'and order them to minimize travel from a depot. Use for "plan routes for these stops". ' +
    'Fails with INVALID_VEHICLE_COUNT, UNSUPPORTED_PROFILE, or REGION_NOT_PROVISIONED ' +
    'when given a non-positive vehicle count, an unknown routing profile, or a region ' +
    'that has not been provisioned.',
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
      .describe('Routing profile or vehicle type: driving-car / car, driving-hgv / hgv, or ebike (cycling). Defaults to the active vehicle profile when null.'),
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Region whose road graph to use. Defaults to the active region when null.'),
  },
  returns: {
    result: t.object({}).describe('Optimization response: per-vehicle ordered stop sequence, route geometry, and totals.'),
  },
  validate: async (args, ctx) => {
    // 1. Vehicle count must be a positive integer (zero-SQL guard).
    if (!Number.isFinite(args.num_vehicles) || args.num_vehicles < 1 || !Number.isInteger(args.num_vehicles)) {
      ctx.fail(
        RoutingCodes.INVALID_VEHICLE_COUNT,
        `num_vehicles must be a positive whole number; got ${args.num_vehicles}.`,
      );
    }
    // 2. Profile, when supplied, must resolve to a built ORS profile (zero-SQL
    //    guard). resolveProfile maps vehicle types / cycling variants (ebike,
    //    cycling-regular) to the built cycling-electric; only a genuinely unknown
    //    value fails here.
    const resolved = resolveProfile(args.profile);
    if (resolved != null && !SUPPORTED_PROFILES.includes(resolved as (typeof SUPPORTED_PROFILES)[number])) {
      ctx.fail(
        RoutingCodes.UNSUPPORTED_PROFILE,
        `profile '${args.profile}' is not supported. Use one of: ${SUPPORTED_PROFILES.join(', ')}, a vehicle type (car, hgv, ebike), or null for the active vehicle profile.`,
      );
    }
    // 3. Region, when supplied, must be a provisioned region. Checked through the
    //    routing contract (Tenet 1) — never by reading the engine schema directly.
    //    REGION_EXISTS returns TRUE for null/empty, so a null region passes here
    //    and is resolved to the active region downstream.
    if (args.region != null && args.region.trim() !== '') {
      const ok = await ctx.conn.execScalar<boolean>(
        'SELECT ROUTING_PLATFORM.CONTRACT.REGION_EXISTS(?)',
        [args.region],
      );
      if (!ok) {
        ctx.fail(
          RoutingCodes.REGION_NOT_PROVISIONED,
          `region '${args.region}' is not a provisioned routing region.`,
        );
      }
    }
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.optimization, [
      args.delivery_locations,
      args.depot_location,
      args.num_vehicles,
      resolveProfile(args.profile),
      args.region,
    ]);
    return { result };
  },
});
