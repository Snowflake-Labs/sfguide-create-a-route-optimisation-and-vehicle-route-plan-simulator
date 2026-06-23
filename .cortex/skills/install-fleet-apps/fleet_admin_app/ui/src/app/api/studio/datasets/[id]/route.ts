import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { runSql } from '@/server/lib/sql';
import { renameDataset, deleteDataset } from '@/server/studio/jobs';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = withLogging(async (req: NextRequest, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ id: string }> };
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const label = typeof body?.label === 'string' ? body.label : '';
    if (!label.trim()) return NextResponse.json({ error: 'label required' }, { status: 400 });
    const result = await renameDataset(runSql, id, label);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
});

export const DELETE = withLogging(async (req, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ id: string }> };
  const { id } = await params;
  try {
    const result = await deleteDataset(runSql, id);
    return NextResponse.json(result);
  } catch (e) {
    const msg = (e as Error).message || '';
    if (/Refusing to delete/i.test(msg)) return NextResponse.json({ error: msg }, { status: 409 });
    const status = /not found/i.test(msg) ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
});
