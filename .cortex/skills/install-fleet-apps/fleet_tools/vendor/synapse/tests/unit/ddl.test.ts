import { describe, it, expect } from 'vitest';
import { defineProc, t } from '../../src/index.js';
import { procDDL, sqlType, quoteArg, argsCaptureSuffix } from '../../src/build/ddl.js';

const sample = defineProc({
  name: 'sample',
  args: {
    rollout_id: t.uuid(),
    group:      t.string({ min: 1 }),
    comment:    t.string().nullable(),
    count:      t.number(),
    flags:      t.array(t.string()),
    flag:       t.boolean(),
  },
  returns: { ok: t.boolean() },
  execute: async () => ({ ok: true }),
});

describe('DDL emitter', () => {
  describe('sqlType', () => {
    it('maps each schema kind to the right SQL type', () => {
      expect(sqlType(t.uuid())).toBe('STRING');
      expect(sqlType(t.string())).toBe('STRING');
      expect(sqlType(t.boolean())).toBe('BOOLEAN');
      expect(sqlType(t.number())).toBe('FLOAT');           // LEARNINGS §6: not NUMBER
      expect(sqlType(t.array(t.string()))).toBe('ARRAY');
      expect(sqlType(t.object({ x: t.string() }))).toBe('OBJECT');
    });

    it('recurses through nullable wrappers', () => {
      expect(sqlType(t.string().nullable())).toBe('STRING');
      expect(sqlType(t.number().nullable())).toBe('FLOAT');
    });
  });

  describe('quoteArg', () => {
    it('uppercases plain names', () => {
      expect(quoteArg('rollout_id')).toBe('ROLLOUT_ID');
      expect(quoteArg('count')).toBe('COUNT');
    });

    it('double-quotes reserved words', () => {
      expect(quoteArg('group')).toBe('"GROUP"');
      expect(quoteArg('order')).toBe('"ORDER"');
      expect(quoteArg('table')).toBe('"TABLE"');
    });
  });

  describe('procDDL', () => {
    it('emits the canonical CREATE OR REPLACE PROCEDURE shape', () => {
      const ddl = procDDL(sample, { body: 'return {ok: true};' });
      expect(ddl).toContain('CREATE OR REPLACE PROCEDURE sample(');
      expect(ddl).toContain('EXECUTE AS OWNER');
      expect(ddl).toContain('$$\nreturn {ok: true};\n$$;');
    });

    // LOCAL PATCH guard (see ../../VENDOR.md). Two invariants in one test:
    // the tracking COMMENT is emitted at all, and it sits BEFORE `EXECUTE AS`.
    // Snowflake rejects the reverse order with "unexpected COMMENT", which
    // aborts the whole `synapse deploy` - no MCP server, so the agent silently
    // has no tools. Cheap to regress on a re-vendor, expensive to diagnose.
    it('emits the tracking COMMENT before EXECUTE AS', () => {
      const ddl = procDDL(sample, { body: '' });
      expect(ddl).toContain('"origin":"sf_sit-is-fleet"');
      const comment = ddl.indexOf("COMMENT='");
      const executeAs = ddl.indexOf('EXECUTE AS');
      expect(comment).toBeGreaterThan(-1);
      expect(comment).toBeLessThan(executeAs);
    });

    it('appends IDEMPOTENCY_KEY STRING DEFAULT NULL as the last arg', () => {
      const ddl = procDDL(sample, { body: '' });
      // Last arg before the closing paren must be IDEMPOTENCY_KEY, and it must
      // carry a DEFAULT so an MCP dispatcher calling with named args can omit
      // it (dc8827c3 added the DEFAULT but left this assertion on the old form).
      expect(ddl).toMatch(/IDEMPOTENCY_KEY STRING DEFAULT NULL\)/);
    });

    it('quotes reserved-word args', () => {
      const ddl = procDDL(sample, { body: '' });
      expect(ddl).toContain('"GROUP" STRING');
    });

    it('maps every arg type', () => {
      const ddl = procDDL(sample, { body: '' });
      expect(ddl).toContain('ROLLOUT_ID STRING');
      expect(ddl).toContain('COMMENT STRING');     // nullable string -> STRING
      expect(ddl).toContain('COUNT FLOAT');
      expect(ddl).toContain('FLAGS ARRAY');
      expect(ddl).toContain('FLAG BOOLEAN');
    });

    it('honors EXECUTE AS CALLER when requested', () => {
      const ddl = procDDL(sample, { body: '', executeAs: 'CALLER' });
      expect(ddl).toContain('EXECUTE AS CALLER');
    });
  });

  describe('argsCaptureSuffix', () => {
    it('emits a JS object literal mapping each arg name to its uppercase identifier', () => {
      const suffix = argsCaptureSuffix(sample);
      expect(suffix).toContain('"rollout_id": ROLLOUT_ID');
      expect(suffix).toContain('"group": GROUP');
      expect(suffix).toContain('"comment": COMMENT');
      expect(suffix).toContain('return __synapseEntry(__args, IDEMPOTENCY_KEY);');
    });
  });
});
