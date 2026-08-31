import type { Conn } from '../connector.js';
import type { ProcDef } from '../defineProc.js';
import type { Schema } from '../schema.js';
import { SynapseError } from '../errors.js';
import type { Runtime, ProcCall } from './index.js';

/**
 * Build a client-side runtime that dispatches verb calls to deployed sprocs
 * via `CALL <verb>(?, ?, ...)`. Same shape as `createSynapseRuntime` but the
 * envelope (validate / identity / audit) lives inside Snowflake — we just
 * shuttle args in and unwrap the OBJECT result on the way out.
 *
 * The args passed in must already be the canonical argument record (matching
 * `proc.args`); they're fed into the CALL in the order Snowflake expects:
 * the proc's declared arg list, then the framework-injected `IDEMPOTENCY_KEY`.
 *
 * Snowflake returns a JS proc's OBJECT/VARIANT result wrapped in a
 * single-row resultset under a column named after the proc (uppercased).
 * Sometimes the connector hands it back as a parsed object; sometimes as a
 * JSON string. We tolerate both.
 *
 * Errors from `ctx.fail(code, msg)` inside a proc bubble up wrapped in
 * snowflake-sdk's OperationFailedError. We detect the SynapseError signature
 * in the wrapped message and re-throw a proper `SynapseError` with the
 * original code preserved — otherwise callers can't `try { ... } catch (e)`
 * on `e.code === 'SESSION_NOT_FOUND'`.
 */
export function wireSprocClient<P extends Record<string, ProcDef<string, any, any>>>(
  conn: Conn,
  procs: P,
): Runtime<P> {
  const result: Record<string, ProcCall<any, any>> = {};
  for (const procName of Object.keys(procs)) {
    const proc = procs[procName as keyof P]!;
    const argNames = Object.keys(proc.args);
    const argSchemas = argNames.map(n => (proc.args as Record<string, Schema<unknown>>)[n]!);
    // Build the placeholder list: `PARSE_JSON(?)` for ARRAY/OBJECT args, plain
    // `?` for everything else. Snowflake's JS connector binds primitives
    // straight to STRING/FLOAT/BOOLEAN, but for ARRAY/OBJECT proc args it
    // refuses to coerce a JS array/object straight to the typed param --
    // PARSE_JSON on a JSON string is the canonical workaround.
    const placeholders = argSchemas.map(s => {
      const k = unwrapKind(s);
      return (k === 'array' || k === 'object') ? 'PARSE_JSON(?)' : '?';
    });
    placeholders.push('?'); // idempotency_key
    const sql = `CALL ${proc.name}(${placeholders.join(', ')})`;

    result[procName] = async (rawArgs, callOpts) => {
      const ordered = argNames.map((name, i) => {
        const raw = (rawArgs as Record<string, unknown>)[name];
        return serializeForCall(raw, argSchemas[i]!);
      });
      ordered.push(callOpts?.idempotency_key ?? null);

      let row: Record<string, unknown> | null;
      try {
        row = await conn.execRow<Record<string, unknown>>(sql, ordered);
      } catch (e) {
        throw unwrapSynapseError(e);
      }
      const wrapped = row?.[proc.name.toUpperCase()];
      if (wrapped === null || wrapped === undefined) return wrapped as never;
      if (typeof wrapped === 'string') {
        try {
          return JSON.parse(wrapped) as never;
        } catch {
          return wrapped as never;
        }
      }
      return wrapped as never;
    };
  }
  return result as Runtime<P>;
}

/**
 * Parse the SynapseError signature out of a Snowflake OperationFailedError.
 * When a JS proc calls `fail(code, msg)` inside, snowflake-sdk wraps the
 * throw in an error whose message begins with:
 *
 *   JavaScript execution error: Uncaught SynapseError: <CODE>: <msg>
 *
 * followed by a stack trace. We regex the CODE + msg back out and re-throw as
 * a proper SynapseError so client tests can assert on `.code`. Non-Synapse
 * errors pass through unchanged.
 */
function unwrapSynapseError(e: unknown): unknown {
  if (!(e instanceof Error)) return e;
  // Framework-side, verbs `throw new SynapseError(code, msg)`. The Snowflake
  // JS runtime wraps this so the client sees a message that includes a line
  // like "Uncaught SynapseError: <CODE>: <msg>" somewhere. Find the marker,
  // take the rest of that line, then split on the first colon-space to
  // recover the code + message. No regex — the parse is O(n) linear scans.
  const marker = 'Uncaught SynapseError:';
  const idx = e.message.indexOf(marker);
  if (idx < 0) return e;
  const rest = e.message.slice(idx + marker.length).split('\n', 1)[0]!.trim();
  const sep = rest.indexOf(': ');
  if (sep <= 0) return e;
  const code = rest.slice(0, sep);
  const msg = rest.slice(sep + 2).trim();
  // Guard: code should be an ALL_CAPS identifier.
  for (const ch of code) {
    const isUpper = ch >= 'A' && ch <= 'Z';
    const isDigit = ch >= '0' && ch <= '9';
    const isUnderscore = ch === '_';
    if (!isUpper && !isDigit && !isUnderscore) return e;
  }
  return new SynapseError(code, msg);
}

/**
 * Convert a TS-side argument value to the bind form. ARRAY and OBJECT both
 * get JSON-stringified -- the call-site placeholder is `PARSE_JSON(?)` for
 * those, so Snowflake parses on the way in. Primitives pass through.
 */
function serializeForCall(value: unknown, schema: Schema<unknown>): unknown {
  if (value === null || value === undefined) return null;
  const kind = unwrapKind(schema);
  if (kind === 'array' || kind === 'object') {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  }
  return value;
}

function unwrapKind(schema: Schema<unknown>): string {
  let s: Schema<unknown> | undefined = schema;
  while (s && s.kind === 'nullable') s = s.inner;
  return s?.kind ?? 'string';
}
