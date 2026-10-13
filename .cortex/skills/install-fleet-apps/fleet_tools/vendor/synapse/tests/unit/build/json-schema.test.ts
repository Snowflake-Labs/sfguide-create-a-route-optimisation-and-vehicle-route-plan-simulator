import { describe, it, expect } from 'vitest';
import { t } from '../../../src/index.js';
import { toJsonSchema, toToolInputSchema } from '../../../src/build/json-schema.js';

describe('toJsonSchema', () => {
  it('maps string -> {type:string}', () => {
    expect(toJsonSchema(t.string())).toEqual({ type: 'string' });
  });
  it('maps uuid -> {type:string, format:uuid}', () => {
    expect(toJsonSchema(t.uuid())).toEqual({ type: 'string', format: 'uuid' });
  });
  it('maps number/boolean', () => {
    expect(toJsonSchema(t.number())).toEqual({ type: 'number' });
    expect(toJsonSchema(t.boolean())).toEqual({ type: 'boolean' });
  });
  it('maps enum -> {type:string, enum:[...]}', () => {
    expect(toJsonSchema(t.enum(['a', 'b']))).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    });
  });
  it('maps array recursively', () => {
    expect(toJsonSchema(t.array(t.string()))).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });
  it('maps object with required keys', () => {
    expect(toJsonSchema(t.object({ a: t.string(), b: t.number() }))).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a', 'b'],
    });
  });
  it('empty object shape -> additionalProperties:true', () => {
    expect(toJsonSchema(t.object({}))).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });
  it('nullable -> oneOf', () => {
    expect(toJsonSchema(t.string().nullable())).toEqual({
      oneOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  describe('description threading', () => {
    it('attaches description to every kind', () => {
      expect(toJsonSchema(t.string().describe('hi'))).toEqual({
        type: 'string',
        description: 'hi',
      });
      expect(toJsonSchema(t.enum(['x', 'y']).describe('xy'))).toEqual({
        type: 'string',
        enum: ['x', 'y'],
        description: 'xy',
      });
      expect(toJsonSchema(t.array(t.number()).describe('list'))).toEqual({
        type: 'array',
        items: { type: 'number' },
        description: 'list',
      });
    });
    it('inner description survives in nested arrays/objects', () => {
      expect(toJsonSchema(t.array(t.string().describe('elem')))).toEqual({
        type: 'array',
        items: { type: 'string', description: 'elem' },
      });
      expect(toJsonSchema(t.object({ a: t.string().describe('an a') }))).toEqual({
        type: 'object',
        properties: { a: { type: 'string', description: 'an a' } },
        required: ['a'],
      });
    });
    it('describe() on a nullable wrapper: outer desc lands at top level, inner desc lands inside oneOf', () => {
      // Common case: t.string().describe('x').nullable() — desc on inner.
      expect(toJsonSchema(t.string().describe('inner').nullable())).toEqual({
        oneOf: [{ type: 'string', description: 'inner' }, { type: 'null' }],
      });
      // Reverse case: t.string().nullable().describe('x') — desc on outer.
      expect(toJsonSchema(t.string().nullable().describe('outer'))).toEqual({
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: 'outer',
      });
    });
  });
});

describe('toToolInputSchema', () => {
  it('wraps args in {args, idempotency_key}', () => {
    const out = toToolInputSchema({
      foo: t.string().describe('a foo'),
      bar: t.number(),
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        args: {
          type: 'object',
          properties: {
            foo: { type: 'string', description: 'a foo' },
            bar: { type: 'number' },
          },
          required: ['foo', 'bar'],
        },
        idempotency_key: { type: 'string' },
      },
      required: ['args'],
    });
  });
});
