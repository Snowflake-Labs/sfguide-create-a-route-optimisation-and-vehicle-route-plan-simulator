import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { query } from '@/lib/snowflake';
import { getManifest } from '@/lib/entity-manifest';

interface LookupRequest {
  entity: string;
  query: string;
  field?: string;
  limit?: number;
}

async function handlePost(request: NextRequest): Promise<Response> {
  try {
    const req = (await request.json()) as LookupRequest;
    if (!req.entity) return NextResponse.json({ error: 'entity is required' }, { status: 400 });
    if (!req.query)  return NextResponse.json({ error: 'query is required' },  { status: 400 });

    const manifest = getManifest();
    const def = manifest.entities[req.entity];
    if (!def) {
      return NextResponse.json(
        { error: `Unknown entity: ${req.entity}. Allowed: ${Object.keys(manifest.entities).join(', ')}` },
        { status: 400 },
      );
    }

    const searchCol = req.field ?? def.unique_columns?.[0] ?? def.writable_columns[0];
    const limit     = req.limit ?? 10;
    const fqSchema  = manifest.schema;
    const softDeleteFilter = def.soft_delete ? 'AND deleted_at IS NULL' : '';
    // Select only record_id, version, and writable columns - avoids leaking
    // internal fields (tenant_id, created_by, audit timestamps) to callers.
    const selectCols = [
      `${def.primary_key} AS record_id`,
      'version',
      ...def.writable_columns,
    ].join(', ');

    const sql = `SELECT ${selectCols}
                 FROM ${fqSchema}.${def.table}
                 WHERE tenant_id = 'default'
                   ${softDeleteFilter}
                   AND ${searchCol} ILIKE ?
                 LIMIT ${limit}`;

    const rows = await query<Record<string, unknown>>(sql, [`%${req.query}%`]);
    return NextResponse.json({ rows, entity: req.entity, total: rows.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Lookup failed' },
      { status: 500 },
    );
  }
}

export const POST = withLogging(handlePost);
