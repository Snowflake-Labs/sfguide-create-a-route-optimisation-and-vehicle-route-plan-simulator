import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const map_match = defineProc({
  name: 'map_match',
  description:
    'Map-match a noisy GPS trajectory (an ordered list of points/places) to the road ' +
    'network and return the matched road segments as GeoJSON. Use for "snap this GPS ' +
    'track to the roads it drove on" or "reconstruct the road-following path for these ' +
    'points". This is trajectory map matching (HMM), unlike snap_to_road which snaps ' +
    'individual points to the nearest edge.',
  roles: ['user'],
  args: {
    locations_description: t
      .string({ min: 1, max: 2000 })
      .describe('Ordered trajectory: a natural-language list of points/coordinates in travel order (e.g. "37.77,-122.42 then 37.78,-122.41 then 37.79,-122.40").'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile or vehicle type: driving-car / car, driving-hgv / hgv, or ebike (cycling). The routing engine resolves it to an available profile and reports any substitution. Defaults to the active vehicle profile when null.'),
  },
  returns: {
    result: t.object({}).describe('Map-matching response: matched_geometry (GeoJSON of the road segments), matched_edges count, raw edge_ids, and requested/used profile.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.match, [
      args.locations_description,
      args.profile,
    ]);
    return { result };
  },
});
