/**
 * Fully-qualified name injection for app-owned Snowflake objects.
 *
 * Verbs deployed as stored procedures run inside Snowflake's JS sandbox where:
 *   - `USE SCHEMA` is banned (Unsupported statement type 'USE'), so procs
 *     cannot pin their own session context at entry.
 *   - Under `EXECUTE AS CALLER`, the session inherits whatever schema the
 *     caller had set. If that's not the app's data schema, every unqualified
 *     `Tables.foo` reference resolves in the wrong place and fails with
 *     "Object does not exist or not authorized".
 *
 * Fix: hoist the qualifier into the *bundle*. Apps declare logical names via
 * `defineCatalog({...})`; the framework's bundler substitutes the constants
 * `__SYNAPSE_DATABASE__` and `__SYNAPSE_SCHEMA__` at compile time via
 * esbuild's `define`, so the emitted proc body carries fully-qualified
 * strings regardless of runtime session context.
 *
 * Outside a bundle (unit tests, ad-hoc scripts) the constants are undefined;
 * `typeof` is used to detect that without a ReferenceError, and
 * `defineCatalog` falls back to bare names. That preserves today's
 * ergonomics for local test setups.
 */

// Bundler-substituted constants. `declare const` gives TypeScript the type
// info; esbuild's `define` replaces the identifiers with string literals at
// bundle time. Outside a bundle they're genuinely undefined -- readable via
// `typeof` without throwing.
declare const __SYNAPSE_DATABASE__: string;
declare const __SYNAPSE_SCHEMA__: string;

/**
 * Declare app-owned object names. Returns fully-qualified names
 * (`<db>.<schema>.<value>`) when the bundler has substituted the db/schema
 * constants; returns the values unchanged otherwise.
 *
 * Usage:
 * ```ts
 * // apps/<app>/src/catalog.ts
 * import { defineCatalog } from '@snowflake/synapse';
 *
 * export const Tables = defineCatalog({
 *   meetings: 'MEETINGS',
 *   employees: 'EMPLOYEES',
 * });
 * ```
 *
 * At runtime inside a bundled proc, `Tables.meetings` evaluates to
 * `'SYNAPSE.MTG_INTELLIGENCE.MEETINGS'`, so SQL strings the verb interpolates
 * are qualified without any session-level `USE SCHEMA`.
 */
export function defineCatalog<T extends Record<string, string>>(spec: T): T {
  const db = typeof __SYNAPSE_DATABASE__ === 'undefined' ? '' : __SYNAPSE_DATABASE__;
  const schema = typeof __SYNAPSE_SCHEMA__ === 'undefined' ? '' : __SYNAPSE_SCHEMA__;
  if (!db || !schema) return spec;
  const out = {} as Record<string, string>;
  for (const [k, v] of Object.entries(spec)) {
    out[k] = `${db}.${schema}.${v}`;
  }
  return out as T;
}

/**
 * The app's fully-qualified schema (`<db>.<schema>`), resolved at bundle
 * time from the same constants `defineCatalog` uses. Returns an empty
 * string outside a bundle. Handy when a proc needs to emit SQL that
 * qualifies things the catalog doesn't cover (e.g. names computed at
 * runtime, or a bare schema reference in a prompt).
 */
export function schemaFqn(): string {
  const db = typeof __SYNAPSE_DATABASE__ === 'undefined' ? '' : __SYNAPSE_DATABASE__;
  const schema = typeof __SYNAPSE_SCHEMA__ === 'undefined' ? '' : __SYNAPSE_SCHEMA__;
  return db && schema ? `${db}.${schema}` : '';
}


