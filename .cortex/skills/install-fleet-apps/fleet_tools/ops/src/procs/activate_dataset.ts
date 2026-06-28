import { defineProc, t } from '@snowflake/synapse';

// Promote a dataset to the GLOBAL active scope (DIM_DATASETS.IS_ACTIVE flip) via
// CORE.ACTIVATE_DATASET, which preserves the one-active-per-(region,vehicle)
// invariant. This is the audited synapse equivalent of the raw CALL the
// /api/ops/activate-dataset route used to issue directly (Tenet 7): the SA app
// now routes it through this verb so the mutation lands in VERB_ATTEMPT.
//
// The dataset_id format is enforced by the arg schema regex, so a malformed id
// is rejected by the envelope's parse step (BAD_VALUE_TYPE) before execute runs
// - no string interpolation, value is bound. Ops-only.
export const activate_dataset = defineProc({
  name: 'activate_dataset',
  description:
    'Promote a dataset to the global active scope (DIM_DATASETS.IS_ACTIVE), ' +
    'preserving the one-active-per-(region,vehicle) invariant. Provide the ' +
    'dataset JOB_ID. Ops-only.',
  roles: ['ops'],
  args: {
    dataset_id: t
      .string({ min: 1, max: 200, regex: /^[A-Za-z0-9-]+$/ })
      .describe('Dataset JOB_ID to activate (alphanumeric and hyphens only).'),
  },
  returns: {
    message: t.string().describe('Confirmation message from CORE.ACTIVATE_DATASET.'),
  },
  execute: async (args, ctx) => {
    const out = await ctx.conn.execScalar<string>(
      'CALL FLEET_INTELLIGENCE.CORE.ACTIVATE_DATASET(?)',
      [args.dataset_id],
    );
    return { message: out == null ? `Activated dataset ${args.dataset_id}` : String(out) };
  },
});
