import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const get_directions = defineProc({
  name: 'get_directions',
  description:
    'Get a driving/cycling/walking route between two or more named places. ' +
    'Returns route geometry, distance, and duration. Use for "how do I get from A to B". ' +
    'The routing region is resolved from the places themselves: an intercity or ' +
    'cross-state route resolves to the country graph rather than a city graph, so ' +
    'name the country when a city name is ambiguous. Every place must sit in ONE ' +
    'provisioned region - a pair spanning two unrelated regions fails with ' +
    'NO_COVERING_REGION, and a pair with no road path between them (separated by ' +
    'water, or on a disconnected part of the network) fails with UNROUTABLE_LEG. ' +
    'A place that is not on the road graph at all - an island, a lake, a point in ' +
    'open water - fails with OFF_GRAPH_PLACE and reports how far it sits from the ' +
    'nearest road; answer that by naming a street address nearby, not by retrying. ' +
    'All three are refusals to report, not conditions to retry.',
  roles: ['user'],
  args: {
    locations_description: t
      .string({ min: 1, max: 1000 })
      .describe('Natural-language list of places to route through, in order (e.g. "from the depot to 10 Downing St then Kings Cross").'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile or vehicle type: driving-car / car, driving-hgv / hgv, or ebike (cycling). The routing engine resolves it to a profile actually built in the resolved region and reports any substitution in profile_note - a region may only carry one travel mode. Defaults to the active vehicle profile when null.'),
    region: t
      .string({ max: 120 })
      .nullable()
      .describe('Optional routing region to force (e.g. UnitedStatesOfAmerica). Leave null in almost every case: the region is resolved from the geocoded places, and forcing one that does not cover them fails. Only set it to disambiguate between nested provisioned regions.'),
  },
  returns: {
    result: t.object({}).describe('Routing service response: route geometry, distance, duration, the region and profile actually used, a profile_note when substituted, and an error_code when refused.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.directions, [
      args.locations_description,
      args.profile,
      args.region,
    ]);
    return { result };
  },
});
