import { NextResponse } from 'next/server';
import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';
import { withLogging } from '@/lib/api-handler';
import { requireOps } from '@/lib/ingress-identity';

// OPS-only "activate dataset" action (R4): promote a dataset to the GLOBAL active
// scope (DIM_DATASETS.IS_ACTIVE flip) via FLEET_INTELLIGENCE.CORE.ACTIVATE_DATASET,
// which preserves the one-active-per-(region,vehicle) invariant. Consumers never
// reach this — they do per-session selection via the contextBar + F_*_SCOPED.
async function handlePost(req: Request) {
  const g = await requireOps(req);
  if (!g.ok) {
    logger.warn('activate-dataset-denied', { user: g.user, roles: g.roles, reason: g.reason });
    return NextResponse.json({ error: g.reason ?? 'Forbidden' }, { status: g.status });
  }

  let body: { dataset_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const datasetId = String(body.dataset_id ?? '').trim();
  if (!/^[A-Za-z0-9-]+$/.test(datasetId)) {
    return NextResponse.json({ error: 'Invalid dataset_id' }, { status: 400 });
  }

  try {
    const rows = await query<Record<string, unknown>>(
      'CALL FLEET_INTELLIGENCE.CORE.ACTIVATE_DATASET(?)',
      [datasetId],
    );
    const result = rows[0] ? Object.values(rows[0])[0] : null;
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
