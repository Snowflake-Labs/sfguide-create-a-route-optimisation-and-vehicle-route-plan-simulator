import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { createInstance, executeWorkflow } from '@/lib/workflow/engine';
import { getWorkflow, listWorkflows } from '@/lib/workflow/registry';
import '@/lib/workflow/app-workflows'; // side-effect: registers app workflows
import { query } from '@/lib/snowflake';
import { getManifest } from '@/lib/entity-manifest';

const WF_DB = process.env.AGENT_DATABASE ?? 'APP';
const WF_SCHEMA = process.env.AGENT_SCHEMA ?? 'PUBLIC';
const WF_TABLE = `${WF_DB}.${WF_SCHEMA}.WORKFLOW_INSTANCES`;
const SERVICE_NAME = process.env.APP_NAME ?? 'data-app-workflow-service';

// Tool list is built dynamically so the descriptions reflect registered workflows.
function buildTools() {
  const registered = listWorkflows().map(w => w.type).join(' | ');
  return [
    {
      name: 'lookup_entity',
      description: 'REQUIRED before update, delete, or restore. Searches transactional entity records by name and returns record_id, version, and all fields. Always call this first — the record_id and version in the result are what propose_write needs. Do NOT use cortex_analyst_text_to_sql to find records for writes.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_name: { type: 'string', description: 'PascalCase entity key: Audience, Campaign, OfferCatalogue, SignalLibrary' },
          name_query:  { type: 'string', description: 'Partial name to search (case-insensitive)' },
        },
        required: ['entity_name', 'name_query'],
      },
    },
    {
      name: 'propose_write',
      description: 'Stage a create, update, delete, or restore for user confirmation. REQUIRED: call lookup_entity first to get record_id and version for update/delete/restore. Returns pending_confirmation — the UI will show a confirmation dialog before executing the write.',
      inputSchema: {
        type: 'object',
        properties: {
          entity:    { type: 'string', description: 'PascalCase entity key (e.g. Audience, Campaign)' },
          operation: { type: 'string', enum: ['create', 'update', 'delete', 'restore'] },
          record_id: { type: 'string', description: 'PK value from lookup_entity. Empty string for create.' },
          fields:    { type: 'string', description: 'JSON-encoded fields object, e.g. {"status":"active"}' },
        },
        required: ['entity', 'operation', 'fields', 'record_id'],
      },
    },
    {
      name: 'execute_workflow',
      description: `Execute a business workflow deterministically. Registered types: ${registered || '(none registered)'}.`,
      inputSchema: {
        type: 'object',
        properties: {
          workflow_type: { type: 'string', description: registered || 'workflow type' },
          params: { type: 'string', description: 'JSON-encoded workflow parameters' },
        },
        required: ['workflow_type', 'params'],
      },
    },
    {
      name: 'resume_workflow',
      description: 'Resume a workflow paused at a human approval gate.',
      inputSchema: {
        type: 'object',
        properties: {
          instance_id: { type: 'string' },
          decision: { type: 'string', enum: ['approved', 'rejected'] },
        },
        required: ['instance_id', 'decision'],
      },
    },
  ];
}

async function handleLookupEntity(args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const entityName = String(args.entity_name ?? '');
  const nameQuery  = String(args.name_query  ?? '');

  const manifest = getManifest();
  const def = manifest.entities[entityName];
  if (!def) throw new Error(`Unknown entity: ${entityName}. Allowed: ${Object.keys(manifest.entities).join(', ')}`);

  const nameCol  = def.unique_columns?.[0] ?? def.writable_columns[0];
  const fqSchema = manifest.schema;
  const softDeleteFilter = def.soft_delete ? 'AND deleted_at IS NULL' : '';
  // Select only record_id, version, and writable columns — avoids leaking internal
  // fields (tenant_id, created_by, deleted_at, audit timestamps) into the agent context.
  const selectCols = [
    `${def.primary_key} AS record_id`,
    'version',
    ...def.writable_columns,
  ].join(', ');
  const sql = `SELECT ${selectCols}
               FROM ${fqSchema}.${def.table}
               WHERE tenant_id = 'default'
                 ${softDeleteFilter}
                 AND ${nameCol} ILIKE ?
               LIMIT 10`;

  const rows = await query<Record<string, unknown>>(sql, [`%${nameQuery}%`]);
  if (rows.length === 0) return [{ message: `No ${entityName} found matching "${nameQuery}"` }];
  return rows.map(r => ({ entity: entityName, ...r }));
}

async function handleProposeWrite(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entity    = String(args.entity    ?? '');
  const operation = String(args.operation ?? '');
  const recordId  = String(args.record_id ?? '');
  const fields    = typeof args.fields === 'string'
    ? (() => { try { return JSON.parse(args.fields as string); } catch { return {}; } })()
    : (args.fields ?? {});

  const manifest = getManifest();
  if (!manifest.entities[entity]) throw new Error(`Unknown entity: ${entity}. Allowed: ${Object.keys(manifest.entities).join(', ')}`);

  const VALID_OPS = ['create', 'update', 'delete', 'restore'] as const;
  if (!VALID_OPS.includes(operation as typeof VALID_OPS[number])) {
    throw new Error(`Invalid operation: "${operation}". Must be one of: ${VALID_OPS.join(', ')}`);
  }

  const opLabel: Record<string, string> = { create: 'Create', update: 'Update', delete: 'Delete', restore: 'Restore' };
  const fieldNames = Object.keys(fields as Record<string, unknown>).slice(0, 3).join(', ');
  const summary = `${opLabel[operation] ?? operation} ${entity}${fieldNames ? `: set ${fieldNames}` : ''}`;

  return {
    status: 'pending_confirmation',
    summary,
    write_payload: { entity, operation, record_id: recordId || null, fields },
  };
}

async function handleExecuteWorkflow(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const workflowType = String(args.workflow_type ?? '');
  const params = typeof args.params === 'string' ? JSON.parse(args.params) : (args.params ?? {});
  const def = getWorkflow(workflowType);
  if (!def) {
    const available = listWorkflows().map(w => w.type).join(', ');
    throw new Error(`Unknown workflow_type: ${workflowType}. Available: ${available || '(none)'}`);
  }
  const instanceId = await createInstance(workflowType, params, 'cortex_agent');
  const result = await executeWorkflow(def, instanceId, params, 0);
  return result as unknown as Record<string, unknown>;
}

async function handleResumeWorkflow(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const instanceId = String(args.instance_id ?? '');
  const decision = String(args.decision ?? '');
  if (!instanceId) throw new Error('instance_id is required');
  if (decision !== 'approved' && decision !== 'rejected') throw new Error("decision must be 'approved' or 'rejected'");

  const rows = await query<{ WORKFLOW_TYPE: string; STATUS: string; CURRENT_STEP_INDEX: number; PARAMS: unknown }>(
    `SELECT workflow_type, status, current_step_index, params FROM ${WF_TABLE} WHERE instance_id = ?`,
    [instanceId],
  );
  if (!rows[0]) throw new Error(`Instance not found: ${instanceId}`);
  const { WORKFLOW_TYPE, STATUS, CURRENT_STEP_INDEX } = rows[0];
  const PARAMS: Record<string, unknown> = typeof rows[0].PARAMS === 'string'
    ? (() => { try { return JSON.parse(rows[0].PARAMS as string); } catch { return {}; } })()
    : (rows[0].PARAMS as Record<string, unknown> ?? {});

  if (STATUS !== 'paused_at_gate') throw new Error(`Instance ${instanceId} is not paused (status: ${STATUS})`);

  if (decision === 'rejected') {
    await query(`UPDATE ${WF_TABLE} SET status = 'rejected', updated_at = CURRENT_TIMESTAMP() WHERE instance_id = ?`, [instanceId]);
    return { instance_id: instanceId, status: 'rejected', message: 'Workflow rejected.' };
  }

  const def = getWorkflow(WORKFLOW_TYPE);
  if (!def) throw new Error(`Unknown workflow type: ${WORKFLOW_TYPE}`);
  await query(`UPDATE ${WF_TABLE} SET status = 'running', updated_at = CURRENT_TIMESTAMP() WHERE instance_id = ?`, [instanceId]);
  const result = await executeWorkflow(def, instanceId, PARAMS, CURRENT_STEP_INDEX + 1);
  return result as unknown as Record<string, unknown>;
}

async function handlePost(req: NextRequest): Promise<Response> {
  try {
    const body = await req.json() as { jsonrpc: string; id: unknown; method: string; params?: Record<string, unknown> };
    const { jsonrpc, id, method, params } = body;

    if (jsonrpc !== '2.0') {
      return NextResponse.json({ error: 'Only JSON-RPC 2.0 is supported' }, { status: 400 });
    }

    const reply = (result: unknown) => NextResponse.json({ jsonrpc: '2.0', id, result });
    const replyError = (code: number, message: string) => NextResponse.json({ jsonrpc: '2.0', id, error: { code, message } });

    if (method === 'initialize') {
      return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: SERVICE_NAME, version: '1.0.0' } });
    }
    if (method === 'notifications/initialized') {
      return new NextResponse(null, { status: 200 });
    }
    if (method === 'tools/list') {
      return reply({ tools: buildTools() });
    }
    if (method === 'tools/call') {
      const toolName = String((params as { name?: string })?.name ?? '');
      const args = ((params as { arguments?: Record<string, unknown> })?.arguments ?? {}) as Record<string, unknown>;
      let result: Record<string, unknown>;
      if (toolName === 'lookup_entity')  result = { rows: await handleLookupEntity(args) };
      else if (toolName === 'propose_write')  result = await handleProposeWrite(args);
      else if (toolName === 'execute_workflow') result = await handleExecuteWorkflow(args);
      else if (toolName === 'resume_workflow') result = await handleResumeWorkflow(args);
      else return replyError(-32601, `Unknown tool: ${toolName}`);
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    }

    return replyError(-32601, `Method not found: ${method}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message } });
  }
}

export const POST = withLogging(handlePost);
