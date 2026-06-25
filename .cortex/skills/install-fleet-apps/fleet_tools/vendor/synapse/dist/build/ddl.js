/**
 * Emit `CREATE OR REPLACE PROCEDURE` DDL for a `ProcDef`. The body is supplied
 * by the bundler (`bundle.ts`); this file only handles signature, type
 * mapping, reserved-word quoting, and the boilerplate.
 */
/** Schema -> SQL type. LEARNINGS §6: NUMBER(38,0) is forbidden in JS proc args. */
export function sqlType(s) {
    switch (s.kind) {
        case 'nullable': return sqlType(s.inner);
        case 'string':
        case 'uuid':
        case 'enum': return 'STRING';
        case 'boolean': return 'BOOLEAN';
        case 'number': return 'FLOAT';
        case 'array': return 'ARRAY';
        case 'object': return 'OBJECT';
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
export function quoteArg(name) {
    const upper = name.toUpperCase();
    return RESERVED.has(upper) ? `"${upper}"` : upper;
}
/** Emit a single `CREATE OR REPLACE PROCEDURE ... AS $$ <body> $$;` statement. */
export function procDDL(proc, opts) {
    const argEntries = Object.entries(proc.args).map(([name, schema]) => `${quoteArg(name)} ${sqlType(schema)}`);
    // IDEMPOTENCY_KEY appended as the last arg of every emitted DDL. Every proc
    // has it; runtime decides whether it's used. DEFAULT NULL is required so the
    // Cortex Agent MCP server (which calls these procs with named args and omits
    // idempotency_key, since it is optional in the MCP input_schema) matches the
    // signature. Without the default, the agent's `CALL p(a => ?, b => ?)` raises
    // "named arguments [...] do not match any signature" and the agent surfaces a
    // generic "Error parsing response" tool failure. Must be the LAST arg.
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
export function procSignature(proc) {
    const types = Object.values(proc.args).map(s => sqlType(s));
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
export function argsCaptureSuffix(proc) {
    const entries = Object.keys(proc.args).map(name => {
        const upper = name.toUpperCase();
        return `  ${JSON.stringify(name)}: ${upper}`;
    });
    return `var __args = {
${entries.join(',\n')}
};
return __synapseEntry(__args, IDEMPOTENCY_KEY);`;
}
//# sourceMappingURL=ddl.js.map