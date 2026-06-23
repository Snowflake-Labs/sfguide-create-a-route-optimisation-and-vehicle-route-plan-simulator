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
function parseRecord(shape, value, what) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail('BAD_VALUE_TYPE', `${what} not an object: ${typeof value}`);
    }
    const obj = value;
    const out = {};
    for (const key of Object.keys(shape)) {
        out[key] = shape[key].parse(obj[key], `${what}.${key}`);
    }
    return out;
}
function buildEvent(opts) {
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
export async function runEnvelope(proc, rawArgs, idempotencyKey, conn, audit) {
    const parsedArgs = parseRecord(proc.args, rawArgs, 'args');
    const ident = await audit.identity(conn);
    const ctx = { conn, identity: ident, fail };
    try {
        const replay = await audit.checkReplay(conn, ident, proc.name, idempotencyKey, parsedArgs);
        if (replay) {
            if (replay.outcome === 'error') {
                throw new SynapseError(replay.error_code ?? 'UNKNOWN', replay.error_message ?? '');
            }
            return { replayed: true, result_hash: replay.result_hash };
        }
        if (proc.validate)
            await proc.validate(parsedArgs, ctx);
        const rawResult = await proc.execute(parsedArgs, ctx);
        const parsedResult = parseRecord(proc.returns, rawResult, 'returns');
        await audit.recordOk(conn, buildEvent({
            proc, ident, args: parsedArgs, idemKey: idempotencyKey,
            outcome: 'ok', errorCode: null, errorMessage: null, result: parsedResult,
        }));
        return parsedResult;
    }
    catch (err) {
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
//# sourceMappingURL=envelope.js.map