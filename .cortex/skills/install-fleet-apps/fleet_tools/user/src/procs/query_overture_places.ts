import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';
import { OvertureCodes, OVERTURE_PLACES_GROUP_BY } from '../codes.js';

/**
 * Region-wide (NON-isochrone) Overture Maps Places search. Complements `find_poi`
 * (which is drive-time bound): this verb answers "how many / list / which cities"
 * questions across a whole region or an explicit bbox, with cost-safe bounding
 * enforced by the underlying TOOL_OVERTURE_SEARCH proc (bbox prune +
 * ST_WITHIN(BOUNDARY) refine + hard LIMIT capped at 500).
 */
export const query_overture_places = defineProc({
  name: 'query_overture_places',
  description:
    'Search or aggregate Overture Maps points of interest across a whole region (or an ' +
    'explicit bounding box) WITHOUT a drive-time isochrone. Use for region-wide questions ' +
    'like "how many hospitals are in this region", "top 10 cities by coffee shop count", or ' +
    '"list supermarkets in the area". Bound the search with a provisioned region name OR a ' +
    'full bbox (min/max lon/lat). group_by="list" returns individual places; "city" returns ' +
    'counts per city; "category" returns counts per category. For "POIs within N minutes of a ' +
    'point" use find_poi instead.',
  roles: ['user'],
  args: {
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Provisioned region name (e.g. "SanFrancisco"). Resolves the boundary polygon. Pass the active region by default unless the user names a different place; provide this OR a full bbox.'),
    poi_category: t
      .string({ max: 80 })
      .nullable()
      .describe('Optional category filter. Use a single lowercase Overture BASIC_CATEGORY, e.g. coffee_shop, restaurant, fast_food_restaurant, grocery_store, supermarket, convenience_store, gas_station, pharmacy, hospital, clothing_store, electronics_store, gym, bakery, bar, hotel, bank, school. Matched against BASIC_CATEGORY / primary category with a LIKE fallback, so partial words work. Omit to count/list all places.'),
    group_by: t
      .string({ max: 20 })
      .nullable()
      .describe('Aggregation mode: "list" (default; individual places), "city" (counts per city), or "category" (counts per basic_category).'),
    max_results: t
      .number()
      .nullable()
      .describe('Maximum rows/groups to return. Defaults to 100, hard-capped at 500.'),
    min_lon: t.number().nullable().describe('West longitude of the bounding box. Provide all four bbox bounds together, or none.'),
    min_lat: t.number().nullable().describe('South latitude of the bounding box.'),
    max_lon: t.number().nullable().describe('East longitude of the bounding box.'),
    max_lat: t.number().nullable().describe('North latitude of the bounding box.'),
  },
  returns: {
    result: t
      .object({})
      .describe('Overture search response: status, mode, count, bbox, and rows (places or per-group counts).'),
  },
  validate: (args, ctx) => {
    if (args.group_by != null && args.group_by.trim() !== '' &&
        !OVERTURE_PLACES_GROUP_BY.includes(args.group_by.trim().toLowerCase() as typeof OVERTURE_PLACES_GROUP_BY[number])) {
      ctx.fail(OvertureCodes.UNSUPPORTED_GROUP_BY, `group_by must be one of ${OVERTURE_PLACES_GROUP_BY.join(', ')}; got '${args.group_by}'.`);
    }
    if (args.max_results != null && (!Number.isFinite(args.max_results) || args.max_results < 1)) {
      ctx.fail(OvertureCodes.INVALID_MAX_RESULTS, `max_results must be a positive integer; got ${args.max_results}.`);
    }
    const bbox = [args.min_lon, args.min_lat, args.max_lon, args.max_lat];
    const bboxProvided = bbox.filter((v) => v != null).length;
    if (bboxProvided > 0 && bboxProvided < 4) {
      ctx.fail(OvertureCodes.INCOMPLETE_BBOX, 'A bounding box needs all four of min_lon, min_lat, max_lon, max_lat (or none).');
    }
    const hasRegion = args.region != null && args.region.trim() !== '';
    if (!hasRegion && bboxProvided < 4) {
      ctx.fail(OvertureCodes.MISSING_BOUNDS, 'Provide either a provisioned region or a full bbox (min_lon, min_lat, max_lon, max_lat).');
    }
  },
  execute: async (args, ctx) => {
    const result = await callTool(ctx.conn, Procs.overtureSearch, [
      args.region,
      args.poi_category,
      args.group_by,
      args.max_results,
      args.min_lon,
      args.min_lat,
      args.max_lon,
      args.max_lat,
    ]);
    return { result };
  },
});
