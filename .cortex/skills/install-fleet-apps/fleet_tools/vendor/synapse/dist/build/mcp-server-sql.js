import { isMcpExposed } from '../defineProc.js';
import { toJsonSchema } from './json-schema.js';
/**
 * Resolve the MCP server's object name. Defaults to `<app>_mcp` (with any
 * `-` in the app name replaced by `_`, since Snowflake unquoted identifiers
 * disallow hyphens) when `install.mcpServerName` is unset. Server lives in
 * the same db.schema as the procs (Snowflake binds it to the current schema
 * at CREATE time, which materialize.ts already sets via `USE SCHEMA`).
 */
export function resolveMcpServerName(opts) {
    if (opts.install.mcpServerName)
        return opts.install.mcpServerName;
    return `${opts.app.replace(/-/g, '_')}_mcp`;
}
/**
 * Emit a single `CREATE OR REPLACE MCP SERVER ... FROM SPECIFICATION $$ ... $$;`
 * statement that registers every verb as a `GENERIC` / `procedure` tool.
 *
 * Called from `materialize` in sproc mode only -- after the proc DDL has been
 * appended to install.sql, before the grants block. Snowflake validates
 * tool identifiers at CREATE time, so the procs must already be in place.
 *
 * Spec shape mirrors the Snowflake docs example:
 * https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp
 */
export function buildMcpServerSql(opts) {
    const serverName = resolveMcpServerName(opts);
    // Verbs with `mcp: false` deploy as procs but aren't registered as MCP tools.
    const procs = opts.procs.filter(isMcpExposed)
        .sort((a, b) => a.name.localeCompare(b.name));
    const lines = [
        `CREATE OR REPLACE MCP SERVER ${serverName}`,
        `  FROM SPECIFICATION $$`,
        `tools:`,
    ];
    for (const proc of procs) {
        lines.push(...renderTool(proc, opts.install));
    }
    lines.push(`$$;`);
    return lines.join('\n');
}
function renderTool(proc, install) {
    const identifier = `${install.database}.${install.schema}.${proc.name.toUpperCase()}`;
    const description = proc.description ?? proc.name;
    const out = [
        `  - title: ${yamlString(proc.name)}`,
        `    name: ${yamlString(proc.name)}`,
        `    identifier: ${yamlString(identifier)}`,
        `    type: "GENERIC"`,
        `    description: ${yamlString(description)}`,
        `    config:`,
        `      type: "procedure"`,
        `      warehouse: ${yamlString(install.warehouse)}`,
        `      input_schema:`,
        `        type: "object"`,
        `        properties:`,
    ];
    const argEntries = Object.entries(proc.args);
    for (const [argName, schema] of argEntries) {
        const json = toJsonSchema(schema);
        out.push(`          ${yamlKey(argName)}:`);
        out.push(...renderInlineJsonSchema(json, '            '));
    }
    // IDEMPOTENCY_KEY is appended to every emitted proc signature in ddl.ts;
    // expose it to MCP callers but don't require it.
    out.push(`          idempotency_key:`);
    out.push(`            type: "string"`);
    out.push(`            description: "Client-supplied idempotency key. Repeated calls with the same key return the original result."`);
    if (argEntries.length > 0) {
        const requiredList = argEntries.map(([k]) => yamlString(k)).join(', ');
        out.push(`        required: [${requiredList}]`);
    }
    return out;
}
/**
 * Render a JSON-schema object as YAML at the given indent. The shapes coming
 * out of `toJsonSchema` are flat (one level deep for primitives, two for
 * nested objects/arrays). Order keys deterministically: `type`, `format`,
 * `enum`, `items`, `properties`, `required`, `oneOf`, `additionalProperties`,
 * `description`.
 */
function renderInlineJsonSchema(schema, indent) {
    const out = [];
    const keyOrder = [
        'type', 'format', 'enum', 'items', 'properties', 'required',
        'oneOf', 'additionalProperties', 'description',
    ];
    const keys = keyOrder.filter(k => k in schema);
    for (const key of keys) {
        const val = schema[key];
        if (val === undefined)
            continue;
        if (key === 'items') {
            // Single nested schema object -- block-style.
            out.push(`${indent}items:`);
            out.push(...renderInlineJsonSchema(val, indent + '  '));
        }
        else if (key === 'properties') {
            out.push(`${indent}properties:`);
            for (const [propName, propSchema] of Object.entries(val)) {
                out.push(`${indent}  ${yamlKey(propName)}:`);
                out.push(...renderInlineJsonSchema(propSchema, indent + '    '));
            }
        }
        else if (key === 'oneOf') {
            // Array of schema objects -- block-style list, each branch as a block.
            out.push(`${indent}oneOf:`);
            const branches = val;
            for (const branch of branches) {
                const itemIndent = indent + '  ';
                const inner = renderInlineJsonSchema(branch, itemIndent + '  ');
                if (inner.length === 0) {
                    out.push(`${itemIndent}- {}`);
                    continue;
                }
                // Replace the first inner line's leading whitespace with `- ` so it
                // becomes the list-item marker. Subsequent lines keep their full
                // (deeper) indent and align under the marker naturally.
                out.push(`${itemIndent}- ${inner[0].slice(itemIndent.length + 2)}`);
                for (let i = 1; i < inner.length; i++)
                    out.push(inner[i]);
            }
        }
        else if (Array.isArray(val)) {
            // Flow-style list of scalars (e.g. `enum`, `required`).
            const items = val
                .map(v => yamlScalar(v))
                .join(', ');
            out.push(`${indent}${key}: [${items}]`);
        }
        else if (typeof val === 'string' || typeof val === 'boolean' || typeof val === 'number') {
            out.push(`${indent}${key}: ${yamlScalar(val)}`);
        }
    }
    return out;
}
/** Quote and escape a YAML scalar string. */
function yamlString(s) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
/** YAML mapping keys: keep bare when safe, quote otherwise. */
function yamlKey(s) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : yamlString(s);
}
function yamlScalar(v) {
    if (typeof v === 'string')
        return yamlString(v);
    return String(v);
}
//# sourceMappingURL=mcp-server-sql.js.map