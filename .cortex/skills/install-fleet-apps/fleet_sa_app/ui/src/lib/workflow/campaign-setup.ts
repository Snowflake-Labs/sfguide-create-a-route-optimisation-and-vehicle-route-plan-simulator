import { query, run } from '@/lib/snowflake';
import type { WorkflowDefinition, WorkflowStep } from '@/lib/workflow/engine';

async function checkNameUnique(table: string, nameCol: string, name: string): Promise<boolean> {
  const rows = await query<{ CNT: number }>(
    `SELECT COUNT(*) AS CNT FROM CDP.APP.${table} WHERE tenant_id = 'default' AND ${nameCol} = ? AND deleted_at IS NULL`,
    [name],
  );
  return (rows[0]?.CNT ?? 0) === 0;
}

async function newId(): Promise<string> {
  const rows = await query<{ ID: string }>(`SELECT UUID_STRING() AS ID`);
  return rows[0].ID;
}

const validateInputs: WorkflowStep = {
  name: 'validate_inputs',
  async execute(_instanceId, params) {
    const aud = (params.audience ?? {}) as Record<string, unknown>;
    const off = (params.offer ?? {}) as Record<string, unknown>;
    const camp = (params.campaign ?? {}) as Record<string, unknown>;
    if (!params.audience_name && aud.audience_name) params.audience_name = aud.audience_name;
    if (!params.audience_sql && !params.audience_filter) {
      params.audience_sql = aud.definition_sql ?? aud.audience_sql ?? '';
    }
    if (!params.offer_name && off.offer_name) params.offer_name = off.offer_name;
    if (!params.offer_type && off.offer_type) params.offer_type = off.offer_type;
    if (!params.campaign_name && camp.campaign_name) params.campaign_name = camp.campaign_name;
    if (!params.objective && camp.objective) params.objective = camp.objective;
    if (!params.channel && camp.channel) params.channel = camp.channel;

    const errors: string[] = [];
    if (params.audience_name && !(await checkNameUnique('AUDIENCE', 'audience_name', String(params.audience_name)))) {
      errors.push(`An audience named "${params.audience_name}" already exists. Use a different name.`);
    }
    if (params.offer_name && !(await checkNameUnique('OFFER_CATALOGUE', 'offer_name', String(params.offer_name)))) {
      errors.push(`An offer named "${params.offer_name}" already exists. Use a different name.`);
    }
    if (params.campaign_name && !(await checkNameUnique('CAMPAIGN', 'campaign_name', String(params.campaign_name)))) {
      errors.push(`A campaign named "${params.campaign_name}" already exists. Use a different name.`);
    }
    if (errors.length > 0) throw new Error(errors.join(' '));
    return { validated: true };
  },
};

const createAudience: WorkflowStep = {
  name: 'create_audience',
  async execute(_instanceId, params) {
    const audienceName = String(params.audience_name);
    const definitionSql = String(params.audience_sql ?? params.audience_filter ?? '');
    let estimatedSize = 0;
    if (definitionSql) {
      try {
        const countRows = await query<{ CNT: number }>(`SELECT COUNT(*) AS CNT FROM (${definitionSql}) AS _m`);
        estimatedSize = countRows[0]?.CNT ?? 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Audience SQL is invalid: ${msg}. Correct the definition_sql and retry.`);
      }
    }
    const audienceId = await newId();
    await run(
      `INSERT INTO CDP.APP.AUDIENCE
       (audience_id, tenant_id, audience_name, definition_type, definition_sql, status, version, created_by, created_at, updated_at)
       SELECT ?, 'default', ?, 'sql', ?, 'draft', 0, 'workflow_service', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()`,
      [audienceId, audienceName, definitionSql],
    );
    if (estimatedSize > 0) {
      await run(
        `UPDATE CDP.APP.AUDIENCE SET estimated_size = ?, updated_at = CURRENT_TIMESTAMP() WHERE audience_id = ?`,
        [estimatedSize, audienceId],
      );
    }
    return { audience_id: audienceId, audience_name: audienceName, estimated_size: estimatedSize };
  },
};

const createOffer: WorkflowStep = {
  name: 'create_offer',
  async execute(_instanceId, params) {
    const offerId = await newId();
    await run(
      `INSERT INTO CDP.APP.OFFER_CATALOGUE
       (offer_id, tenant_id, offer_name, offer_type, status, version, created_by, created_at, updated_at)
       SELECT ?, 'default', ?, ?, 'draft', 0, 'workflow_service', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()`,
      [offerId, String(params.offer_name), String(params.offer_type ?? 'Loyalty Reward')],
    );
    return { offer_id: offerId, offer_name: String(params.offer_name) };
  },
};

const createCampaign: WorkflowStep = {
  name: 'create_campaign',
  async execute(_instanceId, params, stepOutputs) {
    const campaignId = await newId();
    const audienceId = String((stepOutputs.create_audience as Record<string, unknown>)?.audience_id ?? params.audience_id ?? '');
    const offerId = String((stepOutputs.create_offer as Record<string, unknown>)?.offer_id ?? params.offer_id ?? '');
    await run(
      `INSERT INTO CDP.APP.CAMPAIGN
       (campaign_id, tenant_id, campaign_name, objective, channel, target_audience_id, offer_id, status, version, created_by, created_at, updated_at)
       SELECT ?, 'default', ?, ?, ?, ?, ?, 'draft', 0, 'workflow_service', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()`,
      [campaignId, String(params.campaign_name), String(params.objective ?? 'Customer retention'), String(params.channel ?? 'email'), audienceId, offerId],
    );
    return { campaign_id: campaignId, campaign_name: String(params.campaign_name), audience_id: audienceId, offer_id: offerId };
  },
};

export const campaignSetupWorkflow: WorkflowDefinition = {
  type: 'campaign_setup',
  steps: [validateInputs, createAudience, createOffer, createCampaign],
  gates: [],
};
