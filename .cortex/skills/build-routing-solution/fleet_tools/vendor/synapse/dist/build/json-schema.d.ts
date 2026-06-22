import type { Schema } from '../schema.js';
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
export declare function toJsonSchema(schema: Schema<unknown>): Record<string, unknown>;
/**
 * Build the `inputSchema` for an MCP tool whose handler takes a verb's
 * `(args, opts?)` pair. The wrapped object has `args` (the verb's typed
 * args record) plus an optional `idempotency_key`.
 */
export declare function toToolInputSchema(args: Record<string, Schema<unknown>> | {
    [k: string]: Schema<unknown>;
}): Record<string, unknown>;
//# sourceMappingURL=json-schema.d.ts.map