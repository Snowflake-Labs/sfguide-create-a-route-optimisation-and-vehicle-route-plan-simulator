import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';

export const find_poi = defineProc({
  name: 'find_poi',
  description:
    'Find points of interest of a category (e.g. fuel, parking, supermarket) within ' +
    'a drive-time isochrone around a place. Use for "find fuel stops within 10 min of X".',
  roles: ['user'],
  args: {
    location_description: t
      .string({ min: 1, max: 1000 })
      .describe('The place to search around.'),
    range_minutes: t
      .number()
      .describe('Travel-time budget in minutes defining the search area.'),
    poi_category: t
      .string({ min: 1, max: 80 })
      .describe('Category of POI to find (e.g. "fuel", "parking", "supermarket").'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe('Routing profile: driving-car, driving-hgv, cycling-regular, or foot-walking. Defaults to the active vehicle profile when null.'),
    max_results: t
      .number()
      .nullable()
      .describe('Maximum number of POIs to return. Defaults to a service-side limit when null.'),
  },
  returns: {
    result: t.object({}).describe('POI search response: matching places with coordinates and attributes.'),
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.poiInIsochrone, [
      args.location_description,
      args.range_minutes,
      args.poi_category,
      args.profile,
      args.max_results,
    ]);
    return { result };
  },
});
