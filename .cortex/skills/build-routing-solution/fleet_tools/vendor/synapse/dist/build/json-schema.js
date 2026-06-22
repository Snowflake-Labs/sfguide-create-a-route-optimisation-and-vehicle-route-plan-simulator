/**
 * Lift a synapse schema (from `t.string()` / `t.object({...})` / etc.) to
 * JSON Schema. Used by the MCP server bundler to declare `inputSchema` for
 * each verb's tool registration.
 *
 * Mapping:
 *   string -> { type: 'string' }       (with minLength/maxLength/pattern when set)
 *   uuid   -> { type: 'string', format: 'uuid' }
 *   number -> { type: 'number' }
 *   boolean-> { type: 'boolean' }
 *   array  -> { type: 'array', items: <inner> }
 *   object -> { type: 'object', properties: ..., required: [...] }
 *             (empty shape -> additionalProperties: true, no constraints)
 *   nullable<T> -> oneOf: [<T>, { type: 'null' }]
 */
export function toJsonSchema(schema) {
    const out = baseSchema(schema);
    if (schema.description !== undefined) {
        out.description = schema.description;
    }
    return out;
}
function baseSchema(schema) {
    // The Schema interface exposes opts indirectly; we read the parser's
    // closure-captured constraints via a small kind switch + the public
    // `inner`/`shape` fields. Constraints not exposed (e.g. string min/max)
    // are best-effort -- for tool inputs the agent benefits from the type
    // alone, and the runtime still validates on call.
    switch (schema.kind) {
        case 'string':
        case 'uuid':
            return schema.kind === 'uuid'
                ? { type: 'string', format: 'uuid' }
                : { type: 'string' };
        case 'enum':
            return { type: 'string', enum: [...(schema.values ?? [])] };
        case 'number': return { type: 'number' };
        case 'boolean': return { type: 'boolean' };
        case 'array': {
            const inner = schema.inner;
            if (!inner)
                return { type: 'array' };
            return { type: 'array', items: toJsonSchema(inner) };
        }
        case 'object': {
            const shape = schema.shape ?? {};
            const keys = Object.keys(shape);
            if (keys.length === 0) {
                // Passthrough object (e.g. partial_rollout) -- accept any keys.
                return { type: 'object', additionalProperties: true };
            }
            const properties = {};
            for (const k of keys)
                properties[k] = toJsonSchema(shape[k]);
            return { type: 'object', properties, required: keys };
        }
        case 'nullable': {
            const inner = schema.inner;
            if (!inner)
                return {};
            return { oneOf: [toJsonSchema(inner), { type: 'null' }] };
        }
    }
}
/**
 * Build the `inputSchema` for an MCP tool whose handler takes a verb's
 * `(args, opts?)` pair. The wrapped object has `args` (the verb's typed
 * args record) plus an optional `idempotency_key`.
 */
export function toToolInputSchema(args) {
    const argsProperties = {};
    const argsRequired = [];
    for (const [name, sch] of Object.entries(args)) {
        argsProperties[name] = toJsonSchema(sch);
        argsRequired.push(name);
    }
    return {
        type: 'object',
        properties: {
            args: {
                type: 'object',
                properties: argsProperties,
                required: argsRequired,
            },
            idempotency_key: { type: 'string' },
        },
        required: ['args'],
    };
}
//# sourceMappingURL=json-schema.js.map