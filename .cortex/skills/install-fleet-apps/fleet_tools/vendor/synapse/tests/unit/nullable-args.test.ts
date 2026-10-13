import { describe, it, expect } from 'vitest';
import { defineProc, t } from '../../src/index.js';
import { procDDL } from '../../src/build/ddl.js';
import { buildMcpServerSql } from '../../src/build/mcp-server-sql.js';

// LOCAL PATCH 08. The managed MCP server rejects an explicit JSON null for any
// GENERIC-tool argument ("unsupported parameter type: <nil>"), which broke every
// agent call that left an optional verb arg empty (deep_link, show_view,
// backload_solve, ...). Nullable args must be omittable: DEFAULT NULL in the DDL
// and absent from the MCP `required` list.
const verb = defineProc({
  name: 'deep_link',
  roles: ['user'],
  args: {
    app: t.string(),
    page: t.string().nullable(),
    view_id: t.string(),
    selection: t.string().nullable(),
  },
  returns: { ok: t.boolean() },
  execute: async () => ({ ok: true }),
});

describe('nullable args are omittable', () => {
  it('defaults every arg from the first nullable one onward', () => {
    const ddl = procDDL(verb, { body: '' });
    expect(ddl).toContain('APP STRING, PAGE STRING DEFAULT NULL, VIEW_ID STRING DEFAULT NULL, '
      + 'SELECTION STRING DEFAULT NULL, IDEMPOTENCY_KEY STRING DEFAULT NULL');
  });

  it('leaves a verb with no nullable arg without defaults', () => {
    const strict = defineProc({
      name: 'strict', roles: ['user'], args: { a: t.string(), b: t.number() },
      returns: { ok: t.boolean() }, execute: async () => ({ ok: true }),
    });
    expect(procDDL(strict, { body: '' })).toContain('(A STRING, B FLOAT, IDEMPOTENCY_KEY');
  });

  it('advertises nullable args as their plain type and not required', () => {
    const sql = buildMcpServerSql({
      procs: [verb],
      install: { database: 'D', schema: 'S', warehouse: 'W' } as never,
      app: 'routing',
    });
    expect(sql).toContain('required: ["app", "view_id"]');
    expect(sql).not.toContain('type: "null"');
  });
});
