import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { executeWorkflow } from '@/lib/workflow/engine';
import { getWorkflow } from '@/lib/workflow/registry';
import '@/lib/workflow/app-workflows'; // side-effect: registers app workflows
import { query } from '@/lib/snowflake';

// Resolved from the same env vars as the workflow engine
const WF_DB = process.env.AGENT_DATABASE ?? 'APP';
const WF_SCHEMA = process.env.AGENT_SCHEMA ?? 'PUBLIC';
const WF_TABLE = `${WF_DB}.${WF_SCHEMA}.WORKFLOW_INSTANCES`;

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const { instance_id, decision } = await req.json() as { instance_id?: string; decision?: string };
    if (!instance_id) return NextResponse.json({ error: 'instance_id is required' }, { status: 400 });
    if (decision !== 'approved' && decision !== 'rejected') {
      return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });
    }

    const rows = await query<{ WORKFLOW_TYPE: string; STATUS: string; CURRENT_STEP_INDEX: number; PARAMS: unknown }>(
      `SELECT workflow_type, status, current_step_index, params FROM ${WF_TABLE} WHERE instance_id = ?`,
      [instance_id],
    );
    if (!rows[0]) return NextResponse.json({ error: `Instance not found: ${instance_id}` }, { status: 404 });

    const { WORKFLOW_TYPE, STATUS, CURRENT_STEP_INDEX } = rows[0];
    const PARAMS: Record<string, unknown> = typeof rows[0].PARAMS === 'string'
      ? (() => { try { return JSON.parse(rows[0].PARAMS as string); } catch { return {}; } })()
      : (rows[0].PARAMS as Record<string, unknown> ?? {});

    if (STATUS !== 'paused_at_gate') {
      return NextResponse.json({ error: `Instance ${instance_id} is not paused (status: ${STATUS})` }, { status: 409 });
    }

    if (decision === 'rejected') {
      await query(`UPDATE ${WF_TABLE} SET status = 'rejected', updated_at = CURRENT_TIMESTAMP() WHERE instance_id = ?`, [instance_id]);
      return NextResponse.json({ instance_id, status: 'rejected', message: 'Workflow rejected.' });
    }

    const def = getWorkflow(WORKFLOW_TYPE);
    if (!def) return NextResponse.json({ error: `Unknown workflow type: ${WORKFLOW_TYPE}` }, { status: 400 });

    await query(`UPDATE ${WF_TABLE} SET status = 'running', updated_at = CURRENT_TIMESTAMP() WHERE instance_id = ?`, [instance_id]);
    const result = await executeWorkflow(def, instance_id, PARAMS, CURRENT_STEP_INDEX + 1);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withLogging(handlePost);
