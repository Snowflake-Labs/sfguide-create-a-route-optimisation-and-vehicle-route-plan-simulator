import type { Conn } from '../connector.js';
import type { AuditSink, AuditEvent, Identity } from '../audit.js';
import type { ProcDef, ProcContext } from '../defineProc.js';
import type { Schema } from '../schema.js';
import { fail, SynapseError } from '../errors.js';

/**
 * The shared envelope: validate args -> identity -> checkReplay -> validate hook
 *                  -> execute -> validate returns -> auditOk
 *               (or auditError on throw, with the error rethrown).
 *
 * Used by both the local runtime (`createSynapseRuntime` in this directory)
 * and the sproc runtime (`runProcSproc` in `./sproc.ts`). The only difference
 * between targets is the `Conn` (async snowflake-sdk wrapper vs sync
 * `snowflake.execute` shim) and how the result is delivered (Promise vs sync
 * value via the bundler's syncRun driver).
 */

function parseRecord<R extends Record<string, unknown>>(
  shape: { [K in keyof R]: Schema<R[K]> },
  value: unknown,
  what: 'args' | 'returns',
): R {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('BAD_VALUE_TYPE', `${what} not an object: ${typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    out[key] = (shape[key as keyof typeof shape] as Schema<unknown>).parse(obj[key], `${what}.${key}`);
  }
  return out as R;
}

function buildEvent(opts: {
  proc: ProcDef<string, any, any>;
  ident: Identity;
  args: unknown;
  idemKey: string | null;
  outcome: 'ok' | 'error';
  errorCode: string | null;
  errorMessage: string | null;
  result: unknown;
}): AuditEvent {
  return {
    verb: opts.proc.name,
    actor: opts.ident.user,
    actor_role: opts.ident.role,
    args: opts.args,
    outcome: opts.outcome,
    idempotency_key: opts.idemKey,
    app_id: null,
    error_code: opts.errorCode,
    error_message: opts.errorMessage,
    result: opts.result,
    replayed_from: null,
  };
}

export async function runEnvelope<TArgs, TReturns>(
  proc: ProcDef<string, TArgs, TReturns>,
  rawArgs: unknown,
  idempotencyKey: string | null,
  conn: Conn,
  audit: AuditSink,
): Promise<TReturns | { replayed: true; result_hash: string | null }> {
  const parsedArgs = parseRecord(
    proc.args as { [K in keyof TArgs]: Schema<TArgs[K]> } as Record<string, Schema<unknown>>,
    rawArgs,
    'args',
  ) as TArgs;

  const ident = await audit.identity(conn);
  const ctx: ProcContext = { conn, identity: ident, fail };

  try {
    const replay = await audit.checkReplay(conn, ident, proc.name, idempotencyKey, parsedArgs);
    if (replay) {
      if (replay.outcome === 'error') {
        throw new SynapseError(
          replay.error_code ?? 'UNKNOWN',
          replay.error_message ?? '',
        );
      }
      return { replayed: true, result_hash: replay.result_hash };
    }

    if (proc.validate) await proc.validate(parsedArgs, ctx);
    const rawResult = await proc.execute(parsedArgs, ctx);
    const parsedResult = parseRecord(
      proc.returns as { [K in keyof TReturns]: Schema<TReturns[K]> } as Record<string, Schema<unknown>>,
      rawResult,
      'returns',
    ) as TReturns;

    await audit.recordOk(conn, buildEvent({
      proc, ident, args: parsedArgs, idemKey: idempotencyKey,
      outcome: 'ok', errorCode: null, errorMessage: null, result: parsedResult,
    }));
    return parsedResult;
  } catch (err) {
    const e = err instanceof SynapseError
      ? err
      : new SynapseError('UNKNOWN', err instanceof Error ? err.message : String(err));
    await audit.recordError(conn, buildEvent({
      proc, ident, args: parsedArgs, idemKey: idempotencyKey,
      outcome: 'error', errorCode: e.code, errorMessage: e.message, result: null,
    }));
    throw e;
  }
}
