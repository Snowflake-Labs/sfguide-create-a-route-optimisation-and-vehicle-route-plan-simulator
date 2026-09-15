import { defineProc, t } from '@snowflake/synapse';
import { OpsCodes } from '../codes.js';

/**
 * Launch a travel-matrix build, asynchronously.
 *
 * WHY THIS SHAPE
 * --------------
 * Same constraint as `provision_region`: the build runs for minutes to hours,
 * so it cannot be awaited inside a verb. The async launch lives in SQL
 * (OPENROUTESERVICE_APP.CORE.START_MATRIX_BUILD, a schedule-less task plus
 * EXECUTE TASK) because a stored procedure cannot fire-and-forget the way the
 * admin app's Node process can.
 *
 * The whole matrix subsystem - 16 admin-app routes - previously had no SQL
 * entry point and, worse, no agent instruction saying it was app-only. An agent
 * asked to build a matrix had neither a tool nor a documented refusal, which is
 * the combination that invites an invented answer.
 *
 * DESTRUCTIVE-ADJACENT: a matrix build issues millions of routing calls and
 * scales the region's service and compute pool up while it runs. The agent
 * instructions require confirming region, profile and resolution with the user
 * first, and the returned `note` states that the matrix is unusable until the
 * build completes. Reporting "launched" as "ready" is a defect.
 */
export const matrix_build = defineProc({
  name: 'matrix_build',
  description:
    'Start building a travel-time MATRIX for an already-provisioned routing region (tessellates ' +
    'the region into H3 cells and routes every origin-destination pair). Returns immediately ' +
    'with a job id: the build runs asynchronously and takes minutes to hours, and the matrix ' +
    'CANNOT be used until it finishes - poll matrix_status to follow it. One resolution per ' +
    'call. Each step finer multiplies the cell count by about 7 and the pair count by about 49, ' +
    'so this commits real compute and scales the region service up while it runs: confirm ' +
    'region, profile and resolution with the user before calling. Refuses a region with no ' +
    'bounding box (it must be provisioned first), a duplicate build for the same target, and ' +
    'anything over 10 billion pairs unless force is set.',
  roles: ['ops'],
  args: {
    region: t
      .string({ min: 1, max: 80 })
      .describe('Provisioned region to build the matrix for, e.g. "SanFrancisco".'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe(
        'Optional routing profile: driving-car, driving-hgv, cycling-electric, cycling-regular ' +
          'or foot-walking. Defaults to driving-car.',
      ),
    resolution: t
      .number()
      .nullable()
      .describe(
        'Optional H3 resolution between 5 (coarse, cheap) and 10 (fine, very expensive). ' +
          'Defaults to 7. Ask the user rather than guessing: this is the main cost lever.',
      ),
    road_filter: t
      .boolean()
      .nullable()
      .describe(
        'Keep only cells containing a road. Cheaper and usually what a road fleet wants, but it ' +
          'reduces coverage. Leave null for the unfiltered default.',
      ),
    force: t
      .boolean()
      .nullable()
      .describe(
        'Override the 10-billion-pair refusal. Only pass this when the user has been told the ' +
          'estimate and explicitly accepted it.',
      ),
  },
  returns: {
    result: t
      .object({})
      .describe(
        'On success: status "launched" plus job_id, region, profile, resolution, the cell-count ' +
          'estimate, and a note about the expected duration. On refusal: status "error" and the ' +
          'reason.',
      ),
  },
  validate: async (args, ctx) => {
    // Bounds-check here as well as in SQL so the refusal is TYPED in the audit
    // trail rather than arriving as a generic error string.
    if (args.resolution != null) {
      const r = Number(args.resolution);
      if (!Number.isInteger(r) || r < 5 || r > 10) {
        ctx.fail(
          OpsCodes.INVALID_GENERATION_PARAM,
          `resolution must be a whole H3 resolution between 5 and 10 (got ${args.resolution})`,
        );
      }
    }
  },
  execute: async (args, ctx) => {
    const raw = await ctx.conn.execScalar<string>(
      `CALL OPENROUTESERVICE_APP.CORE.START_MATRIX_BUILD(?, ?, ?, ?, ?)`,
      [
        args.region,
        args.profile ?? null,
        args.resolution == null ? null : Number(args.resolution),
        args.road_filter === true,
        args.force === true,
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
