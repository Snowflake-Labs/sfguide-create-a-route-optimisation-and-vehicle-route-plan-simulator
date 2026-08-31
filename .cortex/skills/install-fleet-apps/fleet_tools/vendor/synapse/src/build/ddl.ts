import type { ProcDef } from '../defineProc.js';
import type { Schema } from '../schema.js';

/**
 * Emit `CREATE OR REPLACE PROCEDURE` DDL for a `ProcDef`. The body is supplied
 * by the bundler (`bundle.ts`); this file only handles signature, type
 * mapping, reserved-word quoting, and the boilerplate.
 */

/** Schema -> SQL type. LEARNINGS §6: NUMBER(38,0) is forbidden in JS proc args. */
export function sqlType(s: Schema<unknown>): string {
  switch (s.kind) {
    case 'nullable': return sqlType(s.inner!);
    case 'string':
    case 'uuid':
    case 'enum':     return 'STRING';
    case 'boolean':  return 'BOOLEAN';
    case 'number':   return 'FLOAT';
    case 'array':    return 'ARRAY';
    case 'object':   return 'OBJECT';
  }
}

/**
 * Snowflake reserved words that need double-quoting when used as proc arg
 * names. Extended on demand — this is an allow-list of cases we've actually
 * hit, not the full Snowflake reserved-word table.
 *
 * Words like `comment` and `user` are tolerated by Snowflake as bare proc-arg
 * identifiers — only the words below trigger parser errors. The reference
 * sproc (250_approve_rollout.sql) uses bare `comment STRING` and works.
 */
const RESERVED = new Set([
  'GROUP', 'ORDER', 'TABLE', 'SELECT', 'FROM', 'WHERE', 'JOIN',
]);

/** Render an arg name for the DDL signature. */
export function quoteArg(name: string): string {
  const upper = name.toUpperCase();
  return RESERVED.has(upper) ? `"${upper}"` : upper;
}

export interface ProcDDLOpts {
  /** The bundled JS body (output of `bundle.ts`). */
  body: string;
  /** EXECUTE AS clause. Default OWNER (LEARNINGS §6: mandatory for trust model). */
  executeAs?: 'OWNER' | 'CALLER';
}

/** Emit a single `CREATE OR REPLACE PROCEDURE ... AS $$ <body> $$;` statement. */
export function procDDL(
  proc: ProcDef<string, unknown, unknown>,
  opts: ProcDDLOpts,
): string {
  const argEntries = Object.entries(proc.args).map(
    ([name, schema]) => `${quoteArg(name)} ${sqlType(schema as Schema<unknown>)}`,
  );
  // IDEMPOTENCY_KEY appended as the last arg of every emitted DDL, with a
  // DEFAULT so callers (MCP dispatcher, direct CALL) can omit it. Audit code
  // uses null as "no replay check requested"; apps that need idempotency
  // should declare their own arg and handle it in the verb.
  argEntries.push('IDEMPOTENCY_KEY STRING DEFAULT NULL');

  return `CREATE OR REPLACE PROCEDURE ${proc.name}(${argEntries.join(', ')})
RETURNS OBJECT LANGUAGE JAVASCRIPT EXECUTE AS ${opts.executeAs ?? 'OWNER'} AS
$$
${opts.body}
$$;`;
}

/**
 * Emit just the type list for a proc's signature, in the same shape Snowflake
 * needs for `GRANT USAGE ON PROCEDURE name(types) TO ROLE ...`. Mirrors the
 * arg list `procDDL` builds, including the trailing `STRING` for the
 * synapse-injected `IDEMPOTENCY_KEY`.
 *
 * Example: `(STRING, ARRAY, FLOAT, STRING)`.
 */
export function procSignature(proc: ProcDef<string, unknown, unknown>): string {
  const types = Object.values(proc.args).map(s => sqlType(s as Schema<unknown>));
  types.push('STRING');
  return `(${types.join(', ')})`;
}

/**
 * Generate the args-capture suffix that goes at the end of every emitted body.
 * Snowflake exposes proc args as global identifiers, uppercased. This collects
 * them into a JS object keyed on the original (camelCase / snake_case) name
 * and calls `__synapseEntry` (which the synthetic entry attaches to
 * `globalThis` so it survives the IIFE's CommonJS wrapper).
 */
export function argsCaptureSuffix(proc: ProcDef<string, unknown, unknown>): string {
  const entries = Object.keys(proc.args).map(name => {
    const upper = name.toUpperCase();
    return `  ${JSON.stringify(name)}: ${upper}`;
  });
  return `var __args = {
${entries.join(',\n')}
};
return __synapseEntry(__args, IDEMPOTENCY_KEY);`;
}
