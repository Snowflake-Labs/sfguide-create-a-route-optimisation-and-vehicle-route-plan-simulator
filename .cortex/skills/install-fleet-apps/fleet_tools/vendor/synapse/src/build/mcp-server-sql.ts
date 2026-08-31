import type { ProcDef } from '../defineProc.js';
import { isMcpExposed } from '../defineProc.js';
import type { Schema } from '../schema.js';
import type { InstallConfig } from './install.js';
import { toJsonSchema } from './json-schema.js';

export interface BuildMcpServerSqlOpts {
  /** Verbs to register as `GENERIC` / `procedure` tools. */
  procs: Array<ProcDef<string, unknown, unknown>>;
  /** Install config -- supplies database, schema, warehouse. */
  install: InstallConfig;
  /** App name. Used as the default server-name suffix. */
  app: string;
}

/**
 * Resolve the MCP server's object name. Defaults to `<app>_mcp` (with any
 * `-` in the app name replaced by `_`, since Snowflake unquoted identifiers
 * disallow hyphens) when `install.mcpServerName` is unset. Server lives in
 * the same db.schema as the procs (Snowflake binds it to the current schema
 * at CREATE time, which materialize.ts already sets via `USE SCHEMA`).
 */
export function resolveMcpServerName(opts: BuildMcpServerSqlOpts): string {
  if (opts.install.mcpServerName) return opts.install.mcpServerName;
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
export function buildMcpServerSql(opts: BuildMcpServerSqlOpts): string {
  const serverName = resolveMcpServerName(opts);
  // Verbs with `mcp: false` deploy as procs but aren't registered as MCP tools.
  const procs = opts.procs.filter(isMcpExposed)
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [
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

function renderTool(
  proc: ProcDef<string, unknown, unknown>,
  install: InstallConfig,
): string[] {
  const identifier = `${install.database}.${install.schema}.${proc.name.toUpperCase()}`;
  const description = proc.description ?? proc.name;
  const out: string[] = [
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
  ];

  const argEntries = Object.entries(proc.args) as Array<[string, Schema<unknown>]>;
  if (argEntries.length === 0) {
    // Zero-arg verb: still emit an empty properties object rather than
    // omitting or leaving `properties:` bare -- MCP clients validate the
    // input schema and reject `properties: null` (which is what bare
    // `properties:` parses to in YAML).
    out.push(`        properties: {}`);
  } else {
    out.push(`        properties:`);
    for (const [argName, schema] of argEntries) {
      const json = toJsonSchema(schema);
      out.push(`          ${yamlKey(argName)}:`);
      out.push(...renderInlineJsonSchema(json, '            '));
    }
    // IDEMPOTENCY_KEY is on every proc's DDL signature with DEFAULT NULL; MCP
    // callers don't need to see it. Apps that want caller-supplied idempotency
    // should declare it as a real verb arg.
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
function renderInlineJsonSchema(
  schema: Record<string, unknown>,
  indent: string,
): string[] {
  const out: string[] = [];
  const keyOrder = [
    'type', 'format', 'enum', 'items', 'properties', 'required',
    'oneOf', 'additionalProperties', 'description',
  ];
  const keys = keyOrder.filter(k => k in schema);
  for (const key of keys) {
    const val = schema[key];
    if (val === undefined) continue;
    if (key === 'items') {
      // Single nested schema object -- block-style.
      out.push(`${indent}items:`);
      out.push(...renderInlineJsonSchema(val as Record<string, unknown>, indent + '  '));
    } else if (key === 'properties') {
      out.push(`${indent}properties:`);
      for (const [propName, propSchema] of Object.entries(val as Record<string, unknown>)) {
        out.push(`${indent}  ${yamlKey(propName)}:`);
        out.push(...renderInlineJsonSchema(propSchema as Record<string, unknown>, indent + '    '));
      }
    } else if (key === 'oneOf') {
      // Array of schema objects -- block-style list, each branch as a block.
      out.push(`${indent}oneOf:`);
      const branches = val as Array<Record<string, unknown>>;
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
        out.push(`${itemIndent}- ${inner[0]!.slice(itemIndent.length + 2)}`);
        for (let i = 1; i < inner.length; i++) out.push(inner[i]!);
      }
    } else if (Array.isArray(val)) {
      // Flow-style list of scalars (e.g. `enum`, `required`).
      const items = (val as unknown[])
        .map(v => yamlScalar(v as string | number | boolean))
        .join(', ');
      out.push(`${indent}${key}: [${items}]`);
    } else if (typeof val === 'string' || typeof val === 'boolean' || typeof val === 'number') {
      out.push(`${indent}${key}: ${yamlScalar(val)}`);
    }
  }
  return out;
}

/** Quote and escape a YAML scalar string. */
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** YAML mapping keys: keep bare when safe, quote otherwise. */
function yamlKey(s: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : yamlString(s);
}

function yamlScalar(v: string | number | boolean): string {
  if (typeof v === 'string') return yamlString(v);
  return String(v);
}
