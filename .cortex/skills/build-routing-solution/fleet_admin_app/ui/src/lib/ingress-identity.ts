import { runSql } from '@/server/lib/sql';
import { logger } from '@/lib/logger';

// Per-user role gating via SPCS ingress identity (R3 / 4D) for the ADMIN app.
//
// FLEET_ADMIN_APP runs as ONE SPCS service identity, so every privileged build
// verb (provision region, build matrix, generate dataset, set routing limits)
// executes as the service role regardless of the end user. To stop a non-admin
// from invoking these, we read the ingress-injected end-user login
// (`Sf-Context-Current-User`) and check whether that Snowflake user is bound to
// an ADMIN (or OPS) app role before allowing the privileged action.
//
// Posture (accelerator now, product-ready seams):
//   - Deployed (SPCS, SNOWFLAKE_HOST set): FAIL CLOSED — a missing/unknown
//     identity is denied on write routes.
//   - Local dev (no SNOWFLAKE_HOST): FAIL OPEN — allow, so PAT-based local runs
//     and the owner can operate without an ingress header.

const OPS_ROLES = ['FLEET_APP_OPS', 'FLEET_APP_ADMIN', 'ACCOUNTADMIN', 'SYSADMIN'];
const ADMIN_ROLES = ['FLEET_APP_ADMIN', 'ACCOUNTADMIN', 'SYSADMIN'];

const INGRESS_USER_HEADER = 'sf-context-current-user';

export interface GateResult {
  ok: boolean;
  user: string | null;
  roles: string[];
  status: number; // 200 ok, 401 no identity (deployed), 403 insufficient role
  reason?: string;
}

function isDeployed(): boolean {
  return !!process.env.SNOWFLAKE_HOST;
}

export function getIngressUser(req: Request): string | null {
  const raw = req.headers.get(INGRESS_USER_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function getUserRoles(user: string): Promise<string[]> {
  const safe = user.replace(/[^A-Za-z0-9_.@-]/g, '');
  if (!safe) return [];
  try {
    const rows = await runSql(`SHOW GRANTS TO USER "${safe}"`);
    return rows
      .map((r) => String((r.role ?? r.ROLE ?? '') as string).toUpperCase())
      .filter((r) => r.length > 0);
  } catch (err) {
    logger.error('ingress-roles', { user: safe }, err);
    return [];
  }
}

async function gate(req: Request, allowed: string[]): Promise<GateResult> {
  const user = getIngressUser(req);
  if (!user) {
    if (isDeployed()) {
      return { ok: false, user: null, roles: [], status: 401, reason: 'No ingress identity' };
    }
    return { ok: true, user: null, roles: [], status: 200 };
  }
  const roles = await getUserRoles(user);
  const ok = roles.some((r) => allowed.includes(r));
  return {
    ok,
    user,
    roles,
    status: ok ? 200 : 403,
    reason: ok ? undefined : `User ${user} is not bound to a required role (${allowed.join(', ')})`,
  };
}

/** Require OPS (or higher) for the privileged action. */
export function requireOps(req: Request): Promise<GateResult> {
  return gate(req, OPS_ROLES);
}

/** Require ADMIN for the privileged action. */
export function requireAdmin(req: Request): Promise<GateResult> {
  return gate(req, ADMIN_ROLES);
}
