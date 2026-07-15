import { query, run } from '@/lib/snowflake';

// Workflow instances table - resolved from env vars set in service-spec.yaml.
// AGENT_DATABASE / AGENT_SCHEMA must be set (same values used by the rest of the app).
const WF_DB = process.env.AGENT_DATABASE ?? 'APP';
const WF_SCHEMA = process.env.AGENT_SCHEMA ?? 'PUBLIC';
const WF_TABLE = `${WF_DB}.${WF_SCHEMA}.WORKFLOW_INSTANCES`;

export type WorkflowStatus = 'running' | 'paused_at_gate' | 'completed' | 'failed';

export interface WorkflowStep {
  name: string;
  execute: (instanceId: string, params: Record<string, unknown>, stepOutputs: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface WorkflowGate {
  afterStep: string;
  type: 'human_approval' | 'metric_check';
  prompt?: string;
  condition?: string;
  failMessage?: string;
  onFail?: 'abort' | 'warn_and_pause';
}

export interface WorkflowDefinition {
  type: string;
  steps: WorkflowStep[];
  gates: WorkflowGate[];
}

export interface WorkflowResult {
  instance_id: string;
  status: WorkflowStatus;
  message?: string;
  reason?: string;
  step?: string;
  gate_context?: Record<string, unknown>;
  step_outputs?: Record<string, unknown>;
  pending_approval?: { instance_id: string; prompt: string; message: string };
}

export async function createInstance(
  workflowType: string,
  params: Record<string, unknown>,
  startedBy: string,
): Promise<string> {
  const instanceId = crypto.randomUUID();
  await run(
    `INSERT INTO ${WF_TABLE}
     (instance_id, workflow_type, status, current_step_index, step_outputs, params, started_by)
     SELECT ?, ?, 'running', 0, PARSE_JSON('{}'), PARSE_JSON(?), ?`,
    [instanceId, workflowType, JSON.stringify(params), startedBy],
  );
  return instanceId;
}

async function updateInstance(
  instanceId: string,
  status: WorkflowStatus,
  stepIndex: number,
  stepOutputs: Record<string, unknown>,
  gateContext?: Record<string, unknown>,
): Promise<void> {
  if (gateContext) {
    await run(
      `UPDATE ${WF_TABLE} SET
       step_outputs = PARSE_JSON(?), current_step_index = ?, status = ?,
       gate_context = PARSE_JSON(?), updated_at = CURRENT_TIMESTAMP()
       WHERE instance_id = ?`,
      [JSON.stringify(stepOutputs), stepIndex, status, JSON.stringify(gateContext), instanceId],
    );
  } else {
    await run(
      `UPDATE ${WF_TABLE} SET
       step_outputs = PARSE_JSON(?), current_step_index = ?, status = ?,
       updated_at = CURRENT_TIMESTAMP()
       WHERE instance_id = ?`,
      [JSON.stringify(stepOutputs), stepIndex, status, instanceId],
    );
  }
}

function evaluateMetricCondition(condition: string, ctx: Record<string, unknown>): boolean {
  const ops = ['>=', '<=', '!=', '>', '<', '='];
  for (const op of ops) {
    const idx = condition.indexOf(op);
    if (idx === -1) continue;
    const varName = condition.substring(0, idx).trim();
    const threshold = parseFloat(condition.substring(idx + op.length).trim());
    const actual = parseFloat(String(ctx[varName]));
    if (isNaN(actual) || isNaN(threshold)) return false;
    if (op === '>') return actual > threshold;
    if (op === '>=') return actual >= threshold;
    if (op === '<') return actual < threshold;
    if (op === '<=') return actual <= threshold;
    if (op === '=') return actual === threshold;
    if (op === '!=') return actual !== threshold;
  }
  return condition.trim() === 'true';
}

export async function executeWorkflow(
  definition: WorkflowDefinition,
  instanceId: string,
  params: Record<string, unknown>,
  startFromIndex = 0,
): Promise<WorkflowResult> {
  const stepOutputs: Record<string, unknown> = {};

  if (startFromIndex > 0) {
    const rows = await query<{ STEP_OUTPUTS: unknown }>(
      `SELECT step_outputs FROM ${WF_TABLE} WHERE instance_id = ?`,
      [instanceId],
    );
    const raw = rows[0]?.STEP_OUTPUTS ?? {};
    const existing: Record<string, unknown> = typeof raw === 'string'
      ? (() => { try { return JSON.parse(raw); } catch { return {}; } })()
      : (raw as Record<string, unknown>);
    Object.assign(stepOutputs, existing);
  }

  const gateByStep = new Map(definition.gates.map((g) => [g.afterStep, g]));

  for (let i = startFromIndex; i < definition.steps.length; i++) {
    const step = definition.steps[i];
    let stepResult: Record<string, unknown>;
    try {
      stepResult = await step.execute(instanceId, params, stepOutputs);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await updateInstance(instanceId, 'failed', i, stepOutputs);
      return { instance_id: instanceId, status: 'failed', step: step.name, reason };
    }

    stepOutputs[step.name] = stepResult;
    await updateInstance(instanceId, 'running', i, stepOutputs);

    const gate = gateByStep.get(step.name);
    if (!gate) continue;

    if (gate.type === 'metric_check') {
      const flatCtx: Record<string, unknown> = {};
      for (const v of Object.values(stepOutputs)) {
        if (v && typeof v === 'object') Object.assign(flatCtx, v);
      }
      const passed = gate.condition ? evaluateMetricCondition(gate.condition, flatCtx) : true;
      if (!passed) {
        if ((gate.onFail ?? 'abort') === 'abort') {
          await updateInstance(instanceId, 'failed', i, stepOutputs);
          return { instance_id: instanceId, status: 'failed', reason: gate.failMessage ?? `Metric check failed after step: ${step.name}` };
        }
      }
    }

    if (gate.type === 'human_approval' || (gate.type === 'metric_check' && gate.onFail === 'warn_and_pause')) {
      const gateContext: Record<string, unknown> = {
        step_outputs_summary: stepOutputs,
        prompt: gate.prompt ?? 'Review before continuing.',
        paused_after_step: step.name,
      };
      await updateInstance(instanceId, 'paused_at_gate', i, stepOutputs, gateContext);
      return {
        instance_id: instanceId,
        status: 'completed',
        pending_approval: {
          instance_id: instanceId,
          prompt: gate.prompt ?? 'Review before continuing.',
          message: 'Workflow paused for your approval. Say "approve" or "reject", or use the Workflow Manager.',
        },
        step_outputs: stepOutputs,
      };
    }
  }

  await updateInstance(instanceId, 'completed', definition.steps.length - 1, stepOutputs);
  return { instance_id: instanceId, status: 'completed', step_outputs: stepOutputs };
}
