import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as url from 'node:url';
import { defineProc, t } from '../../src/index.js';
import { bundleProc } from '../../src/build/bundle.js';

// Catalog target for the esbuild `define` substitution of __SYNAPSE_DATABASE__ /
// __SYNAPSE_SCHEMA__. bundleProc gained this required third arg upstream in
// dc8827c3 (FQ catalog) but the fixtures below were not updated, so every case
// threw "Cannot read properties of undefined (reading 'database')".
const CATALOG = { database: 'TEST_DB', schema: 'TEST_SCHEMA' };

describe('build/bundle', () => {
  let tmpDir: string;
  let entryPath: string;

  beforeAll(() => {
    // Write a tiny verb to a temp file. The verb does an async exec to
    // exercise the async/await -> __async lowering path.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-bundle-test-'));
    entryPath = path.join(tmpDir, 'noop.ts');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const synapseRoot = path.resolve(here, '../../src/index.ts');
    fs.writeFileSync(entryPath, `
import { defineProc, t } from ${JSON.stringify(synapseRoot)};

export const noop = defineProc({
  name: 'noop',
  args:    { x: t.string() },
  returns: { ok: t.boolean(), echoed: t.string() },
  execute: async (args, ctx) => {
    const r = await ctx.conn.execRow<{ V: string }>('SELECT ? AS v', [args.x]);
    return { ok: true, echoed: r?.V ?? '' };
  },
});
`);
  });

  function buildNoop() {
    return defineProc({
      name: 'noop',
      args:    { x: t.string() },
      returns: { ok: t.boolean(), echoed: t.string() },
      execute: async () => ({ ok: true, echoed: '' }),
    });
  }

  it('emits a self-contained body with no imports / no top-level await', async () => {
    const body = await bundleProc(
      { proc: buildNoop(), procModulePath: entryPath, exportName: 'noop' },
      { table: 'verb_attempt' },
      CATALOG,
    );
    expect(body).not.toMatch(/^\s*import\s+/m);
    expect(body).not.toMatch(/(?<![A-Za-z_$.])require\s*\(/);
    expect(body).not.toMatch(/\bprocess\s*\.\s*env\b/);
    expect(body).not.toMatch(/\bimport\s*\.\s*meta\b/);
    expect(body).not.toMatch(/^\s*await\s+/m);
  });

  it('inlines the _n bind normalizer at the top', async () => {
    const body = await bundleProc(
      { proc: buildNoop(), procModulePath: entryPath, exportName: 'noop' },
      { table: 'verb_attempt' },
      CATALOG,
    );
    expect(body.indexOf('function _n(v)')).toBeGreaterThanOrEqual(0);
    // _n should be at the top, before the IIFE.
    const nIdx = body.indexOf('function _n(v)');
    const iifeIdx = body.indexOf('var __synapse');
    expect(nIdx).toBeLessThan(iifeIdx);
  });

  it('swaps __async for the synchronous generator driver', async () => {
    const body = await bundleProc(
      { proc: buildNoop(), procModulePath: entryPath, exportName: 'noop' },
      { table: 'verb_attempt' },
      CATALOG,
    );
    // The swap preserves the declarator shape (arrow expression) but replaces
    // the body. Look for the sync-driver loop.
    expect(body).toMatch(/var __async = \(__this, __arguments, generator\) =>/);
    expect(body).toMatch(/while\s*\(\s*!step\.done\s*\)/);
    // The original esbuild __async uses `Promise.resolve(x.value).then(fulfilled, rejected)`
    // — that signature should be GONE after the swap.
    expect(body).not.toMatch(/Promise\.resolve\([^)]*\)\.then\(fulfilled,\s*rejected\)/);
    // Sanity: no other Promise references in the helper region.
    expect(body).not.toMatch(/return new Promise/);
  });

  it('appends the args-capture suffix that calls __synapse.__synapseEntry', async () => {
    const proc = defineProc({
      name: 'noop2',
      args:    { x: t.string(), y: t.number() },
      returns: { ok: t.boolean() },
      execute: async () => ({ ok: true }),
    });
    const body = await bundleProc(
      { proc, procModulePath: entryPath, exportName: 'noop' },
      { table: 'verb_attempt' },
      CATALOG,
    );
    expect(body).toContain('"x": X');
    expect(body).toContain('"y": Y');
    expect(body).toContain('return __synapseEntry(__args, IDEMPOTENCY_KEY);');
  });

  it('replaces audit-config placeholders with build options', async () => {
    const body = await bundleProc(
      { proc: buildNoop(), procModulePath: entryPath, exportName: 'noop' },
      { table: 'my_audit_table', appIdField: 'rollout_id' },
      CATALOG,
    );
    expect(body).not.toContain('__SYNAPSE_AUDIT_TABLE__');
    expect(body).not.toContain('__SYNAPSE_APP_ID_FIELD__');
    // esbuild normalizes string literals to double-quoted form; astring
    // round-trips them as such.
    expect(body).toContain('"my_audit_table"');
    expect(body).toContain('"rollout_id"');
  });

  it('runs synchronously in a vm with a fake snowflake global', async () => {
    // The verification test the AST swap was added to support: actually
    // execute the bundled body in a vm, with a fake `snowflake.execute`
    // global, and assert the verb returns a plain value (not a Promise).
    //
    // This catches: a regression where the __async swap silently fails
    // (esbuild changes its lowering shape, the AST walker doesn't find
    // the helper) — the bundle would still return a Promise and we'd be
    // emitting broken sprocs. The vm test fails loudly the moment that
    // happens.
    const { default: vm } = await import('node:vm');

    const proc = defineProc({
      name: 'echo',
      args: { x: t.string() },
      returns: { ok: t.boolean(), echoed: t.string() },
      execute: async (args, ctx) => {
        // Two awaits to exercise the generator's multi-yield path.
        const a = await ctx.conn.execScalar<string>('SELECT ? AS X', [args.x]);
        const b = await ctx.conn.execRow<{ N: number }>('SELECT 1 AS N', []);
        void b;
        return { ok: true, echoed: String(a ?? '') };
      },
    });
    // Re-write a temp file with the same proc shape so the bundler can
    // import it. The file's source uses a path-based import to the
    // framework's index so esbuild can resolve types.
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const synapseRoot = path.resolve(here, '../../src/index.ts');
    const echoPath = path.join(tmpDir, 'echo.ts');
    fs.writeFileSync(echoPath, `
import { defineProc, t } from ${JSON.stringify(synapseRoot)};
export const echo = defineProc({
  name: 'echo',
  args: { x: t.string() },
  returns: { ok: t.boolean(), echoed: t.string() },
  execute: async (args, ctx) => {
    const a = await ctx.conn.execScalar('SELECT ? AS X', [args.x]);
    const b = await ctx.conn.execRow('SELECT 1 AS N', []);
    void b;
    return { ok: true, echoed: String(a ?? '') };
  },
});
`);
    const body = await bundleProc(
      { proc, procModulePath: echoPath, exportName: 'echo' },
      { table: 'verb_attempt', appIdField: 'rollout_id' },
      CATALOG,
    );

    // Build the fake snowflake global. snowflake.execute returns a
    // ResultSet-like object with sync methods.
    const calls: Array<{ sqlText: string; binds: unknown[] }> = [];
    const fakeSnowflake = {
      execute: (opts: { sqlText: string; binds?: unknown[] }) => {
        calls.push({ sqlText: opts.sqlText, binds: opts.binds ?? [] });
        // Drive a tiny FSM: each call returns one canned row.
        let yielded = false;
        // Determine canned response based on sql content.
        let row: Record<string, unknown> = {};
        if (/CURRENT_USER\(\)/.test(opts.sqlText)) {
          row = { U: 'TEST_USER', R: 'TEST_ROLE' };
        } else if (/SELECT \? AS X/.test(opts.sqlText)) {
          row = { X: opts.binds?.[0] };
        } else if (/SELECT 1 AS N/.test(opts.sqlText)) {
          row = { N: 1 };
        } else if (/SELECT SHA2/.test(opts.sqlText)) {
          row = { 'SHA2(?)': 'fake-hash' };
        }
        const colNames = Object.keys(row);
        return {
          next: () => {
            if (yielded) return false;
            yielded = true;
            return true;
          },
          getColumnCount: () => colNames.length,
          getColumnName: (i: number) => colNames[i - 1]!,
          getColumnValue: (i: number) => row[colNames[i - 1]!],
        };
      },
    };

    // The bundle expects to be called inside a function body (it ends with
    // `return ...`). Wrap it in a function so vm.runInNewContext can
    // execute it.
    //
    // Snowflake's JS proc runtime exposes args as global identifiers
    // (uppercased). Set them on the context.
    const ctx = vm.createContext({
      snowflake: fakeSnowflake,
      X: 'hello',
      IDEMPOTENCY_KEY: null,
      console,
    });
    const wrapped = `(function() {\n${body}\n})()`;
    const result = vm.runInContext(wrapped, ctx);

    // The crucial assertion: the result is a plain value, NOT a Promise.
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result).toBe('object');
    expect(result).toMatchObject({ ok: true, echoed: 'hello' });

    // Sanity: identity + execute calls happened.
    expect(calls.some(c => /CURRENT_USER/.test(c.sqlText))).toBe(true);
    expect(calls.some(c => /SELECT \? AS X/.test(c.sqlText))).toBe(true);
  });

  it('rewrites && / || to ternary expressions (Snowflake V8 short-circuit quirk)', async () => {
    // Snowflake's JS-proc V8 doesn't short-circuit `&&`/`||` reliably (verified
    // via probe, snowhouse 2026-05-27). The bundler rewrites every
    // LogicalExpression to a ConditionalExpression. Verify the bundle has no
    // surviving `&&`/`||`/`??`.
    const body = await bundleProc(
      { proc: buildNoop(), procModulePath: entryPath, exportName: 'noop' },
      { table: 'verb_attempt' },
      CATALOG,
    );
    expect(body).not.toMatch(/\s&&\s/);
    expect(body).not.toMatch(/\s\|\|\s/);
    expect(body).not.toMatch(/\s\?\?\s/);
  });
}, { timeout: 30_000 });
