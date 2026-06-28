import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { getServerConfig } from '@/lib/server-config';
import { requireOps } from '@/lib/ingress-identity';

// OPS-only "activate dataset" action (R4): promote a dataset to the GLOBAL active
// scope (DIM_DATASETS.IS_ACTIVE flip), preserving the one-active-per-(region,
// vehicle) invariant. Consumers never reach this - they do per-session selection
// via the contextBar + F_*_SCOPED.
//
// The mutation flows through the audited synapse verb activate_dataset (Tenet 7)
// rather than a raw CALL: the verb validates the id format via its arg schema,
// binds the value, and records the call in VERB_ATTEMPT.
const DEFAULT_OPS_SCHEMA = 'FLEET_INTELLIGENCE.SYNAPSE_OPS';

async function handlePost(req: Request) {
  const g = await requireOps(req);
  if (!g.ok) {
    logger.warn('activate-dataset-denied', { user: g.user, roles: g.roles, reason: g.reason });
    return NextResponse.json({ error: g.reason ?? 'Forbidden' }, { status: g.status });
  }

  let body: { dataset_id?: string; idempotency_key?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const datasetId = String(body.dataset_id ?? '').trim();
  if (!/^[A-Za-z0-9-]+$/.test(datasetId)) {
    return NextResponse.json({ error: 'Invalid dataset_id' }, { status: 400 });
  }

  const idemKey =
    typeof body.idempotency_key === 'string' && body.idempotency_key.trim() ? body.idempotency_key.trim() : null;
  const opsSchema = getServerConfig().ops?.schema ?? DEFAULT_OPS_SCHEMA;

  try {
    // CALL <opsSchema>.activate_dataset(dataset_id, IDEMPOTENCY_KEY)
    const rows = await query<Record<string, unknown>>(
      `CALL ${opsSchema}.activate_dataset(?, ?)`,
      [datasetId, idemKey],
    );
    const raw = rows[0] ? Object.values(rows[0])[0] : null;
    let result: unknown = raw;
    if (typeof raw === 'string') {
      try {
        result = JSON.parse(raw);
      } catch {
        /* leave as string */
      }
    }
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    logger.error('activate-dataset', { datasetId }, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Activation failed' },
      { status: 500 },
    );
  }
}

export const POST = withLogging(handlePost);
