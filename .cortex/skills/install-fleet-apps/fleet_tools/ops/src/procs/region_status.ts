import { defineProc, t } from '@snowflake/synapse';

/**
 * One call that answers "is this region built, and is it running".
 *
 * Those are two different facts that used to need two tools: GET_PROVISION_STATUS
 * covers builds in flight, LIST_REGIONS covers what is installed, and ORS_STATUS
 * covers whether the service is awake. An agent asked "can I route in Europe?"
 * needs all three, so this returns them together rather than making the agent
 * chain calls and risk answering from only one.
 *
 * Read-only. In particular it never wakes a service: a region reading SUSPENDED
 * is the normal idle state, and resuming it is a separate, explicit action.
 */
export const region_status = defineProc({
  name: 'region_status',
  description:
    'Report routing region state: which regions are installed, any build currently in flight ' +
    '(with its stage and message), and whether a region is buildable. Use for "is region X ' +
    'ready", "how is the build going", "which regions do we have", "what is the active region". ' +
    'Read-only: it never wakes a suspended service, and a region reading SUSPENDED is the normal ' +
    'idle state rather than a fault - offer to resume it instead of reporting a problem.',
  roles: ['ops'],
  args: {
    region: t
      .string({ max: 80 })
      .nullable()
      .describe('Optional region to focus on. Omit for every region and every in-flight build.'),
    job_id: t
      .string({ max: 200 })
      .nullable()
      .describe('Optional provisioning job id to look up specifically.'),
  },
  returns: {
    result: t
      .object({})
      .describe('regions[], provision_jobs[], and a one-line summary.'),
  },
  execute: async (args, ctx) => {
    const region = (args.region ?? '').trim() || null;
    const jobId = (args.job_id ?? '').trim() || null;

    // Installed regions, from the contract-facing lister.
    let regions: unknown = [];
    try {
      const raw = await ctx.conn.execScalar<string>('CALL OPENROUTESERVICE_APP.CORE.LIST_REGIONS()');
      regions = raw == null ? [] : JSON.parse(String(raw));
    } catch (e) {
      regions = { error: (e as Error).message };
    }

    // Build history / in-flight jobs. Read the table rather than
    // GET_PROVISION_STATUS() so the region and job_id filters can be applied
    // server-side and an idle deployment returns a small result.
    let jobs: Record<string, unknown>[] = [];
    try {
      const raw = await ctx.conn.execScalar<string>(
        `SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
             'job_id', JOB_ID, 'region', REGION, 'status', STATUS, 'stage', STAGE,
             'message', MESSAGE, 'error', ERROR_MSG, 'compute_size', COMPUTE_SIZE,
             'created_at', TO_VARCHAR(CREATED_AT), 'started_at', TO_VARCHAR(STARTED_AT),
             'completed_at', TO_VARCHAR(COMPLETED_AT)
           )) WITHIN GROUP (ORDER BY CREATED_AT DESC), ARRAY_CONSTRUCT())::STRING
         FROM (
           SELECT *
           FROM OPENROUTESERVICE_APP.CORE.REGION_PROVISION_JOBS
           WHERE (? IS NULL OR UPPER(REGION) = UPPER(?))
             AND (? IS NULL OR JOB_ID = ?)
           ORDER BY CREATED_AT DESC
           LIMIT 20
         )`,
        [region, region, jobId, jobId],
      );
      const parsed = raw == null ? [] : JSON.parse(String(raw));
      if (Array.isArray(parsed)) jobs = parsed as Record<string, unknown>[];
    } catch (e) {
      jobs = [{ error: (e as Error).message }];
    }

    const inFlight = jobs.filter(
      (j) => j.status === 'PENDING' || j.status === 'RUNNING',
    );

    const regionCount = Array.isArray(regions) ? regions.length : 0;
    const summary = inFlight.length
      ? `${regionCount} region(s) installed; ${inFlight.length} build(s) in flight: ` +
        inFlight.map((j) => `${j.region} (${j.status}/${j.stage})`).join(', ') +
        '. A build in flight means that region is not usable for routing yet.'
      : `${regionCount} region(s) installed; no build in flight.`;

    return { result: { regions, provision_jobs: jobs, in_flight: inFlight, summary } };
  },
});
