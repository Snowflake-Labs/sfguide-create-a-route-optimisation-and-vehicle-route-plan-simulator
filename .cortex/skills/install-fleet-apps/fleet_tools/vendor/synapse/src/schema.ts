import { fail } from './errors.js';

/**
 * Schema kind tag. The DDL emitter walks this tree to map TS schemas to SQL types
 * (`string` -> STRING, `number` -> FLOAT, etc.). The local-runtime parse() path
 * never reads `kind`; it's purely metadata for build-time tooling.
 */
export type SchemaKind =
  | 'string' | 'uuid' | 'boolean' | 'number'
  | 'array' | 'object' | 'nullable' | 'enum';

export interface Schema<T> {
  readonly _t: T;
  readonly kind: SchemaKind;
  /** Set on `array` and `nullable`. */
  readonly inner?: Schema<unknown>;
  /** Set on `object`. */
  readonly shape?: Record<string, Schema<unknown>>;
  /** Set on `enum`. The allowed string-literal values, in declaration order. */
  readonly values?: readonly string[];
  /**
   * Human-readable gloss surfaced into JSON Schema (`description`) at build
   * time, which propagates to MCP `inputSchema` tool definitions. Set via
   * `.describe(text)`. Build-time metadata only — `parse()` ignores it.
   */
  readonly description?: string;
  parse(value: unknown, path?: string): T;
  nullable(): Schema<T | null>;
  /** Return a shallow copy of this schema with `description` set. */
  describe(text: string): Schema<T>;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;
export type InferRecord<R extends Record<string, Schema<unknown>>> = {
  [K in keyof R]: Infer<R[K]>;
};

/**
 * IMPORTANT: Snowflake's JS-proc V8 does NOT short-circuit `&&` reliably
 * (verified via probe, snowhouse 2026-05-27). Code like `if (x && x.test(v))`
 * evaluates both sides even when `x` is undefined, throwing "Cannot read
 * properties of undefined". This file uses explicit `if`-statement chains
 * instead of `&&`/`||` short-circuiting.
 *
 * This is the "short-circuit trap" called out in LEARNINGS §6 — the fix is to
 * never rely on `&&` short-circuit in any code that may run inside a sproc body.
 */

function nullable<T>(innerSchema: Schema<T>): Schema<T | null> {
  const self: Schema<T | null> = {
    _t: null as T | null,
    kind: 'nullable',
    inner: innerSchema as Schema<unknown>,
    parse(v, path) {
      if (v === null || v === undefined) return null;
      return innerSchema.parse(v, path);
    },
    nullable() { return self; },
    describe(text) { return withDescription(self, text); },
  };
  return self;
}

/**
 * Return a copy of `self` with `description` set. Used by `.describe()` on
 * every schema kind. Spread copies all enumerable own properties — including
 * the bound `parse`/`nullable`/`describe` methods — so the clone behaves
 * identically except for the new `description` field.
 *
 * Re-binds `describe` to the new copy so chained `.describe(a).describe(b)`
 * reads `b` (idempotent overwrite) rather than re-applying to the original.
 *
 * Re-binds `nullable` to wrap `copy` (not the original) so a description
 * attached before `.nullable()` survives into the inner schema of the
 * resulting nullable wrapper. Without this rebind, `nullable()` is the
 * closure created by the constructor over the description-less original.
 */
function withDescription<T>(self: Schema<T>, text: string): Schema<T> {
  const copy: Schema<T> = { ...self, description: text };
  copy.describe = (next: string) => withDescription(copy, next);
  copy.nullable = () => nullable(copy);
  return copy;
}

function labelOf(path: string | undefined, fallback: string): string {
  if (path === undefined) return fallback;
  if (path.length === 0) return fallback;
  return path;
}

export interface StringOpts {
  min?: number;
  max?: number;
  regex?: RegExp;
}

function stringSchema(rawOpts?: StringOpts): Schema<string> {
  const opts: StringOpts = rawOpts || {};
  const min = opts.min;
  const max = opts.max;
  const regex = opts.regex;
  const self: Schema<string> = {
    _t: '' as string,
    kind: 'string',
    parse(v, path) {
      const label = labelOf(path, 'value');
      if (typeof v !== 'string') {
        fail('BAD_VALUE_TYPE', `${label} not a string: ${typeof v}`);
      }
      if (min !== undefined) {
        if (v.length < min) {
          fail('BAD_VALUE_TYPE', `${label} too short (min ${min}, got ${v.length})`);
        }
      }
      if (max !== undefined) {
        if (v.length > max) {
          fail('BAD_VALUE_TYPE', `${label} too long (max ${max}, got ${v.length})`);
        }
      }
      if (regex !== undefined) {
        if (!regex.test(v)) {
          fail('BAD_VALUE_TYPE', `${label} regex failed: ${regex}`);
        }
      }
      return v;
    },
    nullable() { return nullable(self); },
    describe(text) { return withDescription(self, text); },
  };
  return self;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function uuidSchema(): Schema<string> {
  const self: Schema<string> = {
    _t: '' as string,
    kind: 'uuid',
    parse(v, path) {
      const label = labelOf(path, 'value');
      if (typeof v !== 'string') {
        fail('BAD_VALUE_TYPE', `${label} not a string: ${typeof v}`);
      }
      if (!UUID_RE.test(v)) {
        fail('BAD_VALUE_TYPE', `${label} not a uuid: ${v}`);
      }
      return v;
    },
    nullable() { return nullable(self); },
    describe(text) { return withDescription(self, text); },
  };
  return self;
}

function booleanSchema(): Schema<boolean> {
  const self: Schema<boolean> = {
    _t: false as boolean,
    kind: 'boolean',
    parse(v, path) {
      const label = labelOf(path, 'value');
      // Snowflake's JS connector sometimes surfaces BOOLEAN bind args as
      // numeric 0/1 inside a stored procedure body. Accept that as a synonym
      // for false/true rather than reject the call.
      if (typeof v === 'number' && (v === 0 || v === 1)) return v === 1;
      if (typeof v !== 'boolean') {
        fail('BAD_VALUE_TYPE', `${label} not a boolean: ${typeof v}`);
      }
      return v;
    },
    nullable() { return nullable(self); },
    describe(text) { return withDescription(self, text); },
  };
  return self;
}

function numberSchema(): Schema<number> {
  const self: Schema<number> = {
    _t: 0 as number,
    kind: 'number',
    parse(v, path) {
      const label = labelOf(path, 'value');
      if (typeof v !== 'number') {
        fail('BAD_VALUE_TYPE', `${label} not a finite number: ${typeof v}`);
      }
      if (!Number.isFinite(v)) {
        fail('BAD_VALUE_TYPE', `${label} not a finite number: ${typeof v}`);
      }
      return v;
    },
    nullable() { return nullable(self); },
    describe(text) { return withDescription(self, text); },
  };
  return self;
}

function arraySchema<T>(innerSchema: Schema<T>): Schema<T[]> {
  const self: Schema<T[]> = {
    _t: [] as T[],
    kind: 'array',
    inner: innerSchema as Schema<unknown>,
    parse(v, path) {
      const label = labelOf(path, 'value');
      if (!Array.isArray(v)) {
        fail('BAD_VALUE_TYPE', `${label} not an array: ${typeof v}`);
      }
      const out: T[] = [];
      for (let i = 0; i < v.length; i++) {
        out.push(innerSchema.parse(v[i], `${label}[${i}]`));
      }
      return out;
    },
    nullable() { return nullable(self); },
    describe(text) { return withDescription(self, text); },
  };
  return self;
}

function objectSchema<R extends Record<string, Schema<unknown>>>(shape: R): Schema<InferRecord<R>> {
  const self: Schema<InferRecord<R>> = {
    _t: {} as InferRecord<R>,
    kind: 'object',
    shape: shape as Record<string, Schema<unknown>>,
    parse(v, path) {
      const label = labelOf(path, 'value');
      if (v === null) {
        fail('BAD_VALUE_TYPE', `${label} not an object: null`);
      }
      if (typeof v !== 'object') {
        fail('BAD_VALUE_TYPE', `${label} not an object: ${typeof v}`);
      }
      if (Array.isArray(v)) {
        fail('BAD_VALUE_TYPE', `${label} not an object: array`);
      }
      const obj = v as Record<string, unknown>;
      // Empty shape (`t.object({})`) means "passthrough" — accept arbitrary
      // keys/values. This is how `account_scope` and `partial_rollout` survive
      // the envelope's parse step in request_rollout / validate_account_scope.
      if (Object.keys(shape).length === 0) {
        return obj as InferRecord<R>;
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        const childPath = path === undefined || path.length === 0
          ? key
          : `${path}.${key}`;
        out[key] = shape[key]!.parse(obj[key], childPath);
      }
      return out as InferRecord<R>;
    },
    nullable() { return nullable(self); },
    describe(text) { return withDescription(self, text); },
  };
  return self;
}

function enumSchema<T extends string>(values: readonly T[]): Schema<T> {
  if (values.length === 0) {
    throw new Error('t.enum() requires at least one value');
  }
  const set = new Set<string>(values);
  const list = values.join(' | ');
  const self: Schema<T> = {
    _t: values[0]!,
    kind: 'enum',
    values: values as readonly string[],
    parse(v, path) {
      const label = labelOf(path, 'value');
      if (typeof v !== 'string') {
        fail('BAD_VALUE_TYPE', `${label} not a string: ${typeof v}`);
      }
      if (!set.has(v)) {
        fail('BAD_VALUE_TYPE', `${label} not in (${list}): ${JSON.stringify(v)}`);
      }
      return v as T;
    },
    nullable() { return nullable(self); },
    describe(text) { return withDescription(self, text); },
  };
  return self;
}

export const t = {
  string:  (opts?: StringOpts) => stringSchema(opts),
  uuid:    () => uuidSchema(),
  boolean: () => booleanSchema(),
  number:  () => numberSchema(),
  array:   <T>(inner: Schema<T>) => arraySchema(inner),
  object:  <R extends Record<string, Schema<unknown>>>(shape: R) => objectSchema(shape),
  enum:    <T extends string>(values: readonly T[]) => enumSchema(values),
};
