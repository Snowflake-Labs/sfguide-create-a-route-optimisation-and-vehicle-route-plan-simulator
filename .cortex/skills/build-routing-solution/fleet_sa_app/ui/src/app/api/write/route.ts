import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getManifest } from '@/lib/entity-manifest';
import type { EntityDef } from '@/lib/entity-manifest';

const ACCOUNT_URL = process.env.SNOWFLAKE_ACCOUNT_URL?.replace(/\/+$/, '') || '';
const PAT = process.env.SNOWFLAKE_PAT || '';
const WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE || 'COMPUTE_WH';
const ROLE = process.env.SNOWFLAKE_ROLE || 'PUBLIC';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type Operation = 'create' | 'update' | 'delete' | 'restore';

interface WriteRequest {
  entity: string;
  operation: Operation;
  record_id?: string;
  fields?: Record<string, unknown>;
  expected_version?: number;
}

interface UndoToken {
  entity: string;
  operation: Operation;
  record_id: string;
  fields?: Record<string, unknown>;
  expected_version: number;
}

interface WriteSuccess {
  success: true;
  record_id: string;
  version: number;
  undo: UndoToken;
}

interface WriteConflict {
  success: false;
  reason: 'conflict';
  current: Record<string, unknown>;
}

interface WriteError {
  success: false;
  reason: 'error';
  error: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const COLUMN_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_OPS: Operation[] = ['create', 'update', 'delete', 'restore'];

function validateRequest(req: WriteRequest): string | null {
  if (!req.entity || typeof req.entity !== 'string') return 'entity is required';
  if (!VALID_OPS.includes(req.operation)) return `operation must be one of: ${VALID_OPS.join(', ')}`;
  if (req.operation !== 'create' && !req.record_id) return 'record_id is required for update/delete/restore';

  const manifest = getManifest();
  if (!manifest.entities[req.entity]) {
    return `unknown entity: ${req.entity}. Allowed: ${Object.keys(manifest.entities).join(', ')}`;
  }

  const def = manifest.entities[req.entity];
  if (req.fields) {
    for (const col of Object.keys(req.fields)) {
      if (!COLUMN_NAME_RE.test(col)) return `invalid field name: "${col}"`;
      if (req.operation === 'update' && !def.writable_columns.includes(col)) {
        return `field "${col}" is not writable for entity ${req.entity}`;
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snowflake execution
// ─────────────────────────────────────────────────────────────────────────────

interface SnowflakeResponse {
  statementHandle?: string;
  resultSetMetaData?: { rowType: Array<{ name: string; type: string }> };
  data?: string[][];
  message?: string;
  code?: string;
  numUpdatedRows?: number;
  numRowsInserted?: number;
}

async function runSQL(sql: string, bindings?: Record<string, { type: string; value: string }>): Promise<SnowflakeResponse> {
  const body: Record<string, unknown> = {
    statement: sql,
    timeout: 60,
    warehouse: WAREHOUSE,
    role: ROLE,
  };
  if (bindings) body.bindings = bindings;

  const res = await fetch(`${ACCOUNT_URL}/api/v2/statements`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PAT}`,
      Accept: 'application/json',
      'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Snowflake API ${res.status}: ${await res.text()}`);
  const data = await res.json() as SnowflakeResponse;

  // Poll if async
  if (data.statementHandle && !data.data && !data.resultSetMetaData) {
    return await pollHandle(data.statementHandle);
  }
  return data;
}

async function pollHandle(handle: string): Promise<SnowflakeResponse> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`${ACCOUNT_URL}/api/v2/statements/${handle}`, {
      headers: {
        Authorization: `Bearer ${PAT}`,
        Accept: 'application/json',
        'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
      },
    });
    if (!res.ok) throw new Error(`Poll error ${res.status}`);
    const data = await res.json() as SnowflakeResponse;
    if (data.data || data.resultSetMetaData) return data;
    if (data.message?.includes('error') || data.code === '000625') throw new Error(data.message || 'Statement failed');
  }
  throw new Error('Statement timed out');
}

function rowToObject(row: string[], cols: Array<{ name: string; type: string }>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  cols.forEach((col, i) => {
    const raw = row[i];
    const key = col.name.toLowerCase();
    if (raw === null || raw === undefined) { obj[key] = null; return; }
    if (col.type === 'fixed' || col.type === 'real') { obj[key] = Number(raw); return; }
    if (col.type === 'boolean') { obj[key] = raw === 'true' || raw === '1'; return; }
    obj[key] = raw;
  });
  return obj;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write operations
// ─────────────────────────────────────────────────────────────────────────────

async function handleCreate(
  def: EntityDef,
  fqSchema: string,
  fields: Record<string, unknown>,
  tenantId: string,
  createdBy: string,
  entityName: string,
): Promise<WriteSuccess | WriteError> {
  const { primary_key: pk, table } = def;

  // Check unique_columns before inserting
  if (def.unique_columns?.length) {
    for (const col of def.unique_columns) {
      const val = fields[col];
      if (val == null) continue;
      const escaped = String(val).replace(/'/g, "''");
      const check = await runSQL(
        `SELECT 1 FROM ${fqSchema}.${table} WHERE tenant_id = '${tenantId}' AND ${col} = '${escaped}' AND deleted_at IS NULL LIMIT 1`
      );
      if (check.data?.[0]) {
        return { success: false, reason: 'error', error: `A ${entityName} named "${val}" already exists. Choose a different name.` } satisfies WriteError;
      }
    }
  }

  // Generate a new UUID for the PK via Snowflake
  const uuidRes = await runSQL('SELECT UUID_STRING() AS id');
  const newId = uuidRes.data?.[0]?.[0] ?? crypto.randomUUID();

  const writableCols = def.writable_columns.filter((c) => c in fields);
  const allCols = [pk, 'tenant_id', 'created_by', 'version', 'created_at', 'updated_at', ...writableCols];
  const allVals = [`'${newId}'`, `'${tenantId}'`, `'${createdBy.replace(/'/g, "''")}'`, '0', 'CURRENT_TIMESTAMP()', 'CURRENT_TIMESTAMP()',
    ...writableCols.map((c) => {
      const v = fields[c];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (typeof v === 'object') return `PARSE_JSON('${JSON.stringify(v).replace(/'/g, "''")}')`;
      return `'${String(v).replace(/'/g, "''")}'`;
    }),
  ];

  await runSQL(`INSERT INTO ${fqSchema}.${table} (${allCols.join(', ')}) VALUES (${allVals.join(', ')})`);

  return {
    success: true,
    record_id: newId,
    version: 0,
    undo: { entity: entityName, operation: 'delete', record_id: newId, expected_version: 0 },
  };
}

async function handleUpdate(
  def: EntityDef,
  fqSchema: string,
  recordId: string,
  fields: Record<string, unknown>,
  expectedVersion: number | undefined,
  tenantId: string,
  entityName: string,
): Promise<WriteSuccess | WriteConflict> {
  const { primary_key: pk, table } = def;
  const safeId = recordId.replace(/'/g, "''");

  // Snapshot current values for undo (and to resolve version when not provided)
  const snapshotCols = Object.keys(fields).filter((c) => def.writable_columns.includes(c));
  const selectSQL = `SELECT ${[...snapshotCols, 'version'].join(', ')} FROM ${fqSchema}.${table} WHERE ${pk} = '${safeId}' AND tenant_id = '${tenantId}'`;
  const snap = await runSQL(selectSQL);
  if (!snap.data?.length) {
    return { success: false, reason: 'conflict', current: {} };
  }
  const snapCols = snap.resultSetMetaData?.rowType ?? ([...snapshotCols, { name: 'version', type: 'fixed' }] as Array<string | { name: string; type: string }>).map((n) => typeof n === 'string' ? { name: n, type: 'text' } : n);
  const prevRow = rowToObject(snap.data[0], snapCols as Array<{ name: string; type: string }>);

  // Always use the current version from the DB snapshot — the client's expected_version
  // is informational only. This gives "last write wins" semantics which is appropriate
  // for a single-user conversational app. Concurrent conflict detection can be added
  // later if needed (e.g. strict mode flag on the request).
  const resolvedVersion = Number(prevRow.version ?? 0);

  // Build SET clause
  const setClauses = [
    ...snapshotCols.map((c) => {
      const v = fields[c];
      if (v === null || v === undefined) return `${c} = NULL`;
      if (typeof v === 'number' || typeof v === 'boolean') return `${c} = ${v}`;
      if (typeof v === 'object') return `${c} = PARSE_JSON('${JSON.stringify(v).replace(/'/g, "''")}')`;
      return `${c} = '${String(v).replace(/'/g, "''")}'`;
    }),
    'version = version + 1',
    'updated_at = CURRENT_TIMESTAMP()',
  ];

  const updateSQL = `UPDATE ${fqSchema}.${table} SET ${setClauses.join(', ')} WHERE ${pk} = '${safeId}' AND tenant_id = '${tenantId}' AND version = ${resolvedVersion}`;
  const updateRes = await runSQL(updateSQL);

  // Detect conflict: 0 rows updated means version mismatch
  const rowsUpdated = updateRes.numUpdatedRows ?? (updateRes.data?.[0]?.[0] ? Number(updateRes.data[0][0]) : 0);
  if (rowsUpdated === 0) {
    // Fetch current state to surface in conflict response
    const conflictCols = [pk, 'version', ...def.writable_columns];
    const currentRes = await runSQL(`SELECT ${conflictCols.join(', ')} FROM ${fqSchema}.${table} WHERE ${pk} = '${safeId}' AND tenant_id = '${tenantId}'`);
    const currentCols = currentRes.resultSetMetaData?.rowType ?? conflictCols.map((n) => ({ name: n, type: 'text' }));
    const current = currentRes.data?.[0] ? rowToObject(currentRes.data[0], currentCols) : {};
    return { success: false, reason: 'conflict', current };
  }

  const newVersion = resolvedVersion + 1;
  // Build undo fields from snapshot (previous values)
  const undoFields: Record<string, unknown> = {};
  for (const c of snapshotCols) undoFields[c] = prevRow[c];

  return {
    success: true,
    record_id: safeId,
    version: newVersion,
    undo: { entity: entityName, operation: 'update', record_id: safeId, fields: undoFields, expected_version: newVersion },
  };
}

async function handleDelete(
  def: EntityDef,
  fqSchema: string,
  recordId: string,
  expectedVersion: number | undefined,
  tenantId: string,
  entityName: string,
): Promise<WriteSuccess | WriteConflict> {
  const { primary_key: pk, table } = def;

  // Resolve version when not provided
  const safeId = recordId.replace(/'/g, "''");
  let resolvedVersion = expectedVersion;
  if (resolvedVersion === undefined) {
    const snap = await runSQL(`SELECT version FROM ${fqSchema}.${table} WHERE ${pk} = '${safeId}' AND tenant_id = '${tenantId}' AND deleted_at IS NULL`);
    resolvedVersion = Number(snap.data?.[0]?.[0] ?? 0);
  }

  const sql = `UPDATE ${fqSchema}.${table} SET deleted_at = CURRENT_TIMESTAMP(), version = version + 1, updated_at = CURRENT_TIMESTAMP() WHERE ${pk} = '${safeId}' AND tenant_id = '${tenantId}' AND version = ${resolvedVersion} AND deleted_at IS NULL`;
  const res = await runSQL(sql);
  const rowsUpdated = res.numUpdatedRows ?? (res.data?.[0]?.[0] ? Number(res.data[0][0]) : 0);

  if (rowsUpdated === 0) {
    const conflictCols = [pk, 'version', 'deleted_at', ...def.writable_columns];
    const currentRes = await runSQL(`SELECT ${conflictCols.join(', ')} FROM ${fqSchema}.${table} WHERE ${pk} = '${safeId}' AND tenant_id = '${tenantId}'`);
    const currentCols = currentRes.resultSetMetaData?.rowType ?? conflictCols.map((n) => ({ name: n, type: 'text' }));
    const current = currentRes.data?.[0] ? rowToObject(currentRes.data[0], currentCols) : {};
    if (current.deleted_at) {
      return { success: true, record_id: safeId, version: resolvedVersion + 1, undo: { entity: entityName, operation: 'restore', record_id: safeId, expected_version: resolvedVersion + 1 } } as WriteSuccess;
    }
    return { success: false, reason: 'conflict', current };
  }

  return {
    success: true,
    record_id: safeId,
    version: resolvedVersion + 1,
    undo: { entity: entityName, operation: 'restore', record_id: safeId, expected_version: resolvedVersion + 1 },
  };
}

async function handleRestore(
  def: EntityDef,
  fqSchema: string,
  recordId: string,
  expectedVersion: number | undefined,
  tenantId: string,
  entityName: string,
): Promise<WriteSuccess | WriteConflict> {
  const { primary_key: pk, table } = def;

  // Resolve version when not provided
  const safeId = recordId.replace(/'/g, "''");
  let resolvedVersion = expectedVersion;
  if (resolvedVersion === undefined) {
    const snap = await runSQL(`SELECT version FROM ${fqSchema}.${table} WHERE ${pk} = '${safeId}' AND tenant_id = '${tenantId}'`);
    resolvedVersion = Number(snap.data?.[0]?.[0] ?? 0);
  }

  const sql = `UPDATE ${fqSchema}.${table} SET deleted_at = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP() WHERE ${pk} = '${safeId}' AND tenant_id = '${tenantId}' AND version = ${resolvedVersion}`;
  const res = await runSQL(sql);
  const rowsUpdated = res.numUpdatedRows ?? (res.data?.[0]?.[0] ? Number(res.data[0][0]) : 0);

  if (rowsUpdated === 0) {
    const conflictCols = [pk, 'version', ...def.writable_columns];
    const currentRes = await runSQL(`SELECT ${conflictCols.join(', ')} FROM ${fqSchema}.${table} WHERE ${pk} = '${safeId}' AND tenant_id = '${tenantId}'`);
    const currentCols = currentRes.resultSetMetaData?.rowType ?? conflictCols.map((n) => ({ name: n, type: 'text' }));
    const current = currentRes.data?.[0] ? rowToObject(currentRes.data[0], currentCols) : {};
    return { success: false, reason: 'conflict', current };
  }

  return {
    success: true,
    record_id: safeId,
    version: resolvedVersion + 1,
    undo: { entity: entityName, operation: 'delete', record_id: safeId, expected_version: resolvedVersion + 1 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

async function handlePost(request: NextRequest): Promise<Response> {
  try {
    if (!ACCOUNT_URL || !PAT) {
      return NextResponse.json({ error: 'Snowflake credentials not configured' }, { status: 500 });
    }

    const req = (await request.json()) as WriteRequest;
    const validationError = validateRequest(req);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const manifest = getManifest();
    const def = manifest.entities[req.entity];
    const fqSchema = manifest.schema;

    // tenant_id and created_by are always injected server-side — never trusted from client
    const tenantId = 'default'; // TODO: resolve from auth session when multi-tenancy is enabled
    const createdBy = ROLE || 'app_user'; // Use the configured role as the user identity

    let result: WriteSuccess | WriteConflict | WriteError;

    switch (req.operation) {
      case 'create':
        result = await handleCreate(def, fqSchema, req.fields ?? {}, tenantId, createdBy, req.entity);
        break;
      case 'update':
        result = await handleUpdate(def, fqSchema, req.record_id!, req.fields ?? {}, req.expected_version, tenantId, req.entity);
        break;
      case 'delete':
        result = await handleDelete(def, fqSchema, req.record_id!, req.expected_version, tenantId, req.entity);
        break;
      case 'restore':
        result = await handleRestore(def, fqSchema, req.record_id!, req.expected_version, tenantId, req.entity);
        break;
    }

    return NextResponse.json(result);
  } catch (err) {
    logger.error('write-error', {}, err);
    return NextResponse.json(
      { success: false, reason: 'error', error: err instanceof Error ? err.message : 'Write failed' } satisfies WriteError,
      { status: 500 },
    );
  }
}

export const POST = withLogging(handlePost);
