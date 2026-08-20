import { query } from '@/lib/snowflake';
import { logger } from '@/lib/logger';

// Per-user role gating via SPCS ingress identity (R3 / deferred 4D).
//
// The app runs as ONE SPCS service identity, so dashboards/agent/ops verbs all
// execute as the service role regardless of the end user. To stop a consumer
// from invoking OPS/ADMIN actions, we read the ingress-injected end-user login
// (`Sf-Context-Current-User`) and check whether that Snowflake user is bound to
// an OPS/ADMIN app role before allowing the privileged action.
//
// Posture (accelerator now, product-ready seams):
//   - Deployed (SPCS, SNOWFLAKE_HOST set): FAIL CLOSED - a missing/unknown
//     identity is denied.
//   - Local dev (no SNOWFLAKE_HOST): FAIL OPEN - allow, so PAT-based local runs
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

// Roles directly granted to the user. Step 3E binds real users directly to one
// of FLEET_APP_USER/OPS/ADMIN, so a direct-grant check is sufficient (the role
// hierarchy ADMIN > OPS > USER is honored by accepting any higher role in the
// allowed set for a given gate).
async function getUserRoles(user: string): Promise<string[]> {
  const safe = user.replace(/[^A-Za-z0-9_.@-]/g, '');
  if (!safe) return [];
  try {
    const rows = await query<Record<string, unknown>>(`SHOW GRANTS TO USER "${safe}"`);
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
    // Local dev: no ingress header -> allow.
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

/**
 * Require any authenticated end user for a write/mutating action.
 *
 * Unlike requireOps/requireAdmin this does not check a role - it only asserts
 * that SPCS ingress injected an end-user identity. Deployed (SNOWFLAKE_HOST set):
 * FAIL CLOSED, so an unauthenticated caller cannot reach a write path even
 * though the app itself runs as the service role. Local dev (no SNOWFLAKE_HOST):
 * FAIL OPEN, so PAT-based local runs and the owner keep working. Use on write
 * endpoints (e.g. backload decision write-back) that have no role requirement
 * but must not be anonymous.
 */
export async function requireUser(req: Request): Promise<GateResult> {
  const user = getIngressUser(req);
  if (!user) {
    if (isDeployed()) {
      return { ok: false, user: null, roles: [], status: 401, reason: 'No ingress identity' };
    }
    return { ok: true, user: null, roles: [], status: 200 };
  }
  return { ok: true, user, roles: [], status: 200 };
}
