// Client-side role model for the role-evaluation dropdown.
//
// This is a SIMULATED view filter: picking a role changes what the UI surfaces
// (which views, what capability summary), it does NOT change the privileges used
// for backend calls. The server-side gate (lib/ingress-identity.ts) remains the
// real authority for OPS/ADMIN actions.
//
// Role hierarchy (from routing_platform/role_binding.sql): admin > ops > user.
// A view declares the minimum roles allowed to see it via `ViewDef.roles`.
// A view with no `roles` is visible to everyone (base/user level).

import type { ViewDef } from './types';

export type AppRole = 'user' | 'ops' | 'admin';

export const APP_ROLES: AppRole[] = ['user', 'ops', 'admin'];

// The set of role-tiers a selected role encompasses (honors the inheritance
// admin > ops > user). Picking `admin` sees user+ops+admin views.
const ENCOMPASSES: Record<AppRole, Set<AppRole>> = {
  user: new Set<AppRole>(['user']),
  ops: new Set<AppRole>(['user', 'ops']),
  admin: new Set<AppRole>(['user', 'ops', 'admin']),
};

export const ROLE_LABELS: Record<AppRole, string> = {
  user: 'User',
  ops: 'Ops',
  admin: 'Admin',
};

export const ROLE_DESCRIPTIONS: Record<AppRole, string> = {
  user: 'Consume analytics and routing tools. Read-only access to the FLEET_APP data contract and the routing CONTRACT verbs.',
  ops: 'Keep the substrate running: suspend/resume services, set the active region, check platform health. Inherits all User access.',
  admin: 'Own the wiring: region-to-provider map and substrate verification. Inherits all Ops access.',
};

// The Snowflake app role each tier maps to (for the capability summary).
export const ROLE_SNOWFLAKE_ROLE: Record<AppRole, string> = {
  user: 'FLEET_APP_USER',
  ops: 'FLEET_APP_OPS',
  admin: 'FLEET_APP_ADMIN',
};

/** Resolve the AppRole tier from a Snowflake role name (highest wins). */
export function appRoleFromSnowflakeRoles(roles: string[]): AppRole {
  const upper = roles.map((r) => r.toUpperCase());
  if (upper.some((r) => ['FLEET_APP_ADMIN', 'ACCOUNTADMIN', 'SYSADMIN'].includes(r))) return 'admin';
  if (upper.includes('FLEET_APP_OPS')) return 'ops';
  return 'user';
}

// Treat existing role-named tags as a fallback when a view has no explicit
// `roles` (e.g. ops_console historically used tags: ['ops','admin']).
function rolesForView(view: Pick<ViewDef, 'roles' | 'tags'>): AppRole[] | null {
  if (view.roles && view.roles.length > 0) return view.roles;
  const fromTags = (view.tags ?? []).filter((t): t is AppRole =>
    (APP_ROLES as string[]).includes(t),
  );
  return fromTags.length > 0 ? fromTags : null;
}

/**
 * Can the selected role see this view?
 * - No declared roles -> visible to everyone.
 * - Declared roles -> visible if the selected role's encompassed tiers
 *   intersect the view's allowed roles.
 */
export function canRoleSeeView(role: AppRole, view: Pick<ViewDef, 'roles' | 'tags'>): boolean {
  const allowed = rolesForView(view);
  if (!allowed) return true;
  const seen = ENCOMPASSES[role];
  return allowed.some((r) => seen.has(r));
}
