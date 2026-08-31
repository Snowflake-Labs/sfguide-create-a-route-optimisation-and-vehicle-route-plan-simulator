import type { Schema, InferRecord } from './schema.js';
import type { Conn } from './connector.js';
import type { Identity } from './audit.js';
import type { Code } from './errors.js';
import { fail } from './errors.js';

/**
 * SQL access modes a verb can request on a referenced object. `'all'`
 * implies the union of the others; the grant emitter expands it.
 */
export type ObjectAccess = 'all' | 'select' | 'insert' | 'update' | 'delete';

/**
 * Object-keyed map of access requirements. The framework rolls these up
 * across (verb.roles × verb.refs) at materialize time to synthesize per-role
 * GRANT <access> ON TABLE <object> statements -- see `buildLocalGrants`.
 *
 *   refs: { rollout: ['select', 'update'], rollout_event: ['insert'] }
 *
 * Refs are only consumed when `install.runtime === 'local'`. In `'sproc'`
 * mode procs run AS OWNER, callers don't need direct DML, so refs are
 * informational (and a future input to a sandbox-lint pass).
 */
export type ProcRefs = Record<string, readonly ObjectAccess[]>;

export interface ProcContext {
  conn: Conn;
  identity: Identity;
  fail: (code: Code, msg: string) => never;
}

export interface ProcDef<TName extends string, TArgs, TReturns> {
  name: TName;
  /**
   * One- to two-sentence agent-facing description. Surfaced as the MCP tool
   * description by `bundleMcpServer`. Should explain *when* to call the verb
   * and the most common failure mode the agent should anticipate. Optional;
   * if missing, the MCP server falls back to a generic placeholder.
   */
  description?: string;
  /**
   * If `false`, the verb is not registered with any MCP server (neither the
   * Snowflake-managed `CREATE MCP SERVER` spec nor the in-process stdio
   * server bundled into `server.js`). The proc is still deployed and still
   * granted to its `roles` -- callers can still invoke it via direct
   * `CALL`. Use for internal helpers, scheduled tasks, or verbs whose
   * functionality is already subsumed by another verb. Defaults to `true`.
   */
  mcp?: boolean;
  /**
   * Logical role names this proc should be granted to (e.g. `['admin']`,
   * `['user', 'viewer']`). The build emits `GRANT USAGE ON PROCEDURE ...`
   * statements bound to identifiers like `IDENTIFIER($admin_role)`, leaving
   * the operator free to remap logical → actual roles at install time. An
   * empty/missing list means "no auto-grant" (e.g. internal background tasks
   * granted via hand-written SQL).
   */
  roles?: readonly string[];
  /**
   * Schema objects this verb reads/writes. Used in `local` runtime to
   * synthesize per-role table grants; ignored in `sproc` runtime.
   */
  refs?: ProcRefs;
  /**
   * `EXECUTE AS` clause for the emitted procedure (sproc mode only).
   *
   * Default `'OWNER'` — the verb runs with the schema owner's role and
   * privileges. Use this when the verb should be able to touch any row
   * regardless of caller (e.g. background reconciliation, cross-user
   * aggregations). Note: under OWNER mode, `ctx.identity.user` still
   * reflects the invoker (via `CURRENT_USER()`), but `ctx.identity.role`
   * reflects the OWNER's role — role-gate checks against `identity.role`
   * are effectively defeated.
   *
   * Set to `'CALLER'` for verbs whose behavior depends on the caller's
   * role (admin gates) OR on the caller's row-access-policy scope
   * (they only see what they're allowed to see). Every role-gated verb
   * that calls something like `isAdminRole(ctx.identity.role)` MUST use
   * `'CALLER'` — otherwise every caller reports as the OWNER role.
   */
  executeAs?: 'OWNER' | 'CALLER';
  args: { [K in keyof TArgs]: Schema<TArgs[K]> };
  returns: { [K in keyof TReturns]: Schema<TReturns[K]> };
  validate?: (args: TArgs, ctx: ProcContext) => void | Promise<void>;
  execute: (args: TArgs, ctx: ProcContext) => Promise<TReturns>;
}

export interface ProcSpec<
  TName extends string,
  TArgsSchema extends Record<string, Schema<unknown>>,
  TRetSchema extends Record<string, Schema<unknown>>,
> {
  name: TName;
  description?: string;
  mcp?: boolean;
  roles?: readonly string[];
  refs?: ProcRefs;
  executeAs?: 'OWNER' | 'CALLER';
  args: TArgsSchema;
  returns: TRetSchema;
  validate?: (args: InferRecord<TArgsSchema>, ctx: ProcContext) => void | Promise<void>;
  execute: (args: InferRecord<TArgsSchema>, ctx: ProcContext) => Promise<InferRecord<TRetSchema>>;
}

export function defineProc<
  TName extends string,
  TArgsSchema extends Record<string, Schema<unknown>>,
  TRetSchema extends Record<string, Schema<unknown>>,
>(
  spec: ProcSpec<TName, TArgsSchema, TRetSchema>,
): ProcDef<TName, InferRecord<TArgsSchema>, InferRecord<TRetSchema>> {
  const def: ProcDef<TName, InferRecord<TArgsSchema>, InferRecord<TRetSchema>> = {
    name: spec.name,
    args: spec.args as { [K in keyof InferRecord<TArgsSchema>]: Schema<InferRecord<TArgsSchema>[K]> },
    returns: spec.returns as { [K in keyof InferRecord<TRetSchema>]: Schema<InferRecord<TRetSchema>[K]> },
    execute: spec.execute,
  };
  if (spec.description !== undefined) {
    def.description = spec.description;
  }
  if (spec.mcp !== undefined) {
    def.mcp = spec.mcp;
  }
  if (spec.roles !== undefined) {
    def.roles = spec.roles;
  }
  if (spec.refs !== undefined) {
    def.refs = spec.refs;
  }
  if (spec.executeAs !== undefined) {
    def.executeAs = spec.executeAs;
  }
  if (spec.validate !== undefined) {
    def.validate = spec.validate;
  }
  return def;
}

/** Canonical accessor for a proc's verb name. Equivalent to `proc.name`; provided
 *  so consumers can pass `getProcName(proc)` when destructuring loses inference. */
export function getProcName<TName extends string>(
  proc: ProcDef<TName, unknown, unknown>,
): TName {
  return proc.name;
}

/**
 * Whether `proc` should be registered as a tool with any MCP server. Default
 * is true; set `mcp: false` on the ProcDef to opt out (the proc is still
 * deployed and granted, just not exposed as a tool).
 */
export function isMcpExposed(proc: ProcDef<string, unknown, unknown>): boolean {
  return proc.mcp !== false;
}

export { fail };
