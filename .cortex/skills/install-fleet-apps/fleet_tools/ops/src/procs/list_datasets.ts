import { defineProc, t } from '@snowflake/synapse';

/**
 * Dataset inventory.
 *
 * WHY THERE IS NO `generate_dataset` SIBLING
 * -----------------------------------------
 * Synthetic dataset GENERATION has no SQL entry point. It runs inside the admin
 * app's Node process (`startGeneration` in server/studio/jobs.ts), which keeps an
 * in-memory job map, streams progress over SSE, and drives thousands of live
 * routing calls from the container's event loop. A stored procedure - and so a
 * synapse verb - cannot host that.
 *
 * OPENROUTESERVICE_APP.CORE.STUDIO_START_JOB looks like the SQL entry point and
 * is not: it launches a one-shot SPCS job service from an `ors_studio_worker`
 * image that is built nowhere in this repo, has no tag in image-versions.env, and
 * is called by nothing. Wrapping it would have produced a verb that reports
 * "launched" and then silently never generates anything, which is worse than not
 * having the verb.
 *
 * So this verb covers the half that IS SQL-reachable - reading the dataset
 * inventory, which pairs with the existing `activate_dataset` - and its response
 * carries an explicit note telling the agent where generation is actually driven
 * from, so "generate me a dataset" gets a correct answer rather than a fabricated
 * job id.
 */
export const list_datasets = defineProc({
  name: 'list_datasets',
  description:
    'List the synthetic datasets in this deployment: region, asset mode, row counts, when each ' +
    'was generated, and which one is ACTIVE per region and asset mode. Use for "what datasets do ' +
    'we have", "which dataset is active", "how much data is in region X", or before calling ' +
    'activate_dataset. Read-only. NOTE: this cannot CREATE a dataset - generation runs in the ' +
    'admin app Data Studio, not in SQL - so for "generate a dataset" requests, say that and ' +
    'point the user to the admin app rather than reporting a job started.',
  roles: ['ops'],
  args: {
    region: t.string({ max: 80 }).nullable().describe('Optional region filter.'),
    vehicle_type: t
      .string({ max: 80 })
      .nullable()
      .describe('Optional asset mode filter (e.g. car, hgv, ebike).'),
    active_only: t
      .boolean()
      .nullable()
      .describe('Only the active dataset per region and asset mode. Defaults to false.'),
  },
  returns: {
    count: t.number().describe('Datasets returned.'),
    datasets: t.array(t.object({})).describe('Dataset rows.'),
    note: t.string().describe('Where dataset generation is actually driven from.'),
  },
  execute: async (args, ctx) => {
    const region = (args.region ?? '').trim() || null;
    const vt = (args.vehicle_type ?? '').trim() || null;
    const activeOnly = args.active_only === true;

    let datasets: Record<string, unknown>[] = [];
    try {
      const raw = await ctx.conn.execScalar<string>(
        `SELECT COALESCE(ARRAY_AGG(OBJECT_CONSTRUCT(
             'dataset_id', d.DATASET_ID,
             'label', d.LABEL,
             'region', d.REGION,
             'vehicle_type', d.VEHICLE_TYPE,
             'is_active', d.IS_ACTIVE,
             'created_at', TO_VARCHAR(d.CREATED_AT)
           )) WITHIN GROUP (ORDER BY d.REGION, d.VEHICLE_TYPE, d.CREATED_AT DESC), ARRAY_CONSTRUCT())::STRING
         FROM (
           SELECT d.*
           FROM FLEET_INTELLIGENCE.CORE.DIM_DATASETS d
           LEFT JOIN FLEET_INTELLIGENCE.CORE.GENERATION_JOBS j ON j.JOB_ID = d.DATASET_ID
           WHERE COALESCE(j.STATUS, 'COMPLETED') NOT IN ('DELETED', 'CANCELLED')
             AND (? IS NULL OR UPPER(d.REGION) = UPPER(?))
             AND (? IS NULL OR UPPER(d.VEHICLE_TYPE) = UPPER(?))
             AND (NOT ? OR d.IS_ACTIVE)
           ORDER BY d.REGION, d.VEHICLE_TYPE, d.CREATED_AT DESC
           LIMIT 200
         ) d`,
        [region, region, vt, vt, activeOnly],
      );
      const parsed = raw == null ? [] : JSON.parse(String(raw));
      if (Array.isArray(parsed)) datasets = parsed as Record<string, unknown>[];
    } catch (e) {
      datasets = [{ error: (e as Error).message }];
    }

    return {
      count: datasets.length,
      datasets,
      note:
        'Datasets are IMMUTABLE per generation run and at most one is active per (region, asset ' +
        'mode); re-running generation archives the previous one rather than deleting it. ' +
        'Generating a NEW dataset is not possible from a tool call: it runs in the admin app ' +
        'Data Studio, which drives thousands of live routing calls from the app container. Use ' +
        'activate_dataset to switch which existing dataset is live.',
    };
  },
});
