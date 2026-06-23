import type { ProcDef } from '../defineProc.js';
/**
 * Drives the shared envelope synchronously in a sproc body. The bundler swaps
 * TypeScript's `__awaiter` for a synchronous generator driver, so the
 * `Promise<...>` return from `runEnvelope` resolves to its inner value at the
 * call site.
 */
export declare function runProcSproc<TArgs, TReturns>(proc: ProcDef<string, TArgs, TReturns>, args: unknown, idempotencyKey: string | null): TReturns | {
    replayed: true;
    result_hash: string | null;
};
//# sourceMappingURL=sproc.d.ts.map