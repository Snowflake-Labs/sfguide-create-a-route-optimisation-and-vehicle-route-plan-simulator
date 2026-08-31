import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { defineProc, t } from '../../src/index.js';
import { buildGrants } from '../../src/build/grants.js';

function write(proc: ReturnType<typeof defineProc<string, never, never>>) {
  return proc;
}

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-grants-')), name);
}

const adminProc = defineProc({
  name: 'register_widget',
  roles: ['admin'],
  args: { id: t.string(), count: t.number() },
  returns: { ok: t.boolean() },
  execute: async () => ({ ok: true }),
});

const userViewerProc = defineProc({
  name: 'list_widgets',
  roles: ['user', 'viewer'],
  args: { prefix: t.string().nullable() },
  returns: { ok: t.boolean() },
  execute: async () => ({ ok: true }),
});

const noRoleProc = defineProc({
  name: 'internal_only',
  args: {},
  returns: { ok: t.boolean() },
  execute: async () => ({ ok: true }),
});

describe('buildGrants', () => {
  it('emits one grant per (proc, role) pair, grouped and sorted by role', async () => {
    const out = tmpFile('grants.sql');
    await buildGrants({ procs: [adminProc, userViewerProc, noRoleProc], out });
    const sql = fs.readFileSync(out, 'utf8');

    expect(sql).toMatch(/-- role: admin\nGRANT USAGE ON PROCEDURE register_widget\(STRING, FLOAT, STRING\) TO ROLE IDENTIFIER\(\$admin_role\);/);
    expect(sql).toMatch(/-- role: user\nGRANT USAGE ON PROCEDURE list_widgets\(STRING, STRING\) TO ROLE IDENTIFIER\(\$user_role\);/);
    expect(sql).toMatch(/-- role: viewer\nGRANT USAGE ON PROCEDURE list_widgets\(STRING, STRING\) TO ROLE IDENTIFIER\(\$viewer_role\);/);

    // a proc with no roles produces no grant lines.
    expect(sql).not.toMatch(/internal_only/);

    // role blocks appear in alphabetical order: admin, user, viewer.
    const adminAt  = sql.indexOf('-- role: admin');
    const userAt   = sql.indexOf('-- role: user');
    const viewerAt = sql.indexOf('-- role: viewer');
    expect(adminAt).toBeGreaterThan(-1);
    expect(adminAt).toBeLessThan(userAt);
    expect(userAt).toBeLessThan(viewerAt);
  });

  it('uses a custom roleTarget when provided', async () => {
    const out = tmpFile('grants-custom.sql');
    await buildGrants({
      procs: [adminProc],
      out,
      roleTarget: r => `ROLE ${r.toUpperCase()}_ROLE`,
    });
    const sql = fs.readFileSync(out, 'utf8');
    expect(sql).toMatch(/TO ROLE ADMIN_ROLE;/);
    // Generated grant lines must not use IDENTIFIER when the operator opted out.
    const grantLines = sql.split('\n').filter(l => l.startsWith('GRANT'));
    for (const line of grantLines) expect(line).not.toMatch(/IDENTIFIER/);
  });

  it('appends IDEMPOTENCY_KEY STRING to every signature', async () => {
    const out = tmpFile('grants-key.sql');
    await buildGrants({ procs: [userViewerProc], out });
    const sql = fs.readFileSync(out, 'utf8');
    // list_widgets has one nullable string arg + the framework-injected key
    expect(sql).toMatch(/list_widgets\(STRING, STRING\)/);
  });

  it('emits audit-table DML grants only for roles with CALLER-mode procs', async () => {
    const callerProc = defineProc({
      name: 'my_actions',
      roles: ['user'],
      executeAs: 'CALLER',
      args: {},
      returns: { ok: t.boolean() },
      execute: async () => ({ ok: true }),
    });
    const ownerProc = defineProc({
      name: 'admin_task',
      roles: ['admin'],
      // no executeAs -> defaults to OWNER
      args: {},
      returns: { ok: t.boolean() },
      execute: async () => ({ ok: true }),
    });
    const out = tmpFile('grants-audit.sql');
    await buildGrants({
      procs: [callerProc, ownerProc],
      out,
      auditTable: 'DB.SCH.VERB_ATTEMPT',
    });
    const sql = fs.readFileSync(out, 'utf8');
    // user has a CALLER proc -> gets audit DML
    expect(sql).toMatch(/GRANT INSERT, SELECT ON TABLE DB\.SCH\.VERB_ATTEMPT TO ROLE IDENTIFIER\(\$user_role\);/);
    // admin only has an OWNER proc -> no audit grant (the proc body runs as owner)
    const adminBlock = sql.match(/-- role: admin[\s\S]*?(?=-- role:|$)/)?.[0] ?? '';
    expect(adminBlock).not.toMatch(/VERB_ATTEMPT/);
  });

  it('omits audit grants entirely when auditTable option is unset', async () => {
    const callerProc = defineProc({
      name: 'my_actions',
      roles: ['user'],
      executeAs: 'CALLER',
      args: {},
      returns: { ok: t.boolean() },
      execute: async () => ({ ok: true }),
    });
    const out = tmpFile('grants-noaudit.sql');
    await buildGrants({ procs: [callerProc], out });
    const sql = fs.readFileSync(out, 'utf8');
    expect(sql).not.toMatch(/VERB_ATTEMPT/);
  });
});
