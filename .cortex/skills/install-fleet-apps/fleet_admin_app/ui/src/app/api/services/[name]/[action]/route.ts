import { NextRequest, NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { SF_DATABASE } from '@/server/constants';
import { runSql } from '@/server/lib/sql';
import { sanitizeIdentifier, escapeString } from '@/server/lib/sanitize';
import { requireOps } from '@/lib/ingress-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Services that must never be suspended from within this app (would kill the
// request mid-flight): the two control apps that serve the UIs.
const SELF_PROTECTED = new Set(['FLEET_ADMIN_APP', 'FLEET_SA_APP']);

export const POST = withLogging(async (req: NextRequest, ctx?: unknown) => {
  const gate = await requireOps(req);
  if (!gate.ok) return NextResponse.json({ status: 'error', error: gate.reason || 'Forbidden' }, { status: gate.status });
  const { params } = ctx as { params: Promise<{ name: string; action: string }> };
  const { name: rawName, action } = await params;
  try {
    const name = sanitizeIdentifier(rawName);
    if (action !== 'resume' && action !== 'suspend') {
      return NextResponse.json({ status: 'error', error: `Unknown action: ${action}` }, { status: 400 });
    }
    if (action === 'suspend' && SELF_PROTECTED.has(name.toUpperCase())) {
      return NextResponse.json({ status: 'error', error: `${name} cannot be suspended from itself` }, { status: 400 });
    }
    const proc = action === 'resume' ? 'RESUME_SERVICE' : 'SUSPEND_SERVICE';
    const rows = await runSql(`CALL ${SF_DATABASE}.CORE.${proc}('${escapeString(name)}')`);
    const raw = rows?.[0]?.[Object.keys(rows[0] || {})[0]] || '{}';
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed.status === 'error') return NextResponse.json(parsed, { status: 400 });
    return NextResponse.json(parsed);
  } catch (err) {
    return NextResponse.json({ status: 'error', error: (err as Error).message }, { status: 400 });
  }
});
