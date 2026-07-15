/**
 * Build a client-side runtime that dispatches verb calls to deployed sprocs
 * via `CALL <verb>(?, ?, ...)`. Same shape as `createSynapseRuntime` but the
 * envelope (validate / identity / audit) lives inside Snowflake — we just
 * shuttle args in and unwrap the OBJECT result on the way out.
 *
 * The args passed in must already be the canonical argument record (matching
 * `proc.args`); they're fed into the CALL in the order Snowflake expects:
 * the proc's declared arg list, then the framework-injected `IDEMPOTENCY_KEY`.
 *
 * Snowflake returns a JS proc's OBJECT/VARIANT result wrapped in a
 * single-row resultset under a column named after the proc (uppercased).
 * Sometimes the connector hands it back as a parsed object; sometimes as a
 * JSON string. We tolerate both.
 */
export function wireSprocClient(conn, procs) {
    const result = {};
    for (const procName of Object.keys(procs)) {
        const proc = procs[procName];
        const argNames = Object.keys(proc.args);
        const argSchemas = argNames.map(n => proc.args[n]);
        // Build the placeholder list: `PARSE_JSON(?)` for ARRAY/OBJECT args, plain
        // `?` for everything else. Snowflake's JS connector binds primitives
        // straight to STRING/FLOAT/BOOLEAN, but for ARRAY/OBJECT proc args it
        // refuses to coerce a JS array/object straight to the typed param --
        // PARSE_JSON on a JSON string is the canonical workaround.
        const placeholders = argSchemas.map(s => {
            const k = unwrapKind(s);
            return (k === 'array' || k === 'object') ? 'PARSE_JSON(?)' : '?';
        });
        placeholders.push('?'); // idempotency_key
        const sql = `CALL ${proc.name}(${placeholders.join(', ')})`;
        result[procName] = async (rawArgs, callOpts) => {
            const ordered = argNames.map((name, i) => {
                const raw = rawArgs[name];
                return serializeForCall(raw, argSchemas[i]);
            });
            ordered.push(callOpts?.idempotency_key ?? null);
            const row = await conn.execRow(sql, ordered);
            const wrapped = row?.[proc.name.toUpperCase()];
            if (wrapped === null || wrapped === undefined)
                return wrapped;
            if (typeof wrapped === 'string') {
                try {
                    return JSON.parse(wrapped);
                }
                catch {
                    return wrapped;
                }
            }
            return wrapped;
        };
    }
    return result;
}
/**
 * Convert a TS-side argument value to the bind form. ARRAY and OBJECT both
 * get JSON-stringified -- the call-site placeholder is `PARSE_JSON(?)` for
 * those, so Snowflake parses on the way in. Primitives pass through.
 */
function serializeForCall(value, schema) {
    if (value === null || value === undefined)
        return null;
    const kind = unwrapKind(schema);
    if (kind === 'array' || kind === 'object') {
        if (typeof value === 'string')
            return value;
        return JSON.stringify(value);
    }
    return value;
}
function unwrapKind(schema) {
    let s = schema;
    while (s && s.kind === 'nullable')
        s = s.inner;
    return s?.kind ?? 'string';
}
//# sourceMappingURL=sproc-client.js.map