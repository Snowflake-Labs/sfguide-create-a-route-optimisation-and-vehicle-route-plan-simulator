import { NextRequest, NextResponse } from 'next/server';
import { createInstance, executeWorkflow } from '@/lib/workflow/engine';
import { getWorkflow } from '@/lib/workflow/registry';
import '@/lib/workflow/app-workflows'; // side-effect: registers app workflows
import { withLogging } from '@/lib/api-handler';

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const { workflow_type, params: rawParams } = await req.json() as { workflow_type?: string; params?: unknown };
    if (!workflow_type) return NextResponse.json({ error: 'workflow_type is required' }, { status: 400 });
    const params = typeof rawParams === 'string' ? JSON.parse(rawParams) : (rawParams ?? {});
    const def = getWorkflow(workflow_type);
    if (!def) return NextResponse.json({ error: `Unknown workflow_type: ${workflow_type}` }, { status: 400 });
    const instanceId = await createInstance(workflow_type, params, 'ui');
    const result = await executeWorkflow(def, instanceId, params, 0);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = withLogging(handlePost);
