import type { ProcDef } from '../defineProc.js';
import type { Schema } from '../schema.js';
/**
 * Emit `CREATE OR REPLACE PROCEDURE` DDL for a `ProcDef`. The body is supplied
 * by the bundler (`bundle.ts`); this file only handles signature, type
 * mapping, reserved-word quoting, and the boilerplate.
 */
/** Schema -> SQL type. LEARNINGS §6: NUMBER(38,0) is forbidden in JS proc args. */
export declare function sqlType(s: Schema<unknown>): string;
/** Render an arg name for the DDL signature. */
export declare function quoteArg(name: string): string;
export interface ProcDDLOpts {
    /** The bundled JS body (output of `bundle.ts`). */
    body: string;
    /** EXECUTE AS clause. Default OWNER (LEARNINGS §6: mandatory for trust model). */
    executeAs?: 'OWNER' | 'CALLER';
}
/** Emit a single `CREATE OR REPLACE PROCEDURE ... AS $$ <body> $$;` statement. */
export declare function procDDL(proc: ProcDef<string, unknown, unknown>, opts: ProcDDLOpts): string;
/**
 * Emit just the type list for a proc's signature, in the same shape Snowflake
 * needs for `GRANT USAGE ON PROCEDURE name(types) TO ROLE ...`. Mirrors the
 * arg list `procDDL` builds, including the trailing `STRING` for the
 * synapse-injected `IDEMPOTENCY_KEY`.
 *
 * Example: `(STRING, ARRAY, FLOAT, STRING)`.
 */
export declare function procSignature(proc: ProcDef<string, unknown, unknown>): string;
/**
 * Generate the args-capture suffix that goes at the end of every emitted body.
 * Snowflake exposes proc args as global identifiers, uppercased. This collects
 * them into a JS object keyed on the original (camelCase / snake_case) name
 * and calls `__synapseEntry` (which the synthetic entry attaches to
 * `globalThis` so it survives the IIFE's CommonJS wrapper).
 */
export declare function argsCaptureSuffix(proc: ProcDef<string, unknown, unknown>): string;
//# sourceMappingURL=ddl.d.ts.map