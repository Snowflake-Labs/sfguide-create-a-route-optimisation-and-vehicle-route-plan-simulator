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
//
// Cached for ROLE_CACHE_TTL_MS. Without a cache every requireOps/requireAdmin
// call pays a full warehouse round trip BEFORE doing any work, and the ops
// console issues several privileged calls per interaction, so the gate was a
// per-request latency floor on exactly the paths users notice.
//
// TRADEOFF, deliberately bounded: this is an authorization decision, so a cache
// means a REVOKED grant stays honored until the entry expires. The TTL is
// therefore short (30s) rather than the 5-10 minutes used for data caches
// elsewhere in these apps - long enough to collapse a burst of calls from one
// interaction, short enough that a revocation takes effect promptly. Do not
// raise it without accounting for that window.
const ROLE_CACHE_TTL_MS = 30_000;
const ROLE_CACHE_MAX = 256;
// globalThis-pinned: Next compiles each route handler as a separate bundle, so a
// module-local Map would otherwise be per-route and mostly cold.
const roleCache: Map<string, { roles: string[]; expires: number }> =
  ((globalThis as unknown as { __fleetSaRoleCache?: Map<string, { roles: string[]; expires: number }> })
    .__fleetSaRoleCache ??= new Map());

async function getUserRoles(user: string): Promise<string[]> {
  const safe = user.replace(/[^A-Za-z0-9_.@-]/g, '');
  if (!safe) return [];
  const now = Date.now();
  const hit = roleCache.get(safe);
  if (hit && hit.expires > now) return hit.roles;
  try {
    const rows = await query<Record<string, unknown>>(`SHOW GRANTS TO USER "${safe}"`);
    const roles = rows
      .map((r) => String((r.role ?? r.ROLE ?? '') as string).toUpperCase())
      .filter((r) => r.length > 0);
    // Bound the map so a wide user population cannot grow it without limit.
    if (roleCache.size >= ROLE_CACHE_MAX) roleCache.clear();
    roleCache.set(safe, { roles, expires: now + ROLE_CACHE_TTL_MS });
    return roles;
  } catch (err) {
    logger.error('ingress-roles', { user: safe }, err);
    // Deliberately NOT cached: a transient lookup failure must not pin an empty
    // role set (i.e. a denial) for the whole TTL.
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
