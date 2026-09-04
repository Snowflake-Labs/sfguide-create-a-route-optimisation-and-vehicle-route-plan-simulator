import { defineProc, t } from '@snowflake/synapse';
import { OpsCodes } from '../codes.js';

/**
 * Start a region build, asynchronously.
 *
 * WHY THIS SHAPE
 * --------------
 * A region build takes tens of minutes to several hours. It cannot be awaited
 * inside a verb, so this launches and returns a job id, and the caller polls
 * `region_status`. The async launch itself lives in SQL
 * (OPENROUTESERVICE_APP.CORE.START_REGION_PROVISION, which uses a schedule-less
 * task plus EXECUTE TASK) because a stored procedure cannot fire-and-forget the
 * way the admin app's Node process can.
 *
 * The verb deliberately does NOT take a PBF URL or a bounding box: both are
 * resolved from REGION_CATALOG by the procedure, so an agent cannot invent a
 * download URL. It only takes what a human would actually choose.
 *
 * DESTRUCTIVE-ADJACENT: this spends real compute for hours. The agent
 * instructions require confirming the region and size with the user first, and
 * the returned `note` states plainly that the region is not usable until the
 * build completes - an agent reporting "launched" as "ready" would be a defect.
 */
export const provision_region = defineProc({
  name: 'provision_region',
  description:
    'Start building a NEW routing region (downloads its OpenStreetMap extract and builds the ' +
    'routing graphs). Returns immediately with a job id: the build runs asynchronously and takes ' +
    'tens of minutes to several hours depending on region size, and the region CANNOT be used ' +
    'for routing until it finishes - poll region_status to follow it. The extract URL and ' +
    'bounding box are resolved from the region catalog, so only the region name is required. ' +
    'This commits real compute for hours, so confirm the region name and compute size with the ' +
    'user before calling. Fails if a build for the region is already in flight.',
  roles: ['ops'],
  args: {
    region: t
      .string({ min: 1, max: 80 })
      .describe('Region to build, as named in the region catalog (e.g. "Malta", "Denmark").'),
    display_name: t
      .string({ max: 120 })
      .nullable()
      .describe('Optional human-readable label. Defaults to the region name.'),
    profiles: t
      .string({ max: 200 })
      .nullable()
      .describe(
        'Optional comma-separated routing profiles, e.g. "driving-car,driving-hgv". Defaults to ' +
          'driving-car,driving-hgv,cycling-electric. Fewer profiles build faster.',
      ),
    compute_size: t
      .string({ max: 8 })
      .nullable()
      .describe(
        'Optional build size: S, M, L, XL or XXL. Defaults to XXL. Small countries build fine ' +
          'on S; a continent needs XXL.',
      ),
    force_redownload: t
      .boolean()
      .nullable()
      .describe(
        'Re-download the map extract even if it is already staged. Only needed for a corrupt or ' +
          'stale extract; leave null otherwise.',
      ),
  },
  returns: {
    result: t
      .object({})
      .describe(
        'On success: status "launched" plus job_id, region, profiles, compute_size and a note ' +
          'about the expected duration. On refusal: status "error" and the reason.',
      ),
  },
  validate: async (args, ctx) => {
    const size = (args.compute_size ?? '').trim().toUpperCase();
    if (size !== '' && !['S', 'M', 'L', 'XL', 'XXL'].includes(size)) {
      ctx.fail(
        OpsCodes.INVALID_COMPUTE_SIZE,
        `compute_size must be one of S, M, L, XL, XXL (got "${args.compute_size}")`,
      );
    }
    // Deliberately NOT checking REGION_EXISTS here: that returns true only for
    // ALREADY-provisioned regions, and the entire point of this verb is to build
    // one that does not exist yet. Catalog resolution is the real check and it
    // happens inside the procedure, which returns a readable reason.
  },
  execute: async (args, ctx) => {
    const raw = await ctx.conn.execScalar<string>(
      `CALL OPENROUTESERVICE_APP.CORE.START_REGION_PROVISION(?, ?, ?, ?, ?)`,
      [
        args.region,
        args.display_name ?? null,
        args.profiles ?? null,
        args.compute_size ?? null,
        args.force_redownload === true,
      ],
    );
    let result: Record<string, unknown>;
    try {
      result = raw == null ? { status: 'error', error: 'no result' } : JSON.parse(String(raw));
    } catch {
      result = { status: 'error', error: String(raw) };
    }
    return { result };
  },
});
