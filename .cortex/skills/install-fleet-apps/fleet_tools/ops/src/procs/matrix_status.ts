import { defineProc, t } from '@snowflake/synapse';

/**
 * Travel-matrix state: what exists, and what is being built right now.
 *
 * Read-only. Two questions in one call because they are always asked together:
 * "do we have a matrix for X" (inventory) and "how far along is the build"
 * (progress). Splitting them would let an agent answer "no matrix" while a build
 * was at 90%, or quote a stale COMPLETE row while a rebuild was in flight.
 *
 * Neither half wakes a service. A matrix build is the ONLY thing that populates
 * these tables, so an empty inventory means no matrix has ever been built here -
 * not that the data is missing.
 */
export const matrix_status = defineProc({
  name: 'matrix_status',
  description:
    'Report travel-time MATRIX state: which matrices exist (region, profile, H3 resolution, cell ' +
    'count, row count, when built) and any build currently in flight with its stage and percent ' +
    'complete. Use for "do we have a travel matrix for X", "how big is it", "how is the matrix ' +
    'build going", "why did the matrix build fail". Read-only and never wakes a service. An ' +
    'empty inventory means no matrix has ever been built on this deployment, which is normal - ' +
    'matrix_build starts one.',
  roles: ['ops'],
  args: {
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Optional region to focus on. Omit for the whole inventory.'),
    profile: t
      .string({ max: 40 })
      .nullable()
      .describe(
        'Optional routing profile, e.g. "driving-car". Only used with region, to fetch per-stage ' +
          'progress for that specific target.',
      ),
  },
  returns: {
    result: t
      .object({})
      .describe('inventory[], progress{} per resolution, recent_jobs[], and a one-line summary.'),
  },
  execute: async (args, ctx) => {
    const region = (args.region ?? '').trim() || null;
    const profile = (args.profile ?? '').trim() || null;

    let inventory: unknown = [];
    try {
      const raw = await ctx.conn.execScalar<string>(
        'CALL OPENROUTESERVICE_APP.CORE.MATRIX_INVENTORY()',
      );
      inventory = raw == null ? [] : JSON.parse(String(raw));
      if (region && Array.isArray(inventory)) {
        inventory = (inventory as Record<string, unknown>[]).filter(
          (r) => String(r.region ?? '').toUpperCase() === region.toUpperCase(),
        );
      }
    } catch (e) {
      inventory = { error: (e as Error).message };
    }

    // Per-resolution progress for one target. MATRIX_PROGRESS needs both a
    // region and a profile, so this is only meaningful when a region was named.
    let progress: unknown = null;
    if (region) {
      try {
        const raw = await ctx.conn.execScalar<string>(
          'CALL OPENROUTESERVICE_APP.CORE.MATRIX_PROGRESS(?, ?)',
          [region, profile ?? 'driving-car'],
        );
        progress = raw == null ? {} : JSON.parse(String(raw));
      } catch (e) {
        progress = { error: (e as Error).message };
      }
    }

    let jobs: Record<string, unknown>[] = [];
    try {
      const raw = await ctx.conn.execScalar<string>(
        `SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
             'job_id', JOB_ID, 'region', REGION, 'profile', PROFILE,
             'resolution', RESOLUTION, 'status', STATUS, 'stage', STAGE,
             'pct', PCT_COMPLETE, 'hexagons', HEXAGONS, 'matrix_rows', MATRIX_ROWS,
             'message', MESSAGE, 'error', ERROR_MSG,
             -- Both cell-accounting notes are surfaced deliberately. A build can
             -- report COMPLETE having silently dropped the user's road filter
             -- (filter_warning) or a large share of unroutable cells
             -- (routability_note), and without these a shrinking cell count
             -- reads as data loss.
             'routability_note', COALESCE(ROUTABILITY_NOTE, ''),
             'filter_warning', COALESCE(FILTER_WARNING, ''),
             'created_at', TO_VARCHAR(CREATED_AT),
             'completed_at', TO_VARCHAR(COMPLETED_AT)
           )) WITHIN GROUP (ORDER BY CREATED_AT DESC), ARRAY_CONSTRUCT())::STRING
         FROM (
           SELECT *
           FROM OPENROUTESERVICE_APP.TRAVEL_MATRIX.MATRIX_BUILD_JOBS
           WHERE (? IS NULL OR UPPER(REGION) = UPPER(?))
           ORDER BY CREATED_AT DESC
           LIMIT 20
         )`,
        [region, region],
      );
      const parsed = raw == null ? [] : JSON.parse(String(raw));
      if (Array.isArray(parsed)) jobs = parsed as Record<string, unknown>[];
    } catch (e) {
      jobs = [{ error: (e as Error).message }];
    }

    const inFlight = jobs.filter((j) => j.status === 'PENDING' || j.status === 'RUNNING');
    const built = Array.isArray(inventory) ? inventory.length : 0;
    const summary = inFlight.length
      ? `${built} matrix/matrices built; ${inFlight.length} build(s) in flight: ` +
        inFlight
          .map((j) => `${j.region}/${j.profile}/${j.resolution} (${j.stage}, ${j.pct}%)`)
          .join(', ') +
        '. A build in flight means that matrix is not usable yet.'
      : built === 0
        ? 'No travel matrix has been built on this deployment yet, and no build is in flight.'
        : `${built} matrix/matrices built; no build in flight.`;

    return { result: { inventory, progress, recent_jobs: jobs, in_flight: inFlight, summary } };
  },
});
