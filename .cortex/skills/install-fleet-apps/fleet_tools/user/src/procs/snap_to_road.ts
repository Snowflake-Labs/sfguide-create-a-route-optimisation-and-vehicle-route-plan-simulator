import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const snap_to_road = defineProc({
  name: 'snap_to_road',
  description:
    'Snap one or more coordinates/places to the nearest routable road edge for a ' +
    'given travel profile, returning the snapped point, the distance moved, and the ' +
    'street name. Use for "snap these points to the nearest road" or "is this location ' +
    'routable / on the road network". This is per-point nearest-edge snapping, NOT ' +
    'trajectory map matching.',
  roles: ['user'],
  args: {
    locations_description: t
      .string({ min: 1, max: 1000 })
      .describe('Natural-language list of coordinates or places to snap (e.g. "37.7749,-122.4194 and the depot").'),
    radius_meters: t
      .number()
      .nullable()
      .describe('Search radius in meters for the nearest edge. Points with no routable edge within this radius come back unsnapped. Defaults to 350 when null.'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile or vehicle type: driving-car / car, driving-hgv / hgv, or ebike (cycling). The routing engine resolves it to an available profile and reports any substitution. Defaults to the active vehicle profile when null.'),
  },
  returns: {
    result: t.object({}).describe('Snap response: per-point input/snapped coordinates, snapped_distance_m, street name, unsnapped_count, and requested/used profile.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.snap, [
      args.locations_description,
      args.radius_meters,
      args.profile,
    ]);
    return { result };
  },
});
