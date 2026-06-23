import { NextResponse } from 'next/server';
import { withLogging } from '@/lib/api-handler';
import { requireOps } from '@/lib/ingress-identity';
import { appRoleFromSnowflakeRoles } from '@/lib/roles';

// Returns the end-user's identity and detected role tier (user/ops/admin) from
// the SPCS ingress identity. The role dropdown seeds its default from this, but
// still lets the operator pick any role to evaluate (simulated view filter).
// In local dev (no ingress header) the gate fails open with empty roles, so the
// detected role defaults to 'user'.
async function handleGet(req: Request) {
  // requireOps runs SHOW GRANTS and returns the user's roles regardless of the
  // gate outcome, so we reuse it purely to resolve identity + roles here.
  const g = await requireOps(req);
  const detectedRole = appRoleFromSnowflakeRoles(g.roles);
  return NextResponse.json({
    user: g.user,
    roles: g.roles,
    detectedRole,
  });
}

export const GET = withLogging(handleGet);
