import { defineProc, t } from '@snowflake/synapse';
import { Procs } from '../catalog.js';
import { callTool } from '../helpers.js';
import { OvertureCodes, OVERTURE_ADDRESSES_GROUP_BY } from '../codes.js';

/**
 * Region/bbox-bounded Overture Maps address density. Answers "how many addresses
 * / address coverage per city" questions over OVERTURE_MAPS__ADDRESSES, with the
 * same cost-safe bounding contract as query_overture_places (bbox prune +
 * NULL-safe ST_WITHIN(BOUNDARY) + hard LIMIT capped at 500). The ADDRESSES
 * Overture share ships no semantic view, so this verb (and the region-scoped SV)
 * is the supported way to query it.
 */
export const query_overture_addresses = defineProc({
  name: 'query_overture_addresses',
  description:
    'Count or list Overture Maps street addresses across a whole region (or an explicit ' +
    'bounding box). Use for address-density questions like "how many addresses are in this ' +
    'region", "address coverage per city", or "list sample addresses in the area". Bound the ' +
    'search with a provisioned region name OR a full bbox (min/max lon/lat). group_by="city" ' +
    '(default) returns address counts per city; "list" returns sampled individual addresses.',
  roles: ['user'],
  args: {
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Provisioned region name (e.g. "SanFrancisco"). Resolves the boundary polygon. Pass the active region by default unless the user names a different place; provide this OR a full bbox.'),
    group_by: t
      .string({ max: 20 })
      .nullable()
      .describe('Aggregation mode: "city" (default; address counts per city) or "list" (sampled individual addresses).'),
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
      .describe('Overture address response: status, mode, count, bbox, and rows (addresses or per-city counts).'),
  },
  validate: (args, ctx) => {
    if (args.group_by != null && args.group_by.trim() !== '' &&
        !OVERTURE_ADDRESSES_GROUP_BY.includes(args.group_by.trim().toLowerCase() as typeof OVERTURE_ADDRESSES_GROUP_BY[number])) {
      ctx.fail(OvertureCodes.UNSUPPORTED_GROUP_BY, `group_by must be one of ${OVERTURE_ADDRESSES_GROUP_BY.join(', ')}; got '${args.group_by}'.`);
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
    const result = await callTool(ctx.conn, Procs.overtureAddresses, [
      args.region,
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
