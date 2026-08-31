import { describe, it, expect } from 'vitest';
import { t } from '../../src/index.js';
import { SynapseError } from '../../src/errors.js';

describe('schema DSL', () => {
  describe('t.string', () => {
    it('accepts strings', () => {
      expect(t.string().parse('hello')).toBe('hello');
    });
    it('rejects non-strings', () => {
      expect(() => t.string().parse(42)).toThrow(SynapseError);
      expect(() => t.string().parse(null)).toThrow(SynapseError);
      expect(() => t.string().parse(undefined)).toThrow(SynapseError);
    });
    it('enforces min/max', () => {
      const s = t.string({ min: 2, max: 5 });
      expect(s.parse('abc')).toBe('abc');
      expect(() => s.parse('a')).toThrow(/too short/);
      expect(() => s.parse('toolong')).toThrow(/too long/);
    });
    it('enforces regex', () => {
      const s = t.string({ regex: /^[A-Z]+$/ });
      expect(s.parse('ABC')).toBe('ABC');
      expect(() => s.parse('abc')).toThrow(/regex/);
    });
  });

  describe('t.uuid', () => {
    it('accepts a uuid', () => {
      expect(t.uuid().parse('550e8400-e29b-41d4-a716-446655440000'))
        .toBe('550e8400-e29b-41d4-a716-446655440000');
    });
    it('rejects non-uuid strings', () => {
      expect(() => t.uuid().parse('not-a-uuid')).toThrow(SynapseError);
    });
  });

  describe('t.boolean', () => {
    it('accepts booleans', () => {
      expect(t.boolean().parse(true)).toBe(true);
      expect(t.boolean().parse(false)).toBe(false);
    });
    it('accepts numeric 0/1 (Snowflake BOOLEAN bind quirk)', () => {
      expect(t.boolean().parse(0)).toBe(false);
      expect(t.boolean().parse(1)).toBe(true);
    });
    it('rejects non-boolean / non-0/1 inputs', () => {
      expect(() => t.boolean().parse(2)).toThrow(SynapseError);
      expect(() => t.boolean().parse('true')).toThrow(SynapseError);
    });
  });

  describe('t.number', () => {
    it('accepts finite numbers', () => {
      expect(t.number().parse(42)).toBe(42);
      expect(t.number().parse(-1.5)).toBe(-1.5);
    });
    it('rejects NaN/Infinity/non-number', () => {
      expect(() => t.number().parse(NaN)).toThrow(SynapseError);
      expect(() => t.number().parse(Infinity)).toThrow(SynapseError);
      expect(() => t.number().parse('42')).toThrow(SynapseError);
    });
  });

  describe('t.array', () => {
    it('accepts arrays of valid items', () => {
      expect(t.array(t.string()).parse(['a', 'b'])).toEqual(['a', 'b']);
    });
    it('rejects non-array values', () => {
      expect(() => t.array(t.string()).parse('abc')).toThrow(SynapseError);
    });
    it('rejects arrays with bad items', () => {
      expect(() => t.array(t.string()).parse(['a', 1])).toThrow(SynapseError);
    });
  });

  describe('t.object', () => {
    it('parses each field', () => {
      const s = t.object({ name: t.string(), age: t.number() });
      expect(s.parse({ name: 'Ada', age: 36 })).toEqual({ name: 'Ada', age: 36 });
    });
    it('reports nested path on failure', () => {
      const s = t.object({ name: t.string() });
      try {
        s.parse({ name: 42 });
        throw new Error('expected throw');
      } catch (e) {
        expect((e as SynapseError).message).toMatch(/name/);
      }
    });
    it('rejects non-objects', () => {
      expect(() => t.object({}).parse([])).toThrow(SynapseError);
      expect(() => t.object({}).parse(null)).toThrow(SynapseError);
    });
  });

  describe('t.enum', () => {
    it('accepts declared values, rejects others', () => {
      const s = t.enum(['set', 'unset']);
      expect(s.parse('set')).toBe('set');
      expect(s.parse('unset')).toBe('unset');
      expect(() => s.parse('other')).toThrow(SynapseError);
      expect(() => s.parse(42)).toThrow(SynapseError);
      expect(() => s.parse(null)).toThrow(SynapseError);
    });
    it('exposes values for build-time tooling', () => {
      const s = t.enum(['a', 'b', 'c']);
      expect(s.kind).toBe('enum');
      expect([...(s.values ?? [])]).toEqual(['a', 'b', 'c']);
    });
    it('nullable() accepts null', () => {
      const s = t.enum(['x', 'y']).nullable();
      expect(s.parse(null)).toBeNull();
      expect(s.parse('x')).toBe('x');
      expect(() => s.parse('z')).toThrow(SynapseError);
    });
  });

  describe('.nullable()', () => {
    it('accepts null and undefined as null', () => {
      const s = t.string().nullable();
      expect(s.parse('x')).toBe('x');
      expect(s.parse(null)).toBeNull();
      expect(s.parse(undefined)).toBeNull();
    });
    it('still rejects bad types', () => {
      const s = t.string().nullable();
      expect(() => s.parse(42)).toThrow(SynapseError);
    });
  });

  describe('.describe()', () => {
    it('attaches description to every kind, leaves parse intact', () => {
      const cases = [
        t.string().describe('a string'),
        t.uuid().describe('a uuid'),
        t.boolean().describe('a boolean'),
        t.number().describe('a number'),
        t.array(t.string()).describe('a list'),
        t.object({ k: t.string() }).describe('an object'),
        t.enum(['a', 'b']).describe('a choice'),
      ];
      for (const s of cases) {
        expect(s.description).toMatch(/^a/);
      }
      expect(t.string().describe('x').parse('hi')).toBe('hi');
      expect(t.number().describe('x').parse(7)).toBe(7);
      expect(t.enum(['a', 'b']).describe('x').parse('a')).toBe('a');
      expect(() => t.string().describe('x').parse(42)).toThrow(SynapseError);
    });
    it('describe() is idempotent — last call wins', () => {
      const s = t.string().describe('first').describe('second');
      expect(s.description).toBe('second');
    });
    it('original schema is not mutated by describe()', () => {
      const base = t.string();
      const tagged = base.describe('hello');
      expect(base.description).toBeUndefined();
      expect(tagged.description).toBe('hello');
    });
    it('nullable() carries the inner description into JSON Schema (description is on the inner)', () => {
      const s = t.string().describe('inner').nullable();
      expect(s.description).toBeUndefined();
      expect(s.inner?.description).toBe('inner');
    });
  });
});
