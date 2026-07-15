import { query, run } from '@/lib/snowflake';
import type { WorkflowDefinition, WorkflowStep } from '@/lib/workflow/engine';

const validateCampaign: WorkflowStep = {
  name: 'validate_campaign',
  async execute(_instanceId, params) {
    const campaignId = String(params.campaign_id ?? '');
    if (!campaignId) throw new Error('params.campaign_id is required');
    const rows = await query<{
      AUDIENCE_STATUS: string | null;
      AUDIENCE_NAME: string | null;
      OFFER_STATUS: string | null;
      OFFER_NAME: string | null;
    }>(`
      SELECT a.status AS audience_status, a.audience_name,
             o.status AS offer_status, o.offer_name
      FROM CDP.APP.CAMPAIGN c
      LEFT JOIN CDP.APP.AUDIENCE a ON c.target_audience_id = a.audience_id
      LEFT JOIN CDP.APP.OFFER_CATALOGUE o ON c.offer_id = o.offer_id
      WHERE c.campaign_id = ? AND c.tenant_id = 'default'
    `, [campaignId]);
    if (!rows[0]) throw new Error(`Campaign not found: ${campaignId}`);
    const errors: string[] = [];
    if (rows[0].AUDIENCE_STATUS && rows[0].AUDIENCE_STATUS !== 'active')
      errors.push(`Audience "${rows[0].AUDIENCE_NAME}" is "${rows[0].AUDIENCE_STATUS}" - approve it before activation`);
    if (rows[0].OFFER_STATUS && rows[0].OFFER_STATUS !== 'active')
      errors.push(`Offer "${rows[0].OFFER_NAME}" is "${rows[0].OFFER_STATUS}" - approve it before activation`);
    if (errors.length > 0) throw new Error(errors.join('. '));
    return { validated: true };
  },
};

const resolveAudience: WorkflowStep = {
  name: 'resolve_audience',
  async execute(_instanceId, params) {
    const campaignId = String(params.campaign_id ?? '');
    if (!campaignId) throw new Error('params.campaign_id is required');
    const camps = await query<{ TARGET_AUDIENCE_ID: string }>(`
      SELECT target_audience_id FROM CDP.APP.CAMPAIGN
      WHERE campaign_id = ? AND tenant_id = 'default'`, [campaignId]);
    if (!camps[0]) throw new Error(`Campaign not found: ${campaignId}`);
    const audienceId = camps[0].TARGET_AUDIENCE_ID;
    if (!audienceId) throw new Error('Campaign has no target_audience_id');
    const auds = await query<{ DEFINITION_SQL: string }>(`
      SELECT definition_sql FROM CDP.APP.AUDIENCE
      WHERE audience_id = ? AND tenant_id = 'default' AND deleted_at IS NULL`, [audienceId]);
    if (!auds[0]) throw new Error(`Audience not found: ${audienceId}`);
    const definitionSql = auds[0].DEFINITION_SQL;
    if (!definitionSql) throw new Error('Audience has no definition_sql - cannot resolve membership');
    const countRows = await query<{ CNT: number }>(`SELECT COUNT(*) AS CNT FROM (${definitionSql}) AS _m`);
    const rawCount = countRows[0]?.CNT ?? 0;
    await run(
      `UPDATE CDP.APP.AUDIENCE SET estimated_size = ?, updated_at = CURRENT_TIMESTAMP()
       WHERE audience_id = ? AND tenant_id = 'default'`,
      [rawCount, audienceId],
    );
    return { raw_audience_count: rawCount, audience_id: audienceId, campaign_id: campaignId };
  },
};

const applyFilters: WorkflowStep = {
  name: 'apply_filters',
  async execute(_instanceId, _params, stepOutputs) {
    const prev = stepOutputs.resolve_audience as Record<string, unknown> ?? {};
    const rawCount = Number(prev.raw_audience_count ?? 0);
    return {
      eligible_count: rawCount,
      filter_breakdown: { suppressed: 0, no_consent: 0, frequency_capped: 0, cooldown: 0 },
      note: 'Compliance filters not yet implemented - all records passed through',
    };
  },
};

const enrich: WorkflowStep = {
  name: 'enrich_payload',
  async execute(_instanceId, _params, stepOutputs) {
    const prev = stepOutputs.apply_filters as Record<string, unknown> ?? {};
    return { payload_ready: true, eligible_count: prev.eligible_count ?? 0 };
  },
};

const push: WorkflowStep = {
  name: 'push_to_destination',
  async execute(_instanceId, params, stepOutputs) {
    const prev = stepOutputs.apply_filters as Record<string, unknown> ?? {};
    return {
      records_pushed: prev.eligible_count ?? 0,
      destination: String(params.destination ?? 'email_platform'),
      note: 'Destination push not yet implemented - placeholder',
    };
  },
};

const logResults: WorkflowStep = {
  name: 'log_results',
  async execute(_instanceId, params, stepOutputs) {
    const resolvePrev = stepOutputs.resolve_audience as Record<string, unknown> ?? {};
    const filterPrev = stepOutputs.apply_filters as Record<string, unknown> ?? {};
    const campaignId = String(params.campaign_id ?? resolvePrev.campaign_id ?? '');
    const audienceId = String(resolvePrev.audience_id ?? '');
    const destination = String(params.destination ?? 'email_platform');
    const recordsSent = Number((stepOutputs.push_to_destination as Record<string, unknown>)?.records_pushed ?? filterPrev.eligible_count ?? 0);
    const rawTotal = Number(resolvePrev.raw_audience_count ?? 0);
    const recordsFiltered = Math.max(0, rawTotal - recordsSent);
    const filterBreakdown = filterPrev.filter_breakdown ?? {};
    const activationIdRows = await query<{ ID: string }>(`SELECT UUID_STRING() AS ID`);
    const activationId = activationIdRows[0].ID;
    const activatedByRows = await query<{ U: string }>(`SELECT CURRENT_USER() AS U`);
    const activatedBy = activatedByRows[0]?.U ?? 'workflow_service';
    await run(
      `INSERT INTO CDP.APP.ACTIVATION_RECORD
       (tenant_id, activation_id, audience_id, campaign_id, destination, activated_at, activated_by,
        records_sent, records_filtered, filter_breakdown, status, version, created_by)
       SELECT 'default', ?, ?, ?, ?, CURRENT_TIMESTAMP(), ?, ?, ?, PARSE_JSON(?), 'completed', 0, ?`,
      [activationId, audienceId, campaignId, destination, activatedBy,
       recordsSent, recordsFiltered, JSON.stringify(filterBreakdown), activatedBy],
    );
    if (campaignId) {
      await run(
        `UPDATE CDP.APP.CAMPAIGN SET status = 'active', updated_at = CURRENT_TIMESTAMP()
         WHERE campaign_id = ? AND tenant_id = 'default'`,
        [campaignId],
      );
    }
    return { logged: true, activation_id: activationId, records_sent: recordsSent, records_filtered: recordsFiltered };
  },
};

export const campaignExecutionWorkflow: WorkflowDefinition = {
  type: 'campaign_execution',
  steps: [validateCampaign, resolveAudience, applyFilters, enrich, push, logResults],
  gates: [
    {
      afterStep: 'resolve_audience',
      type: 'metric_check',
      condition: 'raw_audience_count > 0',
      onFail: 'abort',
      failMessage: 'Target audience resolved to 0 records - check audience definition and source data freshness.',
    },
    {
      afterStep: 'enrich_payload',
      type: 'human_approval',
      prompt: 'Review activation summary: eligible audience size, filter breakdown, destination mapping. Approve to push to destination.',
    },
  ],
};
